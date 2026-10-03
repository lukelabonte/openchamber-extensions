import { describe, expect, test } from "bun:test"
import {
  createSession,
  MissingCliError,
  sessionLastAssistant,
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

  test("parses the runtime-verified shape: nested sessionStatus busy/idle", async () => {
    const busy = fakeExec('{"status":"ok","sessionId":"ses_11bb","directory":"/repos/sunrise","sessionStatus":{"type":"busy"}}')
    expect(await sessionStatus(busy.exec, { sessionId: "ses_11bb", directory: "/repos/sunrise" })).toEqual({
      activity: "running",
      outcome: null,
    })

    const idle = fakeExec('{"status":"ok","sessionId":"s","directory":"/d","sessionStatus":{"type":"idle"}}')
    expect(await sessionStatus(idle.exec, { sessionId: "s", directory: "/d" })).toEqual({
      activity: "idle",
      outcome: null,
    })
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

  test("extracts messages[0].text from the runtime-verified shape", async () => {
    const { exec } = fakeExec(
      '{"status":"ok","sessionId":"s","directory":"/d","role":"assistant","sessionStatus":{"type":"idle"},"messages":[{"id":"msg_1","role":"assistant","createdAt":1,"completedAt":2,"model":"test-model","text":"acknowledged"}]}',
    )
    expect(await sessionMessagesLastAssistant(exec, { sessionId: "s", directory: "/d" })).toBe("acknowledged")
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

describe("sessionLastAssistant", () => {
  test("extracts the richer last-assistant fields from the runtime-verified shape with the same CLI argv", async () => {
    const { exec, calls } = fakeExec(
      '{"status":"ok","sessionId":"s","directory":"/d","role":"assistant","sessionStatus":{"type":"idle"},"messages":[{"id":"msg_1","role":"assistant","createdAt":10,"completedAt":20,"model":"test-model","text":"acknowledged"}]}',
    )

    const last = await sessionLastAssistant(exec, { sessionId: "s", directory: "/d" })

    expect(last).toEqual({ text: "acknowledged", id: "msg_1", createdAt: 10, completedAt: 20 })
    // The richer extraction rides the exact same command the plain text
    // reader used — one CLI call, unchanged argv.
    expect(calls).toEqual([
      { command: "openchamber", args: ["session", "messages", "--session", "s", "--dir", "/d", "--last-assistant", "--json"] },
    ])
  })

  test("timestamps are accepted only as finite numbers, and absent fields stay absent — never fabricated", async () => {
    // Numeric strings and nulls are not part of the contract.
    const numericStrings = fakeExec('{"messages":[{"id":"msg_1","createdAt":"10","completedAt":null,"text":"acknowledged"}]}')
    expect(await sessionLastAssistant(numericStrings.exec, { sessionId: "s", directory: "/d" })).toEqual({
      text: "acknowledged",
      id: "msg_1",
    })

    // A non-finite number (JSON 1e999 parses to Infinity) is not a timestamp.
    const nonFinite = fakeExec('{"messages":[{"id":"msg_1","createdAt":1e999,"text":"acknowledged"}]}')
    expect(await sessionLastAssistant(nonFinite.exec, { sessionId: "s", directory: "/d" })).toEqual({
      text: "acknowledged",
      id: "msg_1",
    })

    const textOnly = fakeExec('{"messages":[{"text":"no identity here"}]}')
    expect(await sessionLastAssistant(textOnly.exec, { sessionId: "s", directory: "/d" })).toEqual({ text: "no identity here" })
  })

  test("the plain-string output stays backward compatible for both readers", async () => {
    // With --json the plain string arrives as a quoted JSON string envelope;
    // unquoted output is corrupt JSON and stays rejected.
    const plain = fakeExec(JSON.stringify("plain words"))
    expect(await sessionLastAssistant(plain.exec, { sessionId: "s", directory: "/d" })).toEqual({ text: "plain words" })
    expect(await sessionMessagesLastAssistant(plain.exec, { sessionId: "s", directory: "/d" })).toBe("plain words")

    const empty = fakeExec(JSON.stringify(""))
    expect(await sessionMessagesLastAssistant(empty.exec, { sessionId: "s", directory: "/d" })).toBeUndefined()

    const unquoted = fakeExec("plain words")
    await expect(sessionLastAssistant(unquoted.exec, { sessionId: "s", directory: "/d" })).rejects.toThrow("valid JSON")
    await expect(sessionMessagesLastAssistant(unquoted.exec, { sessionId: "s", directory: "/d" })).rejects.toThrow("valid JSON")
  })
})
