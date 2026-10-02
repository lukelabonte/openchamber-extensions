import { describe, expect, test } from "bun:test"
import { discoverSupport, interruptWorker, type HttpFetcher } from "../service/interrupt"
import { InMemoryFileSystem } from "./helpers/in-memory-file-system"

// Discovery and the interrupt call are pure ports: the filesystem and the HTTP
// fetcher are fakes, so no test reads the real OpenChamber config or touches
// the network.

const settingsPath = "/config/openchamber/settings.json"

function filesystemWithSettings(contents: string | undefined): InMemoryFileSystem {
  const filesystem = new InMemoryFileSystem()
  if (contents !== undefined) filesystem.seedFile(settingsPath, contents)
  return filesystem
}

describe("discoverSupport", () => {
  test("reads the local port and client token from the OpenChamber settings file", async () => {
    const outcome = await discoverSupport({
      filesystem: filesystemWithSettings(JSON.stringify({ desktopLocalPort: 4096, desktopLocalClientToken: "tok_local" })).port,
      settingsPath,
    })

    expect(outcome).toEqual({ kind: "supported", port: 4096, token: "tok_local" })
  })

  test("a missing settings file is unsupported", async () => {
    const outcome = await discoverSupport({ filesystem: filesystemWithSettings(undefined).port, settingsPath })

    expect(outcome.kind).toBe("unsupported")
  })

  test("malformed JSON is unsupported", async () => {
    const outcome = await discoverSupport({ filesystem: filesystemWithSettings("{not json").port, settingsPath })

    expect(outcome.kind).toBe("unsupported")
  })

  test("a missing token is supported without auth", async () => {
    const outcome = await discoverSupport({
      filesystem: filesystemWithSettings(JSON.stringify({ desktopLocalPort: 4096 })).port,
      settingsPath,
    })

    expect(outcome).toEqual({ kind: "supported", port: 4096 })
  })

  test("missing port or a non-string token is unsupported", async () => {
    for (const contents of [
      "{}",
      JSON.stringify({ desktopLocalPort: "4096" }),
      JSON.stringify({ desktopLocalPort: 4096, desktopLocalClientToken: 42 }),
    ]) {
      const outcome = await discoverSupport({ filesystem: filesystemWithSettings(contents).port, settingsPath })
      expect(outcome.kind).toBe("unsupported")
    }
  })
})

interface RecordedCall {
  url: string
  init: { method: string; headers: Record<string, string> }
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

describe("interruptWorker", () => {
  test("posts the interrupt to the managed opencode server with the local-client token and directory", async () => {
    const { fetcher, calls } = recordingFetcher(() => ({ status: 200 }))

    const outcome = await interruptWorker({
      fetcher,
      support: supported,
      sessionId: "ses_11bb",
      directory: "/repos/sunrise",
    })

    expect(outcome).toEqual({ kind: "ok" })
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://127.0.0.1:4096/api/session/ses_11bb/interrupt?directory=%2Frepos%2Fsunrise")
    expect(calls[0].init.method).toBe("POST")
    expect(calls[0].init.headers.authorization).toBe("Bearer tok_local")
  })

  test("sends no Authorization header when discovery found no token", async () => {
    const { fetcher, calls } = recordingFetcher(() => ({ status: 200 }))

    const outcome = await interruptWorker({
      fetcher,
      support: { kind: "supported", port: 4096 },
      sessionId: "ses_11bb",
      directory: "/repos/sunrise",
    })

    expect(outcome).toEqual({ kind: "ok" })
    expect(calls).toHaveLength(1)
    expect(calls[0].init.headers.authorization).toBeUndefined()
  })

  test("a 401 or 403 interrupt answer classifies as unsupported", async () => {
    for (const status of [401, 403]) {
      const { fetcher } = recordingFetcher(() => ({ status }))

      const outcome = await interruptWorker({ fetcher, support: supported, sessionId: "ses_11bb", directory: "/repos/sunrise" })

      expect(outcome.kind).toBe("unsupported")
      if (outcome.kind === "unsupported") {
        expect(outcome.reason).toContain(`status ${status}`)
        expect(outcome.reason).toContain("credentials")
      }
    }
  })

  test("a non-2xx interrupt answer is a failed outcome, not a throw", async () => {
    const { fetcher } = recordingFetcher(() => ({ status: 500 }))

    const outcome = await interruptWorker({ fetcher, support: supported, sessionId: "ses_11bb", directory: "/repos/sunrise" })

    expect(outcome).toEqual({ kind: "failed", message: "the abort call answered with status 500" })
  })

  test("a fetcher rejection is a failed outcome", async () => {
    const { fetcher } = recordingFetcher(() => "throw")

    const outcome = await interruptWorker({ fetcher, support: supported, sessionId: "ses_11bb", directory: "/repos/sunrise" })

    expect(outcome).toEqual({ kind: "failed", message: "connection refused" })
  })

  test("an unsupported host is passed through without any network call", async () => {
    const { fetcher, calls } = recordingFetcher(() => ({ status: 200 }))

    const outcome = await interruptWorker({
      fetcher,
      support: { kind: "unsupported", reason: "no settings" },
      sessionId: "ses_11bb",
      directory: "/repos/sunrise",
    })

    expect(outcome).toEqual({ kind: "unsupported", reason: "no settings" })
    expect(calls).toHaveLength(0)
  })
})
