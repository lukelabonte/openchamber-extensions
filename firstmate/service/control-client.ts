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

export async function sessionMessagesLastAssistant(exec: ExecRunner, input: { sessionId: string; directory: string }): Promise<string | undefined> {
  const output = await runControlCommand(exec, ["session", "messages", "--session", input.sessionId, "--dir", input.directory, "--last-assistant", "--json"])
  const parsed = parseJsonOutput(output)
  return extractAssistantText(parsed)
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

// The `session status --json` shape is not yet runtime-verified either; the
// verified fact is that the status carries a type. Accept the common activity
// keys and default to `unknown` for anything unrecognized.
const knownActivities: readonly SessionActivity[] = ["unknown", "idle", "running", "retrying", "waiting-permission", "waiting-question"]

function extractActivity(parsed: unknown): SessionActivity {
  if (!isRecord(parsed)) return "unknown"
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

// The `session messages --last-assistant --json` shape is not yet
// runtime-verified; accept the common text keys until it is.
function extractAssistantText(parsed: unknown): string | undefined {
  if (typeof parsed === "string") return parsed === "" ? undefined : parsed
  if (!isRecord(parsed)) return undefined
  for (const key of ["text", "content", "message"]) {
    const value = parsed[key]
    if (typeof value === "string" && value !== "") return value
  }
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
