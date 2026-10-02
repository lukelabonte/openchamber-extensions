import { describe, expect, test } from "bun:test"
import {
  createSession,
  MissingCliError,
  sessionList,
  sessionMessagesLastAssistant,
  sessionSend,
  sessionStatus,
  SessionBusyError,
  type ExecRunner,
} from "../service/control-client"

interface ExecCall {
  command: string
  args: string[]
}

function fakeExec(stdout: string): { exec: ExecRunner; calls: ExecCall[] } {
  const calls: ExecCall[] = []
  const exec: ExecRunner = async (command, args) => {
    calls.push({ command, args: [...args] })
    return stdout
  }
  return { exec, calls }
}

function failingExec(error: Error): { exec: ExecRunner; calls: ExecCall[] } {
  const calls: ExecCall[] = []
  const exec: ExecRunner = async (command, args) => {
    calls.push({ command, args: [...args] })
    throw error
  }
  return { exec, calls }
}

describe("sessionStatus", () => {
  test("runs openchamber session status scoped to the directory and parses the activity type", async () => {
    const { exec, calls } = fakeExec('{"type":"running"}')

    const status = await sessionStatus(exec, { sessionId: "ses_11bb", directory: "/repos/sunrise" })

    expect(status).toEqual({ activity: "running", outcome: null })
    expect(calls).toEqual([
      { command: "openchamber", args: ["session", "status", "--session", "ses_11bb", "--dir", "/repos/sunrise", "--json"] },
    ])
  })

  test("parses the known activity values and a failed outcome", async () => {
    for (const activity of ["unknown", "idle", "running", "retrying", "waiting-permission", "waiting-question"] as const) {
      const { exec } = fakeExec(JSON.stringify({ type: activity, outcome: activity === "idle" ? "failed" : null }))
      expect(await sessionStatus(exec, { sessionId: "s", directory: "/d" })).toEqual({
        activity,
        outcome: activity === "idle" ? "failed" : null,
      })
    }
  })

  test("accepts the alternate activity key and defaults unknown shapes to unknown activity", async () => {
    const alt = fakeExec('{"activity":"waiting-question"}')
    expect(await sessionStatus(alt.exec, { sessionId: "s", directory: "/d" })).toEqual({
      activity: "waiting-question",
      outcome: null,
    })

    const empty = fakeExec("{}")
    expect(await sessionStatus(empty.exec, { sessionId: "s", directory: "/d" })).toEqual({
      activity: "unknown",
      outcome: null,
    })
  })

  test("fails when the output is not JSON and translates a missing CLI into MissingCliError", async () => {
    const notJson = fakeExec("not json")
    await expect(sessionStatus(notJson.exec, { sessionId: "s", directory: "/d" })).rejects.toThrow("valid JSON")

    const enoent = failingExec(Object.assign(new Error("spawn openchamber ENOENT"), { code: "ENOENT" }))
    await expect(sessionStatus(enoent.exec, { sessionId: "s", directory: "/d" })).rejects.toBeInstanceOf(MissingCliError)
  })
})

describe("sessionMessagesLastAssistant", () => {
  test("runs openchamber session messages with --last-assistant and returns the assistant text", async () => {
    const { exec, calls } = fakeExec('{"text":"Which test runner should I use?"}')

    const lastWord = await sessionMessagesLastAssistant(exec, { sessionId: "ses_11bb", directory: "/repos/sunrise" })

    expect(lastWord).toBe("Which test runner should I use?")
    expect(calls).toEqual([
      { command: "openchamber", args: ["session", "messages", "--session", "ses_11bb", "--dir", "/repos/sunrise", "--last-assistant", "--json"] },
    ])
  })

  test("answers undefined when the output carries no assistant text", async () => {
    const { exec } = fakeExec('{"other":1}')
    expect(await sessionMessagesLastAssistant(exec, { sessionId: "s", directory: "/d" })).toBeUndefined()
  })

  test("fails when the output is not JSON", async () => {
    const { exec } = fakeExec("not json")
    await expect(sessionMessagesLastAssistant(exec, { sessionId: "s", directory: "/d" })).rejects.toThrow("valid JSON")
  })
})

describe("sessionSend", () => {
  test("runs openchamber session send with the prompt scoped to the directory", async () => {
    const { exec, calls } = fakeExec('{"ok":true}')

    await sessionSend(exec, { sessionId: "ses_coord_1", directory: "/home/firstmate/projects/sunrise", prompt: "Worker update" })

    expect(calls).toEqual([
      {
        command: "openchamber",
        args: ["session", "send", "--session", "ses_coord_1", "--dir", "/home/firstmate/projects/sunrise", "--prompt", "Worker update", "--json"],
      },
    ])
  })

  test("translates a busy failure into SessionBusyError", async () => {
    const { exec } = failingExec(new Error("openchamber exited with code 1: SESSION_BUSY: the session is busy"))
    await expect(
      sessionSend(exec, { sessionId: "s", directory: "/d", prompt: "hello" }),
    ).rejects.toBeInstanceOf(SessionBusyError)
  })

  test("rethrows other failures unchanged", async () => {
    const { exec } = failingExec(new Error("openchamber exited with code 1: no such session"))
    await expect(sessionSend(exec, { sessionId: "s", directory: "/d", prompt: "hello" })).rejects.toThrow("no such session")
  })
})

describe("sessionList", () => {
  test("runs openchamber session list directory-scoped with status and returns the sessions", async () => {
    const { exec, calls } = fakeExec(
      JSON.stringify({ sessions: [{ sessionID: "ses_a", type: "running" }, { sessionID: "ses_b", type: "idle", outcome: "completed" }] }),
    )

    const sessions = await sessionList(exec, { directory: "/repos/sunrise" })

    expect(sessions).toEqual([
      { sessionId: "ses_a", status: { activity: "running", outcome: null } },
      { sessionId: "ses_b", status: { activity: "idle", outcome: "completed" } },
    ])
    expect(calls).toEqual([
      { command: "openchamber", args: ["session", "list", "--dir", "/repos/sunrise", "--with-status", "--json"] },
    ])
  })

  test("accepts a top-level array and skips entries without a session id", async () => {
    const { exec } = fakeExec(JSON.stringify([{ id: "ses_c" }, { type: "idle" }]))
    expect(await sessionList(exec, { directory: "/d" })).toEqual([
      { sessionId: "ses_c", status: { activity: "unknown", outcome: null } },
    ])
  })
})
