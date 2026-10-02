import { describe, expect, test } from "bun:test"
import { setSessionPermissionAuto } from "../service/permissions"
import type { HttpFetcher } from "../service/interrupt"

// The auto-accept call is a pure port: the fetcher is a fake, so no test
// touches the network or the real OpenChamber settings.

interface RecordedCall {
  url: string
  init: { method: string; headers: Record<string, string>; body?: string }
}

function recordingFetcher(answer: (call: RecordedCall) => { status: number } | "throw"): {
  fetcher: HttpFetcher
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  const fetcher: HttpFetcher = async (url, init) => {
    const call: RecordedCall = { url, init }
    calls.push(call)
    const result = answer(call)
    if (result === "throw") throw new Error("connection refused")
    return { status: result.status }
  }
  return { fetcher, calls }
}

const supported = { kind: "supported", port: 4096, token: "tok_local" } as const

describe("setSessionPermissionAuto", () => {
  test("puts mode auto and the directory on the desktop proxy with the local-client token", async () => {
    const { fetcher, calls } = recordingFetcher(() => ({ status: 200 }))

    const outcome = await setSessionPermissionAuto({
      fetcher,
      support: supported,
      sessionId: "ses_11bb",
      directory: "/repos/sunrise",
    })

    expect(outcome).toEqual({ kind: "ok" })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://127.0.0.1:4096/api/permission-auto-accept/sessions/ses_11bb")
    expect(calls[0].init.method).toBe("PUT")
    expect(calls[0].init.body).toBe(JSON.stringify({ mode: "auto", directory: "/repos/sunrise" }))
    expect(calls[0].init.headers["content-type"]).toBe("application/json")
    expect(calls[0].init.headers.authorization).toBe("Bearer tok_local")
  })

  test("sends no Authorization header when discovery found no token", async () => {
    const { fetcher, calls } = recordingFetcher(() => ({ status: 200 }))

    const outcome = await setSessionPermissionAuto({
      fetcher,
      support: { kind: "supported", port: 4096 },
      sessionId: "ses_11bb",
      directory: "/repos/sunrise",
    })

    expect(outcome).toEqual({ kind: "ok" })
    expect(calls).toHaveLength(1)
    expect(calls[0].init.headers.authorization).toBeUndefined()
  })

  test("a 401 or 403 auto-accept answer classifies as unsupported", async () => {
    for (const status of [401, 403]) {
      const { fetcher } = recordingFetcher(() => ({ status }))

      const outcome = await setSessionPermissionAuto({ fetcher, support: supported, sessionId: "ses_11bb", directory: "/repos/sunrise" })

      expect(outcome.kind).toBe("unsupported")
      if (outcome.kind === "unsupported") {
        expect(outcome.reason).toContain(`status ${status}`)
        expect(outcome.reason).toContain("credentials")
      }
    }
  })

  test("a non-2xx auto-accept answer is a failed outcome, not a throw", async () => {
    const { fetcher } = recordingFetcher(() => ({ status: 500 }))

    const outcome = await setSessionPermissionAuto({ fetcher, support: supported, sessionId: "ses_11bb", directory: "/repos/sunrise" })

    expect(outcome).toEqual({ kind: "failed", message: "the auto-accept call answered with status 500" })
  })

  test("a fetcher rejection is a failed outcome", async () => {
    const { fetcher } = recordingFetcher(() => "throw")

    const outcome = await setSessionPermissionAuto({ fetcher, support: supported, sessionId: "ses_11bb", directory: "/repos/sunrise" })

    expect(outcome).toEqual({ kind: "failed", message: "connection refused" })
  })

  test("an unsupported host is passed through without any network call", async () => {
    const { fetcher, calls } = recordingFetcher(() => ({ status: 200 }))

    const outcome = await setSessionPermissionAuto({
      fetcher,
      support: { kind: "unsupported", reason: "no settings" },
      sessionId: "ses_11bb",
      directory: "/repos/sunrise",
    })

    expect(outcome).toEqual({ kind: "unsupported", reason: "no settings" })
    expect(calls).toHaveLength(0)
  })
})
