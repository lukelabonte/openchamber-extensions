import { callDesktopProxy } from "./desktop-proxy"
import type { HttpFetcher, InterruptSupport } from "./interrupt"

// The captain's desktop notification through the host's emit route
// (POST /api/notifications/emit — title and body, optional session id and
// directory context). Never throws: a missed notification must not fail the
// work it reports on. False leaves callers free to retry an undelivered alert.
export async function notifyCaptain(input: {
  fetcher: HttpFetcher
  support: InterruptSupport
  title: string
  body: string
  sessionId?: string
  directory?: string
}): Promise<boolean> {
  try {
    const outcome = await callDesktopProxy({
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
    return outcome.kind === "ok"
  } catch {
    return false
  }
}
