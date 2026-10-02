import { describe, expect, test } from "bun:test"
import { parseBacklog } from "../service/backlog"
import { archivePath, archiveSession } from "../service/archive"
import type { ExecRunner } from "../service/control-client"
import type { FileSystemPort } from "../service/file-system"
import type { HttpFetcher, InterruptSupport } from "../service/interrupt"
import { createSupervisionPoller } from "../service/poller"
import { InMemoryFileSystem } from "./helpers/in-memory-file-system"

const homeRoot = "/home/firstmate"
const projectDirectory = "/repos/sunrise"

// The control client builds the attested CLI argv — `openchamber session
// <subcommand> --session <id> --dir <path> ...` — so the fakes dispatch on
// that layout: the subcommand sits at args[1] behind "session", and the
// session id follows "--session". A guard assertion in the first test pins
// the exact argv so a layout change fails loudly here instead of silently
// shunting status calls into the messages fallback.
function subcommand(args: readonly string[]): string {
  return args[0] === "session" ? (args[1] ?? "") : ""
}

function sessionArg(args: readonly string[]): string | undefined {
  const index = args.indexOf("--session")
  return index === -1 ? undefined : args[index + 1]
}

function seedRegistry(filesystem: InMemoryFileSystem, overrides: Record<string, unknown> = {}): void {
  filesystem.seedFile(
    `${homeRoot}/registry.json`,
    JSON.stringify({
      sunrise: {
        slug: "sunrise",
        projectDirectory,
        homeDirectory: `${homeRoot}/projects/sunrise`,
        coordinatorSessionId: "ses_coord_1",
        createdAt: "2026-10-01T08:00:00Z",
        ...overrides,
      },
    }),
  )
}

function seedBacklog(filesystem: InMemoryFileSystem, markdown: string): void {
  filesystem.seedFile(`${homeRoot}/projects/sunrise/backlog.md`, markdown)
}

function scriptExec(script: (args: readonly string[]) => string): { exec: ExecRunner; calls: string[][] } {
  const calls: string[][] = []
  const exec: ExecRunner = async (_command, args) => {
    calls.push([...args])
    return script(args)
  }
  return { exec, calls }
}

function statusExec(activity: string, outcome: string | null = null): { exec: ExecRunner; calls: string[][] } {
  return scriptExec((args) =>
    subcommand(args) === "status" ? JSON.stringify({ type: activity, outcome }) : '{"text":"the last word"}',
  )
}

const noopFetcher: HttpFetcher = async () => ({ status: 200 })
const supported = { kind: "supported", port: 4096 } as const

function makePoller(input: {
  filesystem: FileSystemPort
  exec: ExecRunner
  fetcher?: HttpFetcher
  resolveSupport?: () => Promise<InterruptSupport>
}): ReturnType<typeof createSupervisionPoller> {
  return createSupervisionPoller({
    homeRoot,
    fetcher: noopFetcher,
    resolveSupport: async () => supported,
    ...input,
  })
}

interface RecordedCall {
  url: string
  init: { method: string; body?: string }
}

function recordingFetcher(answer: () => { status: number } | "throw"): { fetcher: HttpFetcher; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const fetcher: HttpFetcher = async (url, init) => {
    calls.push({ url, init })
    const result = answer()
    if (result === "throw") throw new Error("connection refused")
    return { status: result.status }
  }
  return { fetcher, calls }
}

describe("createSupervisionPoller", () => {
  test("polls each backlog worker with a session id and forwards one message per project per round", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    seedBacklog(
      filesystem,
      [
        "- Fix flaky login test",
        "  state: Working",
        "  session: ses_11bb",
        "",
        "- Add dark mode",
        "  state: Working",
        "  session: ses_22cc",
        "",
        "- Uncalled task",
        "  state: Queued",
        "",
      ].join("\n"),
    )
    const { exec, calls } = statusExec("waiting-question")

    const poller = makePoller({ filesystem: filesystem.port, exec })
    const round = await poller.poll()

    // Guard, in the style of the control-client argv tests: the first status
    // call must use the attested CLI form (scriptExec records the args array).
    expect(calls[0]).toEqual(["session", "status", "--session", "ses_11bb", "--dir", projectDirectory, "--json"])
    const statusCalls = calls.filter((args) => subcommand(args) === "status")
    expect(statusCalls).toHaveLength(2)
    expect(statusCalls.map((args) => sessionArg(args))).toEqual(["ses_11bb", "ses_22cc"])
    expect(round.notifications).toHaveLength(1)
    const notification = round.notifications[0]
    expect(notification.slug).toBe("sunrise")
    expect(notification.coordinatorSessionId).toBe("ses_coord_1")
    expect(notification.homeDirectory).toBe(`${homeRoot}/projects/sunrise`)
    expect(notification.message).toContain('"Fix flaky login test"')
    expect(notification.message).toContain('"Add dark mode"')
    expect(notification.message).toContain("waiting on a question")
  })

  test("detects a finished worker and says completed never means Done", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    seedBacklog(filesystem, ["- Fix flaky login test", "  state: Working", "  session: ses_11bb"].join("\n"))
    const { exec } = scriptExec((args) =>
      subcommand(args) === "status" ? '{"type":"idle","outcome":"completed"}' : '{"text":"done, pushed"}',
    )

    const poller = makePoller({ filesystem: filesystem.port, exec })
    const round = await poller.poll()

    expect(round.notifications[0].message).toContain("finished")
    expect(round.notifications[0].message).toContain("Done")
  })

  test("a running→idle transition emits exactly one finished event", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    seedBacklog(filesystem, ["- Fix flaky login test", "  state: Working", "  session: ses_11bb"].join("\n"))
    let type = "busy"
    const { exec } = scriptExec((args) =>
      subcommand(args) === "status" ? JSON.stringify({ status: "ok", sessionStatus: { type } }) : '{"text":"the last word"}',
    )

    const poller = makePoller({ filesystem: filesystem.port, exec })
    const runningRound = await poller.poll()
    expect(runningRound.notifications).toEqual([])

    type = "idle"
    const idleRound = await poller.poll()

    expect(idleRound.notifications).toHaveLength(1)
    const message = idleRound.notifications[0].message
    expect(message).toContain("finished its turn")
    expect(message.split("finished its turn")).toHaveLength(2)
  })

  test("a first-sight idle worker reports finished exactly once, then stays quiet", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    seedBacklog(filesystem, ["- Fix flaky login test", "  state: Working", "  session: ses_11bb"].join("\n"))
    const { exec } = statusExec("idle")

    const poller = makePoller({ filesystem: filesystem.port, exec })
    const firstRound = await poller.poll()
    const secondRound = await poller.poll()

    expect(firstRound.notifications).toHaveLength(1)
    expect(firstRound.notifications[0].message.split("finished its turn")).toHaveLength(2)
    expect(secondRound.notifications).toEqual([])
  })

  test("a first-sight idle worker on a Queued task reports nothing", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    seedBacklog(filesystem, ["- Fix flaky login test", "  state: Queued", "  session: ses_11bb"].join("\n"))
    const { exec } = statusExec("idle")

    const poller = makePoller({ filesystem: filesystem.port, exec })
    const firstRound = await poller.poll()

    expect(firstRound.notifications).toEqual([])
  })

  test("a first-sight running observation stays quiet until the idle transition", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    seedBacklog(filesystem, ["- Fix flaky login test", "  state: Working", "  session: ses_11bb"].join("\n"))
    let type = "running"
    const { exec } = scriptExec((args) =>
      subcommand(args) === "status" ? JSON.stringify({ type }) : '{"text":"the last word"}',
    )

    const poller = makePoller({ filesystem: filesystem.port, exec })
    const runningRound = await poller.poll()
    expect(runningRound.notifications).toEqual([])

    type = "idle"
    const idleRound = await poller.poll()
    expect(idleRound.notifications).toHaveLength(1)
    expect(idleRound.notifications[0].message).toContain("finished its turn")
  })

  test("a running→idle transition alongside a completed outcome does not double-emit", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    seedBacklog(filesystem, ["- Fix flaky login test", "  state: Working", "  session: ses_11bb"].join("\n"))
    let poll = 0
    const { exec } = scriptExec((args) =>
      subcommand(args) === "status" ? (poll++ === 0 ? '{"type":"running"}' : '{"type":"idle","outcome":"completed"}') : '{"text":"the last word"}',
    )

    const poller = makePoller({ filesystem: filesystem.port, exec })
    await poller.poll()

    const round = await poller.poll()
    expect(round.notifications).toHaveLength(1)
    const message = round.notifications[0].message
    expect(message).toContain("finished its turn")
    expect(message.split("finished its turn")).toHaveLength(2)
  })

  test("detects a failed worker", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    seedBacklog(filesystem, ["- Fix flaky login test", "  state: Working", "  session: ses_11bb"].join("\n"))
    const { exec } = scriptExec((args) =>
      subcommand(args) === "status" ? '{"type":"idle","outcome":"failed"}' : '{"text":"tests went red"}',
    )

    const poller = makePoller({ filesystem: filesystem.port, exec })
    const round = await poller.poll()

    expect(round.notifications[0].message).toContain("failed")
  })

  test("a waiting-permission worker is reported as waiting on a permission", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    seedBacklog(filesystem, ["- Fix flaky login test", "  state: Working", "  session: ses_11bb"].join("\n"))
    const { exec } = statusExec("waiting-permission")

    const poller = makePoller({ filesystem: filesystem.port, exec })
    const round = await poller.poll()

    expect(round.notifications[0].message).toContain("waiting on a permission")
    expect(round.notifications[0].message).toContain("auto-approves")
  })

  test("a transition is reported once, not again on the next poll", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    seedBacklog(filesystem, ["- Fix flaky login test", "  state: Working", "  session: ses_11bb"].join("\n"))
    const { exec } = statusExec("waiting-question")

    const poller = makePoller({ filesystem: filesystem.port, exec })
    const firstRound = await poller.poll()
    const secondRound = await poller.poll()

    expect(firstRound.notifications).toHaveLength(1)
    expect(secondRound.notifications).toHaveLength(0)
  })

  test("a worker whose status fetch fails records the error and keeps the previous observation", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    seedBacklog(filesystem, ["- Fix flaky login test", "  state: Working", "  session: ses_11bb"].join("\n"))
    let failStatus = true
    const exec: ExecRunner = async (_command, args) => {
      if (subcommand(args) === "status" && failStatus) throw new Error("openchamber exited with code 1: no such session")
      return subcommand(args) === "status" ? '{"type":"waiting-question"}' : '{"text":"word"}'
    }

    const poller = makePoller({ filesystem: filesystem.port, exec })
    await poller.poll()

    const tasks = [{ title: "Fix flaky login test", state: "Working" as const, sessionId: "ses_11bb" }]
    const workers = poller.getBoardWorkers("sunrise", tasks)
    expect(workers[0].lastPollError).toContain("no such session")

    // The failed round never saw a status, so the later success is the first
    // observation and still reports the transition.
    failStatus = false
    const round = await poller.poll()
    expect(round.notifications).toHaveLength(1)
  })

  test("the board carries the backlog fields, refined state, last word, and poll errors", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    seedBacklog(
      filesystem,
      [
        "- Fix flaky login test",
        "  state: Working",
        "  session: ses_11bb",
        "  worktree: /repos/sunrise/.worktrees/fm/login-fix",
        "  branch: fm/login-fix",
        "  pr: https://github.com/example/sunrise/pull/11",
        "",
        "- Queued task",
        "  state: Queued",
        "",
      ].join("\n"),
    )
    const { exec } = statusExec("waiting-question")

    const poller = makePoller({ filesystem: filesystem.port, exec })
    await poller.poll()

    const backlog = filesystem.fileContents(`${homeRoot}/projects/sunrise/backlog.md`)
    const workers = poller.getBoardWorkers("sunrise", parseBacklog(backlog).tasks)
    expect(workers).toEqual([
      {
        title: "Fix flaky login test",
        state: "Blocked",
        blockedReason: "question",
        lastWord: "the last word",
        prUrl: "https://github.com/example/sunrise/pull/11",
        sessionId: "ses_11bb",
        worktree: "/repos/sunrise/.worktrees/fm/login-fix",
        branch: "fm/login-fix",
      },
      { title: "Queued task", state: "Queued" },
    ])
  })

  test("a project whose backlog is unreadable produces no notification that round", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    const { exec } = statusExec("waiting-question")

    const poller = makePoller({ filesystem: filesystem.port, exec })
    const round = await poller.poll()

    expect(round.notifications).toEqual([])
  })

  test("an archived worker is neither polled nor reported", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    seedBacklog(
      filesystem,
      [
        "- Fix flaky login test",
        "  state: Working",
        "  session: ses_11bb",
        "",
        "- Still on duty",
        "  state: Working",
        "  session: ses_22cc",
      ].join("\n"),
    )
    await archiveSession(filesystem.port, homeRoot, "sunrise", {
      sessionId: "ses_11bb",
      title: "Fix flaky login test",
      archivedAt: "2026-10-01T09:00:00.000Z",
    })
    const { exec, calls } = statusExec("waiting-question")

    const poller = makePoller({ filesystem: filesystem.port, exec })
    const round = await poller.poll()

    const statusCalls = calls.filter((args) => subcommand(args) === "status")
    expect(statusCalls.map((args) => sessionArg(args))).toEqual(["ses_22cc"])
    expect(round.notifications).toHaveLength(1)
    expect(round.notifications[0].message).not.toContain("Fix flaky login test")
  })

  test("an unreadable archive skips the project's round instead of resuming supervision", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    seedBacklog(filesystem, ["- Fix flaky login test", "  state: Working", "  session: ses_11bb"].join("\n"))
    await archiveSession(filesystem.port, homeRoot, "sunrise", {
      sessionId: "ses_11bb",
      title: "Fix flaky login test",
      archivedAt: "2026-10-01T09:00:00.000Z",
    })
    // exists() still answers true, so the read itself is what fails.
    const brokenPort: FileSystemPort = {
      ...filesystem.port,
      readFile: async (filePath) => {
        if (filePath === archivePath(homeRoot, "sunrise")) throw new Error("disk gone")
        return filesystem.port.readFile(filePath)
      },
    }
    const { exec, calls } = statusExec("waiting-question")

    const poller = makePoller({ filesystem: brokenPort, exec })
    const round = await poller.poll()

    expect(calls.filter((args) => subcommand(args) === "status")).toEqual([])
    expect(round.notifications).toEqual([])
  })

  test("a steered worker's new last word is forwarded to the coordinator once", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    seedBacklog(filesystem, ["- Fix flaky login test", "  state: Working", "  session: ses_11bb"].join("\n"))
    let lastWord = "stuck on the flake"
    const { exec } = scriptExec((args) =>
      subcommand(args) === "status" ? '{"type":"idle"}' : `{"text":"${lastWord}"}`,
    )
    const poller = makePoller({ filesystem: filesystem.port, exec })

    await poller.poll() // baseline: the last word the captain steered against
    poller.markSteered("sunrise", "ses_11bb")

    const unchanged = await poller.poll()
    expect(unchanged.notifications).toEqual([])

    lastWord = "flake fixed, tests green"
    const answered = await poller.poll()
    expect(answered.notifications).toHaveLength(1)
    expect(answered.notifications[0].message).toContain("answered the captain's steer")
    expect(answered.notifications[0].message).toContain("flake fixed, tests green")

    // One forward per steer: the mark is cleared.
    const afterAnswer = await poller.poll()
    expect(afterAnswer.notifications).toEqual([])
  })

  test("a steer with no new assistant message forwards nothing", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    seedBacklog(filesystem, ["- Fix flaky login test", "  state: Working", "  session: ses_11bb"].join("\n"))
    const { exec } = scriptExec((args) =>
      subcommand(args) === "status" ? '{"type":"idle"}' : '{"text":"stuck on the flake"}',
    )
    const poller = makePoller({ filesystem: filesystem.port, exec })

    await poller.poll()
    poller.markSteered("sunrise", "ses_11bb")

    const first = await poller.poll()
    const second = await poller.poll()
    expect(first.notifications).toEqual([])
    expect(second.notifications).toEqual([])
  })

  test("a second steer re-arms answer-forwarding", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    seedBacklog(filesystem, ["- Fix flaky login test", "  state: Working", "  session: ses_11bb"].join("\n"))
    let lastWord = "stuck on the flake"
    const { exec } = scriptExec((args) =>
      subcommand(args) === "status" ? '{"type":"idle"}' : `{"text":"${lastWord}"}`,
    )
    const poller = makePoller({ filesystem: filesystem.port, exec })

    await poller.poll()
    poller.markSteered("sunrise", "ses_11bb")
    lastWord = "first answer"
    await poller.poll() // forwards once, mark cleared

    poller.markSteered("sunrise", "ses_11bb") // re-arms against "first answer"
    const unchanged = await poller.poll()
    expect(unchanged.notifications).toEqual([])

    lastWord = "second answer"
    const reAnswered = await poller.poll()
    expect(reAnswered.notifications).toHaveLength(1)
    expect(reAnswered.notifications[0].message).toContain("second answer")
  })

  test("a worker session is set to auto-accept permissions on first sight, once", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    seedBacklog(filesystem, ["- Fix flaky login test", "  state: Working", "  session: ses_11bb"].join("\n"))
    const { exec } = statusExec("waiting-permission")
    const { fetcher, calls } = recordingFetcher(() => ({ status: 200 }))

    const poller = makePoller({
      filesystem: filesystem.port,
      exec,
      fetcher,
      resolveSupport: async () => ({ kind: "supported", port: 4096, token: "tok_local" }),
    })
    await poller.poll()
    await poller.poll()

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://127.0.0.1:4096/api/permission-auto-accept/sessions/ses_11bb")
    expect(calls[0].init.method).toBe("PUT")
    expect(calls[0].init.body).toBe(JSON.stringify({ mode: "auto", directory: projectDirectory }))
  })

  test("a failed auto-accept is retried on the next poll and marked on success", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    seedBacklog(filesystem, ["- Fix flaky login test", "  state: Working", "  session: ses_11bb"].join("\n"))
    const { exec } = statusExec("waiting-permission")
    let attempts = 0
    const { fetcher, calls } = recordingFetcher(() => {
      attempts += 1
      return attempts === 1 ? "throw" : { status: 200 }
    })

    const poller = makePoller({ filesystem: filesystem.port, exec, fetcher })
    const round = await poller.poll()
    await poller.poll()
    await poller.poll()

    // The failed attempt left the session unmarked, so the next round retried
    // and the successful retry marked it; the third round made no call. The
    // round's own transitions were reported throughout.
    expect(round.notifications).toHaveLength(1)
    expect(calls).toHaveLength(2)
  })

  test("an unsupported auto-accept is not retried", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    seedBacklog(filesystem, ["- Fix flaky login test", "  state: Working", "  session: ses_11bb"].join("\n"))
    const { exec } = statusExec("waiting-permission")
    const { fetcher, calls } = recordingFetcher(() => ({ status: 401 }))

    const poller = makePoller({ filesystem: filesystem.port, exec, fetcher })
    await poller.poll()
    await poller.poll()

    expect(calls).toHaveLength(1)
  })
})
