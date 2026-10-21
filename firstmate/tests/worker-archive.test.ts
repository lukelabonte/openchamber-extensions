import { describe, expect, test } from "bun:test"
import { archivePath, loadArchivedSessionIds } from "../service/archive"
import { formatBacklogEntry, parseBacklog, type BacklogTask } from "../service/backlog"
import type { ExecRunner } from "../service/control-client"
import type { HttpFetcher } from "../service/interrupt"
import { archiveFinishedWorker } from "../service/worker-archive"
import { InMemoryFileSystem } from "./helpers/in-memory-file-system"

const homeRoot = "/home/firstmate"
const task: BacklogTask = {
  title: "Inspect login", id: "inspect-login", kind: "scout", state: "Done",
  sessionId: "ses_worker", worktreeDirectory: "/repos/app/worktrees/scout",
  archiveSessionId: "ses_worker",
}

function fixture(overrides: Partial<BacklogTask> = {}) {
  const filesystem = new InMemoryFileSystem()
  const currentTask = { ...task, ...overrides }
  filesystem.seedFile(`${homeRoot}/registry.json`, JSON.stringify({ app: {
    slug: "app", projectDirectory: "/repos/app", homeDirectory: `${homeRoot}/projects/app`,
    coordinatorSessionId: "ses_coordinator", createdAt: "2026-10-01T08:00:00Z",
  } }))
  filesystem.seedFile(`${homeRoot}/projects/app/backlog.md`, formatBacklogEntry(currentTask))
  filesystem.seedFile(`${homeRoot}/projects/app/reports/inspect-login.md`, "Checked findings, worker message and session references retained.")
  const requests: { url: string; body?: string }[] = []
  let activity = "idle"
  let responseBody = JSON.stringify({ archived: [{ id: "ses_worker", archivedAt: 1700 }], failedIds: [] })
  let responseStatus = 200
  const execCalls: string[][] = []
  const exec: ExecRunner = async (_command, args) => {
    execCalls.push([...args])
    return JSON.stringify({ sessionId: "ses_worker", sessionStatus: { type: activity } })
  }
  const fetcher: HttpFetcher = async (url, init) => {
    requests.push({ url, body: init.body })
    if (url.includes("/api/session/")) return { status: 200, text: async () => JSON.stringify({ id: "ses_worker", time: { idle: 1600 } }) }
    return { status: responseStatus, text: async () => responseBody }
  }
  const input = {
    filesystem: filesystem.port, exec, fetcher, homeRoot, slug: "app", sessionId: "ses_worker",
    support: { kind: "supported", port: 4096 } as const,
    blockingState: "clear" as "clear" | "waiting" | "unknown",
    nowMs: () => 1700,
  }
  return {
    filesystem, requests, execCalls, input,
    setActivity(value: string) { activity = value },
    setResponse(body: unknown, status = 200) { responseBody = JSON.stringify(body); responseStatus = status },
  }
}

describe("coordinator-requested worker archive", () => {
  test("round-trips an explicit, session-specific request", () => {
    expect(parseBacklog(formatBacklogEntry(task))).toEqual({ tasks: [task], errors: [] })
    expect(parseBacklog("- Scout\n  state: Done\n  archive-session: ").errors).toHaveLength(1)
  })

  test("archives the exact idle worker, then records durable retirement without changing its backlog or report", async () => {
    const { filesystem, requests, execCalls, input } = fixture()
    const backlogBefore = filesystem.fileContents(`${homeRoot}/projects/app/backlog.md`)
    expect(await archiveFinishedWorker(input)).toEqual({ kind: "archived" })
    expect(execCalls).toEqual([["session", "status", "--session", "ses_worker", "--dir", task.worktreeDirectory!, "--json"]])
    expect(requests.at(-1)).toEqual({ url: "http://127.0.0.1:4096/api/openchamber/sessions/archive", body: '{"ids":["ses_worker"]}' })
    expect(await loadArchivedSessionIds(filesystem.port, homeRoot, "app")).toEqual(new Set(["ses_worker"]))
    expect(filesystem.fileContents(`${homeRoot}/projects/app/backlog.md`)).toBe(backlogBefore)
    expect(filesystem.fileContents(`${homeRoot}/projects/app/reports/inspect-login.md`)).toContain("references retained")
    const callsBefore = requests.length
    expect(await archiveFinishedWorker(input)).toEqual({ kind: "already-archived" })
    expect(requests).toHaveLength(callsBefore)
  })

  const refusedOverrides: Partial<BacklogTask>[] = [
    { archiveSessionId: undefined }, { archiveSessionId: "ses_previous" },
    { state: "Working" as const }, { state: "Failed" as const },
    { hold: "captain approval" }, { blockedBy: "another-task" },
    { actions: [{ label: "Decide", text: "Keep waiting" }] },
    { id: undefined }, { kind: "captain" as const },
  ]
  test.each(refusedOverrides)("refuses incomplete or ambiguous authorization: %j", async (overrides) => {
    const { input, requests } = fixture(overrides)
    expect((await archiveFinishedWorker(input)).kind).toBe("refused")
    expect(requests).toHaveLength(0)
  })

  test.each(["running", "retrying", "waiting-permission", "waiting-question", "unknown"])("leaves a %s worker untouched", async (activity) => {
    const { input, requests, setActivity } = fixture()
    setActivity(activity)
    expect((await archiveFinishedWorker(input)).kind).toBe("refused")
    expect(requests.some((request) => request.url.endsWith("/archive"))).toBe(false)
  })

  test.each(["waiting", "unknown"] as const)("fails closed on %s blocking state", async (blockingState) => {
    const { input, requests } = fixture()
    expect((await archiveFinishedWorker({ ...input, blockingState })).kind).toBe("refused")
    expect(requests).toHaveLength(0)
  })

  test("refuses a coordinator even when recorded as a worker", async () => {
    const { input, filesystem, requests } = fixture({ sessionId: "ses_coordinator", archiveSessionId: "ses_coordinator" })
    expect((await archiveFinishedWorker({ ...input, sessionId: "ses_coordinator" })).kind).toBe("refused")
    expect(requests).toHaveLength(0)
    expect(await filesystem.port.exists(archivePath(homeRoot, "app"))).toBe(false)
  })

  test("refuses an unrecorded session or duplicate worker ownership", async () => {
    const { input, filesystem, requests } = fixture()
    expect((await archiveFinishedWorker({ ...input, sessionId: "ses_unrelated" })).kind).toBe("refused")
    filesystem.seedFile(`${homeRoot}/projects/app/backlog.md`, `${formatBacklogEntry(task)}\n- Another task\n  state: Working\n  session: ses_worker`)
    expect((await archiveFinishedWorker(input)).kind).toBe("refused")
    expect(requests).toHaveLength(0)
  })

  test("requires a saved nonempty report", async () => {
    const { input, filesystem, requests } = fixture()
    filesystem.seedFile(`${homeRoot}/projects/app/reports/inspect-login.md`, "  \n")
    expect((await archiveFinishedWorker(input)).kind).toBe("refused")
    expect(requests).toHaveLength(0)
  })

  test.each([
    {}, { archived: [], failedIds: ["ses_worker"] },
    { archived: [{ id: "ses_other", archivedAt: 1700 }], failedIds: [] },
    { archived: [{ id: "ses_worker", archivedAt: 1700 }], failedIds: ["ses_worker"] },
    { archived: [{ id: "ses_worker", archivedAt: null }], failedIds: [] },
  ])("never treats an unconfirmed 2xx response as archived: %j", async (body) => {
    const { input, filesystem, setResponse } = fixture()
    setResponse(body)
    expect((await archiveFinishedWorker(input)).kind).toBe("failed")
    expect(await filesystem.port.exists(archivePath(homeRoot, "app"))).toBe(false)
  })

  test("leaves the board record intact when the host refuses the archive", async () => {
    const { input, filesystem, setResponse } = fixture()
    setResponse({}, 403)
    expect((await archiveFinishedWorker(input)).kind).toBe("failed")
    expect(await filesystem.port.exists(archivePath(homeRoot, "app"))).toBe(false)
  })

  test("requires live session existence, not only a status lookup", async () => {
    const { input, filesystem } = fixture()
    const fetcher: HttpFetcher = async () => ({ status: 404 })
    expect((await archiveFinishedWorker({ ...input, fetcher })).kind).toBe("failed")
    expect(await filesystem.port.exists(archivePath(homeRoot, "app"))).toBe(false)
  })
})
