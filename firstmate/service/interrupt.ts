import { callDesktopProxy, type DesktopProxyOutcome } from "./desktop-proxy"
import type { FileSystemPort } from "./file-system"

// Interrupt is a gated workaround, not a contract capability: no SDK,
// control-API, CLI, or agent-tool surface exposes stop/interrupt, so this
// module reaches the managed opencode server's own `session.interrupt` —
// the call the desktop UI's stop button makes (SDK method session.interrupt)
// — through the OpenChamber CLI's
// local-client mechanism. That is a private, unstable surface; it is read
// never written, and its absence is reported as "unsupported", not hidden.

export type InterruptSupport =
  | { kind: "supported"; port: number; token?: string }
  | { kind: "unsupported"; reason: string }

// Reads the OpenChamber CLI's own settings file (read-only; never written to)
// for the local desktop server port and, when present, the local-client
// token. This is a private, unstable surface, and host classes differ: some
// answer /api/* on loopback with no auth at all, so only the port is
// required and the token is optional. A missing file, malformed JSON, or
// missing port mean this host offers no fallback path.
export async function discoverSupport(input: {
  filesystem: FileSystemPort
  settingsPath: string
}): Promise<InterruptSupport> {
  let raw: string
  try {
    raw = await input.filesystem.readFile(input.settingsPath)
  } catch {
    return { kind: "unsupported", reason: `the OpenChamber settings file could not be read (${input.settingsPath})` }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return { kind: "unsupported", reason: "the OpenChamber settings file is not valid JSON" }
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { kind: "unsupported", reason: "the OpenChamber settings file is not a JSON object" }
  }
  const record = parsed as Record<string, unknown>
  const port = record.desktopLocalPort
  const token = record.desktopLocalClientToken
  if (typeof port !== "number" || !Number.isInteger(port) || port <= 0) {
    return { kind: "unsupported", reason: "the OpenChamber settings file has no usable desktopLocalPort" }
  }
  // An empty token is as good as none; a non-string token is a malformed file.
  const usableToken = typeof token === "string" && token !== "" ? token : undefined
  if (token !== undefined && usableToken === undefined) {
    return { kind: "unsupported", reason: "the OpenChamber settings file has a non-string desktopLocalClientToken" }
  }
  return { kind: "supported", port, ...(usableToken !== undefined ? { token: usableToken } : {}) }
}

export interface HttpResult {
  status: number
  // The response body reader, present on real responses (the node fetcher
  // returns the Response object itself); test shims that record only
  // statuses may omit it. callDesktopProxy surfaces the body on 2xx so
  // callers can read host payloads.
  text?: () => Promise<string>
}

export type HttpFetcher = (url: string, init: { method: string; headers: Record<string, string>; body?: string }) => Promise<HttpResult>

export type InterruptOutcome = DesktopProxyOutcome

// Issues the managed opencode server's session.interrupt for the worker
// session in its directory (private-surface workaround, see above). The
// Authorization header is sent only when discovery found a token; auth-less
// host classes get none. A 401/403 classifies as unsupported — the host
// requires credentials discovery could not offer — not as a transport
// failure. Never throws past its own result type.
export async function interruptWorker(input: {
  fetcher: HttpFetcher
  support: InterruptSupport
  sessionId: string
  directory: string
}): Promise<InterruptOutcome> {
  return callDesktopProxy({
    fetcher: input.fetcher,
    support: input.support,
    method: "POST",
    path: `/api/session/${input.sessionId}/interrupt?directory=${encodeURIComponent(input.directory)}`,
    label: "abort",
  })
}
