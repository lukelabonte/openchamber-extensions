import { callDesktopProxy } from "./desktop-proxy"
import type { HttpFetcher, InterruptSupport } from "./interrupt"

// The captain's desktop notification through the host's emit route
// (POST /api/notifications/emit — title and body, optional session id and
// directory context). Best effort by contract: an unsupported host, a failed
// call, and the host's own rate limit are all swallowed — a missed
// notification must never fail the work it reports on.
export async function notifyCaptain(input: {
  fetcher: HttpFetcher
  support: InterruptSupport
  title: string
  body: string
  sessionId?: string
  directory?: string
}): Promise<void> {
  try {
    await callDesktopProxy({
      fetcher: input.fetcher,
      support: input.support,
      method: "POST",
      path: "/api/notifications/emit",
      body: JSON.stringify({
        title: input.title,
        body: input.body,
        ...(input.sessionId !== undefined ? { sessionId: input.sessionId } : {}),
        ...(input.directory !== undefined ? { directory: input.directory } : {}),
      }),
      label: "captain notification",
    })
  } catch {
    // Best effort: never throws.
  }
}
