import { callDesktopProxy, type DesktopProxyOutcome } from "./desktop-proxy"
import type { HttpFetcher, InterruptSupport } from "./interrupt"

// Permission auto-accept is, like interrupt, a gated workaround rather than a
// contract capability: no SDK, control-API, CLI, or agent-tool surface exposes
// a per-session auto-approve switch, so this module sets the OpenChamber
// desktop proxy's `permission-auto-accept` for a session — mode "auto"
// answers every permission request, and the OpenChamber runtime reconciles
// requests already pending when a session moves to auto. That is a private,
// unstable surface; its absence is reported as "unsupported", not hidden.

export type PermissionAutoOutcome = DesktopProxyOutcome

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
  return callDesktopProxy({
    fetcher: input.fetcher,
    support: input.support,
    method: "PUT",
    path: `/api/permission-auto-accept/sessions/${input.sessionId}`,
    body: JSON.stringify({ mode: "auto", directory: input.directory }),
    label: "auto-accept",
  })
}
