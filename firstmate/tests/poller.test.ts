import { describe, expect, test } from "bun:test"
import { parseBacklog } from "../service/backlog"
import type { ExecRunner } from "../service/control-client"
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

    const poller = createSupervisionPoller({ filesystem: filesystem.port, exec, homeRoot })
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

    const poller = createSupervisionPoller({ filesystem: filesystem.port, exec, homeRoot })
    const round = await poller.poll()

    expect(round.notifications[0].message).toContain("finished")
    expect(round.notifications[0].message).toContain("Done")
  })

  test("detects a failed worker", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    seedBacklog(filesystem, ["- Fix flaky login test", "  state: Working", "  session: ses_11bb"].join("\n"))
    const { exec } = scriptExec((args) =>
      subcommand(args) === "status" ? '{"type":"idle","outcome":"failed"}' : '{"text":"tests went red"}',
    )

    const poller = createSupervisionPoller({ filesystem: filesystem.port, exec, homeRoot })
    const round = await poller.poll()

    expect(round.notifications[0].message).toContain("failed")
  })

  test("a waiting-permission worker is reported as waiting on a permission", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    seedBacklog(filesystem, ["- Fix flaky login test", "  state: Working", "  session: ses_11bb"].join("\n"))
    const { exec } = statusExec("waiting-permission")

    const poller = createSupervisionPoller({ filesystem: filesystem.port, exec, homeRoot })
    const round = await poller.poll()

    expect(round.notifications[0].message).toContain("waiting on a permission")
  })

  test("a transition is reported once, not again on the next poll", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    seedBacklog(filesystem, ["- Fix flaky login test", "  state: Working", "  session: ses_11bb"].join("\n"))
    const { exec } = statusExec("waiting-question")

    const poller = createSupervisionPoller({ filesystem: filesystem.port, exec, homeRoot })
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

    const poller = createSupervisionPoller({ filesystem: filesystem.port, exec, homeRoot })
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

    const poller = createSupervisionPoller({ filesystem: filesystem.port, exec, homeRoot })
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

    const poller = createSupervisionPoller({ filesystem: filesystem.port, exec, homeRoot })
    const round = await poller.poll()

    expect(round.notifications).toEqual([])
  })
})
