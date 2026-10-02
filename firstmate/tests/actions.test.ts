import { describe, expect, test } from "bun:test"
import type { ExecRunner } from "../service/control-client"
import { requestRelaunch, steerWorker } from "../service/actions"

// The control client builds the attested CLI argv — `openchamber session send
// --session <id> --dir <path> --prompt <text> --json` — so the fakes dispatch
// on that layout and record every call in order.
function recordingExec(script: (args: readonly string[]) => string, failArgs?: (args: readonly string[]) => boolean): {
  exec: ExecRunner
  calls: string[][]
} {
  const calls: string[][] = []
  const exec: ExecRunner = async (_command, args) => {
    calls.push([...args])
    if (failArgs?.(args)) throw new Error("openchamber exited with code 1: no such session")
    return script(args)
  }
  return { exec, calls }
}

function sends(calls: string[][]): string[][] {
  return calls.filter((args) => args[0] === "session" && args[1] === "send")
}

function field(args: readonly string[], flag: string): string | undefined {
  const index = args.indexOf(flag)
  return index === -1 ? undefined : args[index + 1]
}

const worker = { sessionId: "ses_11bb", title: "Fix flaky login test" }
const coordinator = { sessionId: "ses_coord_1", directory: "/home/firstmate/projects/sunrise" }

describe("steerWorker", () => {
  test("sends the captain's text to the worker session, then tells the coordinator", async () => {
    const { exec, calls } = recordingExec(() => '{"ok":true}')

    await steerWorker({
      exec,
      worker,
      workerDirectory: "/repos/sunrise",
      coordinator,
      text: "focus on the flake first",
    })

    expect(sends(calls)).toHaveLength(2)
    const [toWorker, toCoordinator] = sends(calls)
    expect(toWorker).toEqual([
      "session",
      "send",
      "--session",
      "ses_11bb",
      "--dir",
      "/repos/sunrise",
      "--prompt",
      "focus on the flake first",
      "--json",
    ])
    expect(field(toCoordinator, "--session")).toBe("ses_coord_1")
    expect(field(toCoordinator, "--dir")).toBe("/home/firstmate/projects/sunrise")
    const prompt = field(toCoordinator, "--prompt") ?? ""
    expect(prompt).toContain("Fix flaky login test")
    expect(prompt).toContain("focus on the flake first")
  })

  test("a failed worker send raises the error and never notifies the coordinator", async () => {
    const { exec, calls } = recordingExec(() => '{"ok":true}', (args) => field(args, "--session") === "ses_11bb")

    await expect(
      steerWorker({ exec, worker, workerDirectory: "/repos/sunrise", coordinator, text: "hello" }),
    ).rejects.toThrow("no such session")
    expect(sends(calls)).toHaveLength(1)
  })

  test("a successful steer reports that the coordinator was notified", async () => {
    const { exec } = recordingExec(() => '{"ok":true}')

    const outcome = await steerWorker({
      exec,
      worker,
      workerDirectory: "/repos/sunrise",
      coordinator,
      text: "focus on the flake first",
    })

    expect(outcome).toEqual({ coordinatorNotified: true })
  })

  test("a failed coordinator notify is reported, not raised, after the worker got the steer", async () => {
    const { exec, calls } = recordingExec(() => '{"ok":true}', (args) => field(args, "--session") === "ses_coord_1")

    const outcome = await steerWorker({ exec, worker, workerDirectory: "/repos/sunrise", coordinator, text: "hello" })

    expect(outcome).toEqual({ coordinatorNotified: false, coordinatorError: "openchamber exited with code 1: no such session" })
    // The worker was still steered — the answer can still arrive via the poller.
    expect(sends(calls)[0]).toEqual([
      "session",
      "send",
      "--session",
      "ses_11bb",
      "--dir",
      "/repos/sunrise",
      "--prompt",
      "hello",
      "--json",
    ])
  })
})

describe("requestRelaunch", () => {
  test("relays the worker, its worktree, and the captain's note to the coordinator", async () => {
    const { exec, calls } = recordingExec(() => '{"ok":true}')

    await requestRelaunch({
      exec,
      worker,
      worktreeDirectory: "/repos/sunrise/.worktrees/fm/login-fix",
      coordinator,
      note: "start over with a clean brief",
    })

    expect(sends(calls)).toHaveLength(1)
    const relay = sends(calls)[0]
    expect(field(relay, "--session")).toBe("ses_coord_1")
    expect(field(relay, "--dir")).toBe("/home/firstmate/projects/sunrise")
    const prompt = field(relay, "--prompt") ?? ""
    expect(prompt).toContain("Fix flaky login test")
    expect(prompt).toContain("/repos/sunrise/.worktrees/fm/login-fix")
    expect(prompt).toContain("start over with a clean brief")
    expect(prompt).toContain("relaunch")
  })
})
