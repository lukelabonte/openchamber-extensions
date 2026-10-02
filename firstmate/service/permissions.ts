import type { HttpFetcher, InterruptSupport } from "./interrupt"

// Permission auto-accept is, like interrupt, a gated workaround rather than a
// contract capability: no SDK, control-API, CLI, or agent-tool surface exposes
// a per-session auto-approve switch, so this module sets the OpenChamber
// desktop proxy's `permission-auto-accept` for a session — mode "auto"
// answers every permission request, and the OpenChamber runtime reconciles
// requests already pending when a session moves to auto. That is a private,
// unstable surface; its absence is reported as "unsupported", not hidden.

export type PermissionAutoOutcome =
  | { kind: "ok" }
  | { kind: "unsupported"; reason: string }
  | { kind: "failed"; message: string }

// Sets the session's permission auto-accept to "auto" in its directory
// (private-surface workaround, see above). The Authorization header is sent
// only when discovery found a token; auth-less host classes get none. A
// 401/403 classifies as unsupported — the host requires credentials discovery
// could not offer — not as a transport failure. Never throws past its own
// result type.
export async function setSessionPermissionAuto(input: {
  fetcher: HttpFetcher
  support: InterruptSupport
  sessionId: string
  directory: string
}): Promise<PermissionAutoOutcome> {
  if (input.support.kind === "unsupported") {
    return { kind: "unsupported", reason: input.support.reason }
  }
  const url = `http://127.0.0.1:${input.support.port}/api/permission-auto-accept/sessions/${input.sessionId}`
  const headers: Record<string, string> = { "content-type": "application/json" }
  if (input.support.token !== undefined) headers.authorization = `Bearer ${input.support.token}`
  try {
    const result = await input.fetcher(url, {
      method: "PUT",
      headers,
      body: JSON.stringify({ mode: "auto", directory: input.directory }),
    })
    if (result.status >= 200 && result.status < 300) return { kind: "ok" }
    if (result.status === 401 || result.status === 403) {
      return {
        kind: "unsupported",
        reason: `the auto-accept call was rejected with status ${result.status}: this host requires credentials that were not offered`,
      }
    }
    return { kind: "failed", message: `the auto-accept call answered with status ${result.status}` }
  } catch (error) {
    return { kind: "failed", message: error instanceof Error ? error.message : String(error) }
  }
}
