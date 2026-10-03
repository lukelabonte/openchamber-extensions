export class MissingCliError extends Error {
  constructor() {
    super("the openchamber CLI is required. Install it with: npm i -g @openchamber/web")
    this.name = "MissingCliError"
  }
}

// `session send` to a busy session may queue or fail with a busy error
// (plan.md, "Could not determine"); when it fails, the CLI says so in the
// error text. SessionBusyError lets the forwarder retry with backoff either
// way once the exact behavior is runtime-verified at acceptance.
export class SessionBusyError extends Error {
  constructor() {
    super("the session is busy and cannot accept a message right now")
    this.name = "SessionBusyError"
  }
}

export type SessionActivity = "unknown" | "idle" | "running" | "retrying" | "waiting-permission" | "waiting-question"

export type SessionOutcome = "completed" | "failed" | null

export interface SessionStatus {
  activity: SessionActivity
  outcome: SessionOutcome
}

export interface SessionListEntry {
  sessionId: string
  status: SessionStatus
}

export type ExecRunner = (command: string, args: readonly string[]) => Promise<string>

export async function createSession(exec: ExecRunner, input: { directory: string; title: string }): Promise<string> {
  const output = await runControlCommand(exec, ["session", "create", "--dir", input.directory, "--title", input.title, "--json"])
  const parsed = parseJsonOutput(output)
  const sessionId = extractSessionId(parsed)
  if (sessionId === undefined) {
    throw new Error("openchamber session create output did not include a session id")
  }
  return sessionId
}

export async function sessionStatus(exec: ExecRunner, input: { sessionId: string; directory: string }): Promise<SessionStatus> {
  const output = await runControlCommand(exec, ["session", "status", "--session", input.sessionId, "--dir", input.directory, "--json"])
  const parsed = parseJsonOutput(output)
  return { activity: extractActivity(parsed), outcome: extractOutcome(parsed) }
}

// The last assistant message's identity and full text, from the SAME
// `session messages --last-assistant` CLI command the plain text reader uses.
// The stall detector signatures on all of id + timestamps + full text — a
// streaming message keeps its id while its text grows, and that growth is
// progress. Timestamps are accepted only as finite numbers (the
// runtime-verified shape carries numbers; numeric strings are not part of
// the contract). Absent fields are simply absent — never fabricated.
export interface SessionLastAssistant {
  text?: string
  id?: string
  createdAt?: number
  completedAt?: number
}

export async function sessionLastAssistant(exec: ExecRunner, input: { sessionId: string; directory: string }): Promise<SessionLastAssistant> {
  const output = await runControlCommand(exec, ["session", "messages", "--session", input.sessionId, "--dir", input.directory, "--last-assistant", "--json"])
  const parsed = parseJsonOutput(output)
  return extractLastAssistant(parsed)
}

export async function sessionMessagesLastAssistant(exec: ExecRunner, input: { sessionId: string; directory: string }): Promise<string | undefined> {
  return (await sessionLastAssistant(exec, input)).text
}

export async function sessionSend(exec: ExecRunner, input: { sessionId: string; directory: string; prompt: string }): Promise<void> {
  try {
    await runControlCommand(exec, ["session", "send", "--session", input.sessionId, "--dir", input.directory, "--prompt", input.prompt, "--json"])
  } catch (error) {
    if (error instanceof Error && /busy/i.test(error.message)) {
      throw new SessionBusyError()
    }
    throw error
  }
}

export async function sessionList(exec: ExecRunner, input: { directory: string }): Promise<SessionListEntry[]> {
  const output = await runControlCommand(exec, ["session", "list", "--dir", input.directory, "--with-status", "--json"])
  const parsed = parseJsonOutput(output)
  const entries = Array.isArray(parsed) ? parsed : isRecord(parsed) && Array.isArray(parsed.sessions) ? parsed.sessions : []
  const sessions: SessionListEntry[] = []
  for (const entry of entries) {
    const sessionId = extractSessionId(entry)
    if (sessionId === undefined) continue
    sessions.push({ sessionId, status: { activity: extractActivity(entry), outcome: extractOutcome(entry) } })
  }
  return sessions
}

async function runControlCommand(exec: ExecRunner, args: readonly string[]): Promise<string> {
  try {
    return await exec("openchamber", args)
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      throw new MissingCliError()
    }
    throw error
  }
}

function parseJsonOutput(output: string): unknown {
  try {
    return JSON.parse(output)
  } catch {
    throw new Error("openchamber command did not return valid JSON")
  }
}

// The exact `--json` response shape is not yet runtime-verified (plan.md, "Could
// not determine"); accept the common session-id keys until it is.
function extractSessionId(parsed: unknown): string | undefined {
  if (!isRecord(parsed)) return undefined
  for (const key of ["sessionID", "sessionId", "id"]) {
    const value = parsed[key]
    if (typeof value === "string" && value !== "") return value
  }
  return undefined
}

// Runtime-verified shapes (openchamber CLI, captured 2026-10-02):
// - `session status --json` → {"status":"ok","sessionId":"…","directory":"…","sessionStatus":{"type":"busy"}} — type is ONLY "busy" or "idle" (the control service maps active→busy, idle→idle; no other values ever appear).
// - `session messages --last-assistant --json` → the same envelope plus "messages":[{"id":"…","role":"assistant","createdAt":…,"completedAt":…,"model":"…","text":"…"}].
// Read the nested sessionStatus record first; the top-level key scan stays as
// fallback for other host classes. A top-level "status":"ok" is ignored
// because it is not a known activity.
const knownActivities: readonly SessionActivity[] = ["unknown", "idle", "running", "retrying", "waiting-permission", "waiting-question"]

function extractActivity(parsed: unknown): SessionActivity {
  if (!isRecord(parsed)) return "unknown"
  const nested = parsed.sessionStatus
  if (isRecord(nested) && typeof nested.type === "string") {
    if (nested.type === "busy") return "running"
    if (nested.type === "idle") return "idle"
    if ((knownActivities as readonly string[]).includes(nested.type)) return nested.type as SessionActivity
  }
  for (const key of ["type", "activity", "status"]) {
    const value = parsed[key]
    if (typeof value === "string" && (knownActivities as readonly string[]).includes(value)) {
      return value as SessionActivity
    }
  }
  return "unknown"
}

function extractOutcome(parsed: unknown): SessionOutcome {
  if (!isRecord(parsed)) return null
  const value = parsed.outcome
  if (value === "completed" || value === "failed") return value
  return null
}

// Runtime-verified shape (openchamber CLI, captured 2026-10-02):
// `session messages --last-assistant --json` → {"status":"ok","sessionId":"…","directory":"…","role":"assistant","sessionStatus":{"type":"idle"},"messages":[{"id":"…","role":"assistant","createdAt":…,"completedAt":…,"model":"…","text":"…"}]}
// — identity fields come from messages[0]; assistant text is messages[0].text.
// The older top-level text keys stay as fallback for other host classes
// (they carry no message id, so only the text is taken from there).
function extractLastAssistant(parsed: unknown): SessionLastAssistant {
  if (typeof parsed === "string") return parsed === "" ? {} : { text: parsed }
  if (!isRecord(parsed)) return {}
  const first = Array.isArray(parsed.messages) && isRecord(parsed.messages[0]) ? parsed.messages[0] : undefined
  const text =
    first !== undefined && typeof first.text === "string" && first.text !== ""
      ? first.text
      : (["text", "content", "message"] as const).map((key) => parsed[key]).find((value): value is string => typeof value === "string" && value !== "")
  const id = first !== undefined && typeof first.id === "string" && first.id !== "" ? first.id : undefined
  const createdAt = finiteTimestamp(first?.createdAt)
  const completedAt = finiteTimestamp(first?.completedAt)
  return {
    ...(text !== undefined ? { text } : {}),
    ...(id !== undefined ? { id } : {}),
    ...(createdAt !== undefined ? { createdAt } : {}),
    ...(completedAt !== undefined ? { completedAt } : {}),
  }
}

function finiteTimestamp(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
