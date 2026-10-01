export class MissingCliError extends Error {
  constructor() {
    super("the openchamber CLI is required. Install it with: npm i -g @openchamber/web")
    this.name = "MissingCliError"
  }
}

export type ExecRunner = (command: string, args: readonly string[]) => Promise<string>

export async function createSession(exec: ExecRunner, input: { directory: string; title: string }): Promise<string> {
  let output: string
  try {
    output = await exec("openchamber", ["session", "create", "--dir", input.directory, "--title", input.title, "--json"])
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      throw new MissingCliError()
    }
    throw error
  }
  const parsed = parseJsonOutput(output)
  const sessionId = extractSessionId(parsed)
  if (sessionId === undefined) {
    throw new Error("openchamber session create output did not include a session id")
  }
  return sessionId
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}
