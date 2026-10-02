import type { HttpFetcher, InterruptSupport } from "./interrupt"

// The desktop proxy calls (interrupt, permission auto-accept) share one HTTP
// shape: gate on the discovered support, call the loopback desktop server
// with an optional local-client token, and classify the answer — 2xx is ok,
// 401/403 is unsupported (the host requires credentials discovery could not
// offer), anything else is a transport failure. This module is that shape
// once; callers build their own path and body.

export type DesktopProxyOutcome =
  | { kind: "ok" }
  | { kind: "unsupported"; reason: string }
  | { kind: "failed"; message: string }

export async function callDesktopProxy(input: {
  fetcher: HttpFetcher
  support: InterruptSupport
  method: string
  path: string
  body?: string
  // The noun the outcome messages name ("abort", "auto-accept"), so each
  // caller's established wording is preserved verbatim.
  label: string
}): Promise<DesktopProxyOutcome> {
  if (input.support.kind === "unsupported") {
    return { kind: "unsupported", reason: input.support.reason }
  }
  const url = `http://127.0.0.1:${input.support.port}${input.path}`
  const headers: Record<string, string> = {}
  if (input.body !== undefined) headers["content-type"] = "application/json"
  if (input.support.token !== undefined) headers.authorization = `Bearer ${input.support.token}`
  try {
    const result = await input.fetcher(url, { method: input.method, headers, ...(input.body !== undefined ? { body: input.body } : {}) })
    if (result.status >= 200 && result.status < 300) return { kind: "ok" }
    if (result.status === 401 || result.status === 403) {
      return {
        kind: "unsupported",
        reason: `the ${input.label} call was rejected with status ${result.status}: this host requires credentials that were not offered`,
      }
    }
    return { kind: "failed", message: `the ${input.label} call answered with status ${result.status}` }
  } catch (error) {
    return { kind: "failed", message: error instanceof Error ? error.message : String(error) }
  }
}
