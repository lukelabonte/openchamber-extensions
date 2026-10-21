import { describe, expect, test } from "bun:test"
import {
  associateSessionProject,
  controlErrorMessage,
  createSession,
  MissingCliError,
  sessionLastAssistant,
  sessionList,
  sessionMessagesLastAssistant,
  sessionSend,
  sessionStatus,
  SessionBusyError,
  UnsupportedSessionProjectError,
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

describe("createSession", () => {
  test("passes optional opening prompt, provider/model and variant atomically on create", async () => {
    const { exec, calls } = fakeExec('{"sessionId":"ses_new"}')
    expect(await createSession(exec, { directory: "/home/project", title: "FirstMate", prompt: "Captain's opening\nKeep this verbatim.", model: "provider/model", variant: "high" })).toBe("ses_new")
    expect(calls[0].args).toEqual(["session", "create", "--dir", "/home/project", "--title", "⚓ FirstMate", "--prompt", "Captain's opening\nKeep this verbatim.", "--model", "provider/model", "--variant", "high", "--json"])
  })

  test("does not add unspecified optional flags", async () => {
    const { exec, calls } = fakeExec('{"sessionID":"ses_new"}')
    await createSession(exec, { directory: "/home/project", title: "FirstMate" })
    expect(calls[0].args).toEqual(["session", "create", "--dir", "/home/project", "--title", "⚓ FirstMate", "--json"])
  })

  test.each(["provider:adaptive/extended", '推論 mode "深い" \\ route', "v".repeat(200), "default", "  provider:adaptive/extended  "])("passes opaque provider variants as one unchanged CLI argument: %j", async (variant) => {
    const { exec, calls } = fakeExec('{"sessionId":"ses_new"}')

    expect(await createSession(exec, { directory: "/home/project", title: "FirstMate", variant })).toBe("ses_new")
    expect(calls).toEqual([{ command: "openchamber", args: ["session", "create", "--dir", "/home/project", "--title", "⚓ FirstMate", "--variant", variant, "--json"] }])
  })

  test("propagates the CLI's unsupported provider-variant error", async () => {
    const { exec, calls } = failingExec(new Error("model does not support variant provider:adaptive/extended"))
    await expect(createSession(exec, { directory: "/home/project", title: "FirstMate", variant: "provider:adaptive/extended" })).rejects.toThrow("model does not support variant provider:adaptive/extended")
    expect(calls[0].args).toContain("provider:adaptive/extended")
  })

  test("refuses malformed and error-envelope create responses", async () => {
    for (const output of ["not JSON", "{}", '{"status":"error","sessionId":"ses_not_created"}']) {
      await expect(createSession(fakeExec(output).exec, { directory: "/home/project", title: "FirstMate" })).rejects.toThrow()
    }
  })
})

describe("associateSessionProject", () => {
  const input = { sessionId: "ses_mate", directory: "/home/firstmate/project with spaces", projectDirectory: "/repos/project with spaces" }

  test("passes display ownership separately from the session's actual directory", async () => {
    const { exec, calls } = fakeExec('{"sessionId":"ses_mate"}')
    await associateSessionProject(exec, input)
    expect(calls).toEqual([{ command: "openchamber", args: ["session", "associate-project", "--session", "ses_mate", "--dir", input.directory, "--display-project-dir", input.projectDirectory, "--json"] }])
  })

  test.each(["not JSON", "{}", '{"sessionId":"ses_other"}', '{"ok":false,"sessionId":"ses_mate"}'])("rejects an invalid association response: %s", async (output) => {
    await expect(associateSessionProject(fakeExec(output).exec, input)).rejects.toThrow()
  })

  test.each(["Unknown option: --display-project-dir", "Unknown session command 'associate-project'."])("classifies only known unsupported CLI diagnostics: %s", async (message) => {
    for (const exec of [
      failingExec(new Error(`openchamber exited with code 1: ${message}`)).exec,
      fakeExec(JSON.stringify({ status: "error", error: { message } })).exec,
    ]) {
      await expect(associateSessionProject(exec, input)).rejects.toBeInstanceOf(UnsupportedSessionProjectError)
    }
  })

  test("reports other CLI failures and missing CLI failures", async () => {
    await expect(associateSessionProject(failingExec(new Error("unknown session action associate-project")).exec, input)).rejects.toThrow("associate-project")
    for (const message of ["host unavailable", "Unknown option: --session", "session not found", "Unknown option: --display-project-dir while contacting server"]) {
      const error = await associateSessionProject(failingExec(new Error(message)).exec, input).catch((error: unknown) => error)
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(UnsupportedSessionProjectError)
    }
    await expect(associateSessionProject(failingExec(Object.assign(new Error("missing"), { code: "ENOENT" })).exec, input)).rejects.toBeInstanceOf(MissingCliError)
  })
})

describe("controlErrorMessage", () => {
  test("extracts only the diagnostic from a structured CLI error", () => {
    expect(controlErrorMessage(JSON.stringify({ status: "error", error: { message: "Unknown option: --display-project-dir", details: ["unrelated details"] }, text: "unrelated output" }))).toBe("Unknown option: --display-project-dir")
  })

  test.each(["not JSON", "{}", '{"status":"ok","message":"session text"}', '{"status":"error","error":{}}', '{"status":"error","error":{"message":" "}}'])("does not surface arbitrary output or malformed errors: %s", (output) => {
    expect(controlErrorMessage(output)).toBeUndefined()
  })
})

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

  test("does not let a fallback idle field override an unrecognized authoritative status", async () => {
    for (const sessionStatusValue of [{ type: "future-activity" }, {}, null]) {
      const { exec } = fakeExec(JSON.stringify({ sessionStatus: sessionStatusValue, activity: "idle" }))
      expect((await sessionStatus(exec, { sessionId: "s", directory: "/d" })).activity).toBe("unknown")
    }
  })

  test("refuses status error envelopes and mismatched session identities", async () => {
    for (const output of ['{"status":"error","sessionStatus":{"type":"idle"}}', '{"sessionId":"other","type":"idle"}']) {
      await expect(sessionStatus(fakeExec(output).exec, { sessionId: "s", directory: "/d" })).rejects.toThrow()
    }
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
  test("parses the source-verified installed list status object independently of legacy activity fields", async () => {
    // Installed @openchamber/web server/lib/openchamber-control/service.js:850-859
    // emits status.type; bin/lib/commands-session.js:81 reads it. Source-verified, not a runtime capture.
    const { exec } = fakeExec(JSON.stringify({ sessions: [
      { id: "ses_busy", directory: "/home/project", status: { type: "busy" }, activity: "idle", sessionStatus: { type: "idle" } },
      { id: "ses_idle", directory: "/home/project", status: { type: "idle" } },
      { id: "ses_unknown", directory: "/home/project", status: { type: "unknown" } },
    ] }))
    expect(await sessionList(exec, { directory: "/home/project" })).toEqual([
      { sessionId: "ses_busy", directory: "/home/project", status: { activity: "running", outcome: null } },
      { sessionId: "ses_idle", directory: "/home/project", status: { activity: "idle", outcome: null } },
      { sessionId: "ses_unknown", directory: "/home/project", status: { activity: "unknown", outcome: null } },
    ])
  })

  test("unknown or malformed authoritative list statuses cannot fall through to legacy idle fields", async () => {
    for (const status of [{ type: "unknown" }, { type: "future-activity" }, {}, { type: 42 }, null, [], 42, false]) {
      const { exec } = fakeExec(JSON.stringify({ sessions: [{ id: "ses_a", status, activity: "idle", type: "idle", sessionStatus: { type: "idle" } }] }))
      expect(await sessionList(exec, { directory: "/home/project" })).toEqual([
        { sessionId: "ses_a", status: { activity: "unknown", outcome: null } },
      ])
    }
  })

  test("retains legacy activity formats in both list envelopes", async () => {
    const entries = [
      { id: "ses_nested", sessionStatus: { type: "busy" } },
      { id: "ses_activity", activity: "retrying" },
      { id: "ses_type", type: "waiting-question" },
      { id: "ses_string", status: "idle" },
      { id: "ses_envelope", status: "ok", activity: "waiting-permission" },
    ]
    for (const output of [entries, { status: "ok", sessions: entries }]) {
      expect(await sessionList(fakeExec(JSON.stringify(output)).exec, { directory: "/home/project" })).toEqual([
        { sessionId: "ses_nested", status: { activity: "running", outcome: null } },
        { sessionId: "ses_activity", status: { activity: "retrying", outcome: null } },
        { sessionId: "ses_type", status: { activity: "waiting-question", outcome: null } },
        { sessionId: "ses_string", status: { activity: "idle", outcome: null } },
        { sessionId: "ses_envelope", status: { activity: "waiting-permission", outcome: null } },
      ])
    }
  })

  test("passes an explicit bounded limit and rejects invalid limits before executing", async () => {
    for (const limit of [1, 1000]) {
      const { exec, calls } = fakeExec('{"sessions":[]}')
      await sessionList(exec, { directory: "/home/project", all: true, limit })
      expect(calls[0].args).toEqual(["session", "list", "--dir", "/home/project", "--with-status", "--all", "--limit", String(limit), "--json"])
    }
    for (const limit of [0, -1, 1.5, 1001, NaN, Infinity]) {
      const { exec, calls } = fakeExec('{"sessions":[]}')
      await expect(sessionList(exec, { directory: "/home/project", limit })).rejects.toThrow("limit")
      expect(calls).toEqual([])
    }
  })

  test("exposes archive and directory evidence and supports including archived sessions", async () => {
    const { exec, calls } = fakeExec(JSON.stringify({ sessions: [
      { id: "ses_archived", directory: "/home/project", time: { archived: 42 }, sessionStatus: { type: "idle" } },
      { id: "ses_active", archivedAt: null, sessionStatus: { type: "idle" } },
    ] }))
    expect(await sessionList(exec, { directory: "/home/project", all: true })).toEqual([
      { sessionId: "ses_archived", directory: "/home/project", archived: true, status: { activity: "idle", outcome: null } },
      { sessionId: "ses_active", archived: false, status: { activity: "idle", outcome: null } },
    ])
    expect(calls[0].args).toEqual(["session", "list", "--dir", "/home/project", "--with-status", "--all", "--json"])
  })

  test("refuses valid JSON without a list or with an error envelope", async () => {
    for (const output of ['{}', '{"status":"error","sessions":[]}', 'null']) {
      await expect(sessionList(fakeExec(output).exec, { directory: "/home/project" })).rejects.toThrow()
    }
  })

  test("refuses malformed ownership or archive evidence rather than silently discarding it", async () => {
    for (const entry of [{ id: "s", directory: 42 }, { id: "s", directory: "" }, { id: "s", archived: "false" }, { id: "s", time: "unknown" }]) {
      await expect(sessionList(fakeExec(JSON.stringify([entry])).exec, { directory: "/d" })).rejects.toThrow()
    }
  })

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
