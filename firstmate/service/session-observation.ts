import { callDesktopProxy } from "./desktop-proxy"
import type { HttpFetcher, InterruptSupport } from "./interrupt"

// The authoritative failure source: the managed opencode server's own
// GET /api/session/<id>, read through the desktop proxy like interrupt and
// permission auto-accept (private, unstable surface; read never written).
// The answer is the confirmed live shape of GET /api/session/<id>, seen in
// both actual observations: an UNWRAPPED single Session.Info — { id,
// outcome?: "succeeded" | "failed" | "interrupted", time: { idle?: number } }
// — from the initial scout, and the same record WRAPPED as
// { data: { id, outcome?, time: { ... } } } from a real disposable worker on
// the same authless desktop port. Both are accepted: the wrapped envelope is
// unwrapped only when the top level carries no id of its own, so a
// conflicting top-level id is never overridden by the data record.
// Nothing else observes a worker's terminal outcome — the CLI's session
// status reports only busy/idle and its messages command strips failure
// fields. The schema says outcome is the LAST completed execution, recorded
// at time.idle, and it persists while the session runs again, so the caller
// merges it only against an idle activity and keys repeat terminals by
// time.idle. This module is that one focused HTTP read: fetch, parse, and
// verify the shape; every failure mode answers its own result kind, never a
// throw.

export type SessionInfoOutcome = "succeeded" | "failed" | "interrupted"

export interface SessionInfo {
  id: string
  outcome?: SessionInfoOutcome
  time: { idle?: number }
}

export type SessionInfoResult =
  | { kind: "ok"; info: SessionInfo }
  | { kind: "unsupported"; reason: string }
  | { kind: "failed"; reason: string }

export async function fetchSessionInfo(input: {
  fetcher: HttpFetcher
  support: InterruptSupport
  sessionId: string
  directory: string
}): Promise<SessionInfoResult> {
  if (input.support.kind === "unsupported") {
    return { kind: "unsupported", reason: input.support.reason }
  }
  const outcome = await callDesktopProxy({
    fetcher: input.fetcher,
    support: input.support,
    method: "GET",
    path: `/api/session/${encodeURIComponent(input.sessionId)}?directory=${encodeURIComponent(input.directory)}`,
    label: "session info",
  })
  if (outcome.kind === "unsupported") return { kind: "unsupported", reason: outcome.reason }
  if (outcome.kind === "failed") return { kind: "failed", reason: outcome.message }
  if (outcome.text === undefined) return { kind: "failed", reason: "the session info response body could not be read" }
  return parseSessionInfo(outcome.text, input.sessionId)
}

// Verifies the confirmed live shape against the requested session: a JSON
// object whose id names that session and whose time is an object, with a
// finite numeric time.idle when one is present. The object may arrive bare
// (unwrapped) or as the data record of a { data: { ... } } envelope; the
// envelope is unwrapped only when the top level lacks an id, and the data
// record must then pass the same strict guards itself (a malformed data
// array/null/string, or a data record that does not name the requested
// session, is failed, never defaulted to). A 2xx body that does not
// match is a malformed observation, classified "failed" — the caller keeps
// its CLI fallback and reports the channel degraded. A missing outcome or
// time.idle is well-shaped but carries no terminal to merge (no known
// outcome until the first terminal is normal), and an outcome value outside
// the schema's three terminals is likewise not a terminal to act on.
function parseSessionInfo(text: string, sessionId: string): SessionInfoResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return { kind: "failed", reason: "the session info response was not valid JSON" }
  }
  if (!isRecord(parsed)) return { kind: "failed", reason: "the session info response was not a JSON object" }
  let payload: Record<string, unknown> = parsed
  if (typeof parsed.id !== "string") {
    if (!isRecord(parsed.data)) {
      return { kind: "failed", reason: "the session info response did not name the requested session" }
    }
    payload = parsed.data
  }
  if (typeof payload.id !== "string" || payload.id !== sessionId) {
    return { kind: "failed", reason: "the session info response did not name the requested session" }
  }
  if (!isRecord(payload.time)) return { kind: "failed", reason: "the session info response had no time object" }
  const idle = payload.time.idle
  if (idle !== undefined && idle !== null && (typeof idle !== "number" || !Number.isFinite(idle))) {
    return { kind: "failed", reason: "the session info response had a malformed time.idle" }
  }
  const outcome = sessionInfoOutcome(payload.outcome)
  const time: { idle?: number } = typeof idle === "number" ? { idle } : {}
  return { kind: "ok", info: { id: sessionId, ...(outcome !== undefined ? { outcome } : {}), time } }
}

// The schema's three terminal outcomes; anything else — including the
// nulls and stage names other surfaces report — is not a terminal.
function sessionInfoOutcome(value: unknown): SessionInfoOutcome | undefined {
  if (value === "succeeded" || value === "failed" || value === "interrupted") return value
  return undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
