import { describe, expect, test } from "bun:test"
import { archiveSession } from "../service/archive"
import type { BacklogTask } from "../service/backlog"
import type { ExecRunner } from "../service/control-client"
import type { HttpFetcher } from "../service/interrupt"
import { createSupervisionPoller } from "../service/poller"
import { InMemoryFileSystem } from "./helpers/in-memory-file-system"

const homeRoot = "/home/firstmate"
const projectDirectory = "/repos/sunrise"

function worker(sessionId: string, worktreeDirectory?: string): BacklogTask {
  return { title: sessionId, state: "Working", sessionId, ...(worktreeDirectory === undefined ? {} : { worktreeDirectory }) }
}

function argument(args: readonly string[], flag: string): string {
  const index = args.indexOf(flag)
  return index === -1 ? "" : (args[index + 1] ?? "")
}

function fixture(input: {
  projects?: Record<string, BacklogTask[]>
  list: (directory: string) => string
  status?: (sessionId: string) => string
  pending?: Record<string, unknown>
  nowMs?: () => number
}) {
  const projects = input.projects ?? { sunrise: [worker("ses_a"), worker("ses_b"), worker("ses_c")] }
  const filesystem = new InMemoryFileSystem()
  filesystem.seedFile(`${homeRoot}/registry.json`, JSON.stringify(Object.fromEntries(Object.keys(projects).map((slug) => [slug, {
    slug,
    projectDirectory: `/repos/${slug}`,
    homeDirectory: `${homeRoot}/projects/${slug}`,
    coordinatorSessionId: `ses_coordinator_${slug}`,
    createdAt: "2026-10-01T08:00:00Z",
  }]))))
  for (const [slug, tasks] of Object.entries(projects)) {
    filesystem.seedFile(`${homeRoot}/projects/${slug}/backlog.md`, tasks.map((task) => [
      `- ${task.title}`,
      `  state: ${task.state}`,
      ...(task.sessionId === undefined ? [] : [`  session: ${task.sessionId}`]),
      ...(task.worktreeDirectory === undefined ? [] : [`  worktree: ${task.worktreeDirectory}`]),
    ].join("\n")).join("\n\n"))
  }
  const calls: { command: string; args: string[] }[] = []
  const exec: ExecRunner = async (command, args) => {
    calls.push({ command, args: [...args] })
    if (args[1] === "list") return input.list(argument(args, "--dir"))
    const sessionId = argument(args, "--session")
    if (args[1] === "status") return input.status?.(sessionId) ?? JSON.stringify({ sessionId, sessionStatus: { type: "busy" } })
    if (args[1] === "messages") return JSON.stringify({ sessionId, messages: [{ id: `msg_${sessionId}`, role: "assistant", text: `word ${sessionId}` }] })
    throw new Error(`unexpected command: ${command} ${args.join(" ")}`)
  }
  const httpCalls: { url: string; method: string; body?: string }[] = []
  const fetcher: HttpFetcher = async (url, init) => {
    httpCalls.push({ url, ...init })
    const pathname = new URL(url).pathname
    const payload = pathname === "/api/sessions/status"
      ? { pending: input.pending ?? {} }
      : pathname.startsWith("/api/session/")
        ? { id: decodeURIComponent(pathname.slice("/api/session/".length)), time: {} }
        : {}
    return { status: 200, text: async () => JSON.stringify(payload) }
  }
  const poller = createSupervisionPoller({
    filesystem: filesystem.port,
    exec,
    homeRoot,
    fetcher,
    resolveSupport: async () => ({ kind: "supported", port: 4096 }),
    nowMs: input.nowMs ?? (() => 1000),
  })
  const commandCalls = (name: string) => calls.filter((call) => call.args[1] === name)
  return { filesystem, poller, projects, calls, commandCalls, httpCalls }
}

describe("poller batched worker statuses", () => {
  test("each round reloads statuses and a failed individual fallback keeps only that worker's prior observation", async () => {
    let round = 0
    const { poller, projects, commandCalls } = fixture({
      nowMs: () => (round + 1) * 1000,
      list: () => {
        if (round === 2) throw new Error("list unavailable")
        return JSON.stringify(round === 0 ? [
          { id: "ses_a", activity: "waiting-question" },
          { id: "ses_b", activity: "running" },
          { id: "ses_c", activity: "running" },
        ] : [
          { id: "ses_c", activity: "idle" },
          { id: "ses_b", activity: "waiting-permission" },
        ])
      },
      status: (sessionId) => {
        if (round === 1 && sessionId === "ses_a") throw new Error("worker status unavailable")
        return JSON.stringify({ sessionId, activity: sessionId === "ses_a" ? "idle" : "running" })
      },
    })
    await poller.poll()
    round = 1
    await poller.poll()

    const workers = poller.getBoardWorkers("sunrise", projects.sunrise)
    expect(workers[0]).toMatchObject({ state: "Blocked", blockedReason: "question", lastWord: "word ses_a", lastPollError: "worker status unavailable" })
    expect(workers[1]).toMatchObject({ state: "Blocked", blockedReason: "permission" })
    expect(workers[2]).toMatchObject({ state: "Idle" })
    expect(workers.slice(1).every((worker) => worker.lastPollError === undefined)).toBe(true)
    expect(commandCalls("list")).toHaveLength(2)
    expect(commandCalls("status").map((call) => argument(call.args, "--session"))).toEqual(["ses_a"])
    expect(commandCalls("messages")).toHaveLength(5)
    expect(poller.getSupervisionHealth("sunrise")).toMatchObject({ blockedObservation: "working", failureObservation: "working", lastSuccessfulPollAt: new Date(1000).toISOString() })

    round = 2
    await poller.poll()
    const recovered = poller.getBoardWorkers("sunrise", projects.sunrise)
    expect(recovered.map((worker) => worker.state)).toEqual(["Idle", "Working", "Working"])
    expect(recovered.every((worker) => worker.lastPollError === undefined)).toBe(true)
    expect(commandCalls("list")).toHaveLength(3)
    expect(commandCalls("status").map((call) => argument(call.args, "--session"))).toEqual(["ses_a", "ses_a", "ses_b", "ses_c"])
    expect(commandCalls("messages")).toHaveLength(8)
    expect(poller.getSupervisionHealth("sunrise").lastSuccessfulPollAt).toBe(new Date(3000).toISOString())
  })

  test("host pending requests still override batched activity", async () => {
    const { poller, projects, commandCalls } = fixture({
      list: () => JSON.stringify(["ses_a", "ses_b", "ses_c"].map((id) => ({ id, directory: projectDirectory, status: { type: "busy" } }))),
      pending: { ses_b: { forms: [{ id: "form_1" }] }, ses_c: { permissions: [{ id: "permission_1" }] } },
    })
    await poller.poll()
    expect(commandCalls("list")).toHaveLength(1)
    expect(commandCalls("status")).toEqual([])
    expect(poller.getBoardWorkers("sunrise", projects.sunrise).map((worker) => worker.blockedReason)).toEqual([undefined, "question", "permission"])
  })

  test("accepts normalized recorded worktree and project directories", async () => {
    const { poller, projects, commandCalls } = fixture({
      projects: { sunrise: [worker("ses_a", `${projectDirectory}/.worktrees/a`), worker("ses_b", `${projectDirectory}/.worktrees/b`), worker("ses_c")] },
      list: () => JSON.stringify([
        { id: "ses_a", directory: `${projectDirectory}/.worktrees/a/../a/`, status: { type: "idle" } },
        { id: "ses_b", directory: `${projectDirectory}/./`, status: { type: "idle" } },
        { id: "ses_c", status: { type: "idle" } },
      ]),
    })
    await poller.poll()
    expect(commandCalls("list")).toHaveLength(1)
    expect(commandCalls("status")).toEqual([])
    expect(poller.getBoardWorkers("sunrise", projects.sunrise).map((worker) => worker.state)).toEqual(["Idle", "Idle", "Idle"])
  })

  test.each([
    { label: "older CLI", output: undefined },
    { label: "invalid JSON", output: "not JSON" },
    { label: "error envelope", output: '{"status":"error","sessions":[]}' },
    { label: "missing sessions array", output: '{"status":"ok"}' },
    { label: "malformed row", output: '{"sessions":[{"id":"ses_a","activity":"idle"},{"id":"ses_b","directory":42}]}' },
  ])("a $label batch uses individual status reads for every worker", async ({ output }) => {
    const { poller, projects, commandCalls } = fixture({
      list: () => {
        if (output === undefined) throw new Error("unknown option --limit")
        return output
      },
      status: (sessionId) => JSON.stringify({ sessionId, activity: "waiting-question" }),
    })
    const round = await poller.poll()
    expect(commandCalls("list")).toHaveLength(1)
    expect(commandCalls("status").map((call) => argument(call.args, "--session"))).toEqual(["ses_a", "ses_b", "ses_c"])
    expect(commandCalls("messages")).toHaveLength(3)
    expect(poller.getBoardWorkers("sunrise", projects.sunrise).map((worker) => worker.state)).toEqual(["Blocked", "Blocked", "Blocked"])
    expect(round.notifications).toHaveLength(1)
    expect(poller.getSupervisionHealth("sunrise")).toMatchObject({ blockedObservation: "working", failureObservation: "working", lastSuccessfulPollAt: new Date(1000).toISOString() })
  })

  test.each([
    { label: "empty backlog", tasks: [], expected: [] },
    { label: "unassigned backlog", tasks: [{ title: "Unassigned", state: "Queued" as const }], expected: [] },
    { label: "single worker", tasks: [worker("ses_a")], expected: ["ses_a"] },
    { label: "one distinct worker", tasks: [worker("ses_a"), { ...worker("ses_a"), title: "Second record" }], expected: ["ses_a", "ses_a"] },
  ])("$label retains the individual fast path", async ({ tasks, expected }) => {
    const { poller, commandCalls } = fixture({ projects: { sunrise: [...tasks] }, list: () => "[]" })
    await poller.poll()
    expect(commandCalls("list")).toEqual([])
    expect(commandCalls("status").map((call) => argument(call.args, "--session"))).toEqual([...expected])
    expect(commandCalls("messages").map((call) => argument(call.args, "--session"))).toEqual([...expected])
  })

  test("archived workers neither count toward batching nor receive fallback or message reads", async () => {
    const { filesystem, poller, commandCalls, httpCalls } = fixture({
      projects: { sunrise: [worker("ses_a"), worker("ses_b")] },
      list: () => "[]",
    })
    await archiveSession(filesystem.port, homeRoot, "sunrise", { sessionId: "ses_a", title: "ses_a", archivedAt: "2026-10-01T09:00:00Z" })
    await poller.poll()
    expect(commandCalls("list")).toEqual([])
    expect(commandCalls("status").map((call) => argument(call.args, "--session"))).toEqual(["ses_b"])
    expect(commandCalls("messages").map((call) => argument(call.args, "--session"))).toEqual(["ses_b"])
    expect(httpCalls.some((call) => call.url.includes("ses_a"))).toBe(false)
  })

  test("an archived row in a multi-worker batch is ignored without discovering it", async () => {
    const { filesystem, poller, commandCalls, httpCalls } = fixture({
      list: () => JSON.stringify(["ses_a", "ses_b", "ses_c"].map((id) => ({ id, activity: "waiting-permission" }))),
    })
    await archiveSession(filesystem.port, homeRoot, "sunrise", { sessionId: "ses_a", title: "ses_a", archivedAt: "2026-10-01T09:00:00Z" })
    const round = await poller.poll()
    expect(commandCalls("list")).toHaveLength(1)
    expect(commandCalls("status")).toEqual([])
    expect(commandCalls("messages").map((call) => argument(call.args, "--session"))).toEqual(["ses_b", "ses_c"])
    expect(round.notifications[0].message).not.toContain("ses_a")
    expect(httpCalls.some((call) => call.url.includes("ses_a"))).toBe(false)
  })

  test("two projects each load one isolated snapshot even when a session id is shared", async () => {
    const { poller, projects, commandCalls } = fixture({
      projects: { sunrise: [worker("ses_shared"), worker("ses_a")], sunset: [worker("ses_shared"), worker("ses_b")] },
      list: (directory) => JSON.stringify(directory === projectDirectory ? [
        { id: "ses_a", activity: "idle", directory },
        { id: "ses_shared", activity: "idle", directory },
      ] : [
        { id: "ses_shared", activity: "waiting-permission", directory },
        { id: "ses_b", activity: "waiting-question", directory },
      ]),
    })
    const round = await poller.poll()
    expect(commandCalls("list").map((call) => argument(call.args, "--dir"))).toEqual([projectDirectory, "/repos/sunset"])
    expect(commandCalls("status")).toEqual([])
    expect(commandCalls("messages")).toHaveLength(4)
    expect(poller.getBoardWorkers("sunrise", projects.sunrise).map((worker) => worker.state)).toEqual(["Idle", "Idle"])
    expect(poller.getBoardWorkers("sunset", projects.sunset).map((worker) => worker.blockedReason)).toEqual(["permission", "question"])
    expect(round.notifications.map((notification) => notification.slug)).toEqual(["sunrise", "sunset"])
  })

  test("1000 installed-shape rows use one list and no individual status reads", async () => {
    const tasks = Array.from({ length: 1000 }, (_, index) => worker(`ses_${index}`))
    const { poller, commandCalls } = fixture({
      projects: { sunrise: tasks },
      list: () => JSON.stringify(tasks.map((task) => ({ id: task.sessionId, directory: projectDirectory, status: { type: "busy" } }))),
    })
    await poller.poll()
    expect(commandCalls("list")).toHaveLength(1)
    expect(argument(commandCalls("list")[0].args, "--limit")).toBe("1000")
    expect(commandCalls("status")).toEqual([])
    expect(commandCalls("messages")).toHaveLength(1000)
    expect(poller.getBoardWorkers("sunrise", tasks).at(-1)).toMatchObject({ sessionId: "ses_999", state: "Working" })
  })

  test("workers beyond the 1000-row bound use individual reads rather than disappearing", async () => {
    const tasks = Array.from({ length: 1001 }, (_, index) => worker(`ses_${index}`))
    const { poller, commandCalls } = fixture({
      projects: { sunrise: tasks },
      list: () => JSON.stringify(tasks.slice(0, 1000).map((task) => ({ id: task.sessionId, directory: projectDirectory, status: { type: "busy" } }))),
      status: (sessionId) => JSON.stringify({ sessionId, activity: "waiting-question" }),
    })
    await poller.poll()
    expect(commandCalls("list")).toHaveLength(1)
    expect(argument(commandCalls("list")[0].args, "--limit")).toBe("1000")
    expect(commandCalls("status").map((call) => argument(call.args, "--session"))).toEqual(["ses_1000"])
    expect(commandCalls("messages")).toHaveLength(1001)
    expect(poller.getBoardWorkers("sunrise", tasks).at(-1)).toMatchObject({ sessionId: "ses_1000", state: "Blocked", blockedReason: "question" })
  })

  test.each([
    { label: "missing", rows: [] },
    { label: "unknown", rows: [{ id: "ses_b", status: { type: "unknown" }, activity: "idle" }] },
    { label: "unrecognized", rows: [{ id: "ses_b", status: { type: "future-activity" }, activity: "idle" }] },
    { label: "malformed status", rows: [{ id: "ses_b", status: {}, activity: "idle" }] },
    { label: "duplicate", rows: [{ id: "ses_b", status: { type: "idle" } }, { id: "ses_b", status: { type: "idle" } }] },
    { label: "foreign directory", rows: [{ id: "ses_b", status: { type: "idle" }, directory: "/repos/sunset" }] },
  ])("$label rows fall back only for the affected worker", async ({ rows }) => {
    const { poller, projects, commandCalls } = fixture({
      list: () => JSON.stringify({ sessions: [
        { id: "ses_c", status: { type: "busy" } },
        ...rows,
        { id: "ses_a", status: { type: "idle" } },
      ] }),
      status: (sessionId) => JSON.stringify({ sessionId, activity: "waiting-permission" }),
    })
    await poller.poll()

    expect(commandCalls("list")).toHaveLength(1)
    expect(commandCalls("status").map((call) => argument(call.args, "--session"))).toEqual(["ses_b"])
    expect(commandCalls("messages")).toHaveLength(3)
    const workers = poller.getBoardWorkers("sunrise", projects.sunrise)
    expect(workers.map(({ state, blockedReason }) => ({ state, blockedReason }))).toEqual([
      { state: "Idle", blockedReason: undefined },
      { state: "Blocked", blockedReason: "permission" },
      { state: "Working", blockedReason: undefined },
    ])
    expect(workers.every((worker) => worker.lastPollError === undefined)).toBe(true)
  })

  test("three source-verified installed-shape workers use one scoped list and no status calls without adopting unrelated sessions", async () => {
    // Installed @openchamber/web server/lib/openchamber-control/service.js:850-859;
    // list rows use status.type (source-verified, not runtime-verified).
    const { poller, projects, calls, commandCalls, httpCalls } = fixture({
      list: () => JSON.stringify({ status: "ok", sessions: [
        { id: "ses_c", directory: projectDirectory, status: { type: "idle" } },
        { id: "ses_untracked", directory: projectDirectory, status: { type: "busy" } },
        { id: "ses_a", directory: projectDirectory, status: { type: "busy" } },
        { id: "ses_b", directory: projectDirectory, status: { type: "idle" } },
      ] }),
    })
    const round = await poller.poll()

    expect(commandCalls("list")).toEqual([{ command: "openchamber", args: [
      "session", "list", "--dir", projectDirectory, "--with-status", "--all", "--limit", "1000", "--json",
    ] }])
    expect(commandCalls("status")).toEqual([])
    expect(commandCalls("messages").map((call) => argument(call.args, "--session"))).toEqual(["ses_a", "ses_b", "ses_c"])
    expect(calls).toHaveLength(4)
    expect(poller.getBoardWorkers("sunrise", projects.sunrise).map(({ sessionId, state }) => ({ sessionId, state }))).toEqual([
      { sessionId: "ses_a", state: "Working" },
      { sessionId: "ses_b", state: "Idle" },
      { sessionId: "ses_c", state: "Idle" },
    ])
    expect(round.notifications).toHaveLength(1)
    expect(round.notifications[0].message).toContain('"ses_b"')
    expect(round.notifications[0].message).toContain('"ses_c"')
    expect(round.notifications[0].message).not.toContain("ses_untracked")
    expect(httpCalls.filter((call) => call.method === "PUT")).toHaveLength(3)
    expect(httpCalls.filter((call) => new URL(call.url).pathname.startsWith("/api/session/"))).toHaveLength(3)
    expect(poller.getSupervisionHealth("sunrise")).toMatchObject({ blockedObservation: "working", failureObservation: "working", lastSuccessfulPollAt: new Date(1000).toISOString() })
  })
})
