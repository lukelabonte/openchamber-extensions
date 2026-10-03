import { describe, expect, test } from "bun:test"
import type { HttpFetcher, HttpResult, InterruptSupport } from "../service/interrupt"
import { fetchSessionInfo } from "../service/session-observation"

const supported: InterruptSupport = { kind: "supported", port: 4096, token: "tok_local" }
const unsupportedSupport: InterruptSupport = { kind: "unsupported", reason: "no desktop port on this host" }

const sessionId = "ses_1"
const directory = "/repos/sunrise"

interface RecordedCall {
  url: string
  method: string
}

function fetcherShim(answer: (call: RecordedCall) => HttpResult | "throw"): { fetcher: HttpFetcher; calls: RecordedCall[] } {
  const calls: RecordedCall[] = []
  const fetcher: HttpFetcher = async (url, init) => {
    calls.push({ url, method: init.method })
    const result = answer({ url, method: init.method })
    if (result === "throw") throw new Error("connection refused")
    return result
  }
  return { fetcher, calls }
}

const okBody = (text: string): HttpResult => ({ status: 200, text: async () => text })

// The authoritative failure source: one GET of the managed opencode server's
// unwrapped single Session.Info per worker, read through the desktop proxy.
// Every failure mode answers its own result kind — never a throw.
describe("fetchSessionInfo", () => {
  test("GETs the unwrapped single session info with the id and directory percent-encoded", async () => {
    const { fetcher, calls } = fetcherShim(() => okBody('{"id":"ses/a b","outcome":"failed","time":{"idle":123}}'))

    const result = await fetchSessionInfo({ fetcher, support: supported, sessionId: "ses/a b", directory: "/repos/sun rise" })

    expect(calls).toEqual([
      { url: "http://127.0.0.1:4096/api/session/ses%2Fa%20b?directory=%2Frepos%2Fsun%20rise", method: "GET" },
    ])
    expect(result).toEqual({ kind: "ok", info: { id: "ses/a b", outcome: "failed", time: { idle: 123 } } })
  })

  test("all three terminal outcomes round-trip, and absent optionals stay absent", async () => {
    for (const outcome of ["succeeded", "failed", "interrupted"] as const) {
      const { fetcher } = fetcherShim(() => okBody(JSON.stringify({ id: sessionId, outcome, time: { idle: 5 } })))
      expect(await fetchSessionInfo({ fetcher, support: supported, sessionId, directory })).toEqual({
        kind: "ok",
        info: { id: sessionId, outcome, time: { idle: 5 } },
      })
    }

    const withoutOutcome = fetcherShim(() => okBody('{"id":"ses_1","time":{}}'))
    expect(await fetchSessionInfo({ fetcher: withoutOutcome.fetcher, support: supported, sessionId, directory })).toEqual({
      kind: "ok",
      info: { id: sessionId, time: {} },
    })

    // null reads as absent for both optionals, and a finite zero idle is kept.
    const withNulls = fetcherShim(() => okBody('{"id":"ses_1","outcome":null,"time":{"idle":null}}'))
    expect(await fetchSessionInfo({ fetcher: withNulls.fetcher, support: supported, sessionId, directory })).toEqual({
      kind: "ok",
      info: { id: sessionId, time: {} },
    })

    const withZeroIdle = fetcherShim(() => okBody('{"id":"ses_1","time":{"idle":0}}'))
    expect(await fetchSessionInfo({ fetcher: withZeroIdle.fetcher, support: supported, sessionId, directory })).toEqual({
      kind: "ok",
      info: { id: sessionId, time: { idle: 0 } },
    })
  })

  // The second confirmed live shape: the same record wrapped as
  // { data: { ... } } from the authless desktop port. The envelope unwraps
  // only when the top level carries no id of its own, and the data record
  // then passes the same strict guards.
  test("a wrapped data record with no outcome answers ok exactly like the unwrapped shape", async () => {
    const busyIdle = fetcherShim(() => okBody('{"data":{"id":"ses_1","time":{}}}'))
    expect(await fetchSessionInfo({ fetcher: busyIdle.fetcher, support: supported, sessionId, directory })).toEqual({
      kind: "ok",
      info: { id: sessionId, time: {} },
    })

    const idleWithoutOutcome = fetcherShim(() => okBody('{"data":{"id":"ses_1","time":{"idle":5}}}'))
    expect(await fetchSessionInfo({ fetcher: idleWithoutOutcome.fetcher, support: supported, sessionId, directory })).toEqual({
      kind: "ok",
      info: { id: sessionId, time: { idle: 5 } },
    })
  })

  test("all three terminal outcomes round-trip identically through the wrapped envelope", async () => {
    for (const outcome of ["succeeded", "failed", "interrupted"] as const) {
      const { fetcher } = fetcherShim(() => okBody(JSON.stringify({ data: { id: sessionId, outcome, time: { idle: 5 } } })))
      expect(await fetchSessionInfo({ fetcher, support: supported, sessionId, directory })).toEqual({
        kind: "ok",
        info: { id: sessionId, outcome, time: { idle: 5 } },
      })
    }
  })

  test("a data value that is not a record is rejected, never defaulted through", async () => {
    for (const data of [[], null, "nope"]) {
      const { fetcher } = fetcherShim(() => okBody(JSON.stringify({ data })))

      const result = await fetchSessionInfo({ fetcher, support: supported, sessionId, directory })

      expect(result.kind).toBe("failed")
      if (result.kind === "failed") {
        expect(result.reason).toContain("did not name the requested session")
      }
    }
  })

  test("a wrapped data record naming a different session is rejected", async () => {
    const { fetcher } = fetcherShim(() => okBody('{"data":{"id":"ses_other","outcome":"failed","time":{"idle":1}}}'))

    const result = await fetchSessionInfo({ fetcher, support: supported, sessionId, directory })

    expect(result.kind).toBe("failed")
    if (result.kind === "failed") {
      expect(result.reason).toContain("did not name the requested session")
    }
  })

  test("a conflicting top-level string id is not overridden by a valid data record", async () => {
    const { fetcher } = fetcherShim(() => okBody('{"id":"ses_other","data":{"id":"ses_1","outcome":"failed","time":{"idle":1}}}'))

    const result = await fetchSessionInfo({ fetcher, support: supported, sessionId, directory })

    expect(result.kind).toBe("failed")
    if (result.kind === "failed") {
      expect(result.reason).toContain("did not name the requested session")
    }
  })

  test("malformed time and time.idle inside the wrapped data record are rejected", async () => {
    const noTime = fetcherShim(() => okBody('{"data":{"id":"ses_1","outcome":"failed"}}'))
    const noTimeResult = await fetchSessionInfo({ fetcher: noTime.fetcher, support: supported, sessionId, directory })
    expect(noTimeResult.kind).toBe("failed")
    if (noTimeResult.kind === "failed") {
      expect(noTimeResult.reason).toContain("no time object")
    }

    const badIdle = fetcherShim(() => okBody('{"data":{"id":"ses_1","time":{"idle":"123"}}}'))
    const badIdleResult = await fetchSessionInfo({ fetcher: badIdle.fetcher, support: supported, sessionId, directory })
    expect(badIdleResult.kind).toBe("failed")
    if (badIdleResult.kind === "failed") {
      expect(badIdleResult.reason).toContain("malformed time.idle")
    }
  })

  test("an outcome outside the schema's three terminals is not a terminal to act on", async () => {
    const { fetcher } = fetcherShim(() => okBody('{"id":"ses_1","outcome":"resumed","time":{"idle":5}}'))

    expect(await fetchSessionInfo({ fetcher, support: supported, sessionId, directory })).toEqual({
      kind: "ok",
      info: { id: sessionId, time: { idle: 5 } },
    })
  })

  test("every malformed body answers failed with its own reason and never throws", async () => {
    const malformedBodies: { text: string; reason: string }[] = [
      { text: "not json", reason: "not valid JSON" },
      { text: '"just a string"', reason: "not a JSON object" },
      { text: "[]", reason: "not a JSON object" },
      { text: '{"id":"ses_other","outcome":"failed","time":{"idle":1}}', reason: "did not name the requested session" },
      { text: '{"outcome":"failed","time":{"idle":1}}', reason: "did not name the requested session" },
      { text: '{"id":"ses_1"}', reason: "no time object" },
      { text: '{"id":"ses_1","time":"nope"}', reason: "no time object" },
      { text: '{"id":"ses_1","time":{"idle":"123"}}', reason: "malformed time.idle" },
      { text: '{"id":"ses_1","time":{"idle":1e999}}', reason: "malformed time.idle" },
      { text: '{"id":"ses_1","outcome":"failed","time":{"idle":"123"}}', reason: "malformed time.idle" },
    ]
    for (const malformed of malformedBodies) {
      const { fetcher } = fetcherShim(() => okBody(malformed.text))

      const result = await fetchSessionInfo({ fetcher, support: supported, sessionId, directory })

      expect(result.kind).toBe("failed")
      if (result.kind === "failed") {
        expect(result.reason).toContain(malformed.reason)
      }
    }
  })

  test("an unsupported host answers unsupported without touching the network", async () => {
    const { fetcher, calls } = fetcherShim(() => okBody("{}"))

    const result = await fetchSessionInfo({ fetcher, support: unsupportedSupport, sessionId, directory })

    expect(result).toEqual({ kind: "unsupported", reason: "no desktop port on this host" })
    expect(calls).toEqual([])
  })

  test("401 and 403 classify as unsupported, any other status and transport errors as failed, and an unreadable 2xx body as failed", async () => {
    for (const status of [401, 403]) {
      const { fetcher, calls } = fetcherShim(() => ({ status }))
      const result = await fetchSessionInfo({ fetcher, support: supported, sessionId, directory })
      expect(calls).toHaveLength(1)
      expect(result.kind).toBe("unsupported")
      if (result.kind === "unsupported") expect(result.reason).toContain("credentials")
    }

    const notFound = fetcherShim(() => ({ status: 404 }))
    const notFoundResult = await fetchSessionInfo({ fetcher: notFound.fetcher, support: supported, sessionId, directory })
    expect(notFoundResult.kind).toBe("failed")
    if (notFoundResult.kind === "failed") expect(notFoundResult.reason).toContain("404")

    const refused = fetcherShim(() => "throw")
    const refusedResult = await fetchSessionInfo({ fetcher: refused.fetcher, support: supported, sessionId, directory })
    expect(refusedResult.kind).toBe("failed")
    if (refusedResult.kind === "failed") expect(refusedResult.reason).toBe("connection refused")

    const unreadable = fetcherShim(() => ({ status: 200 }))
    const unreadableResult = await fetchSessionInfo({ fetcher: unreadable.fetcher, support: supported, sessionId, directory })
    expect(unreadableResult.kind).toBe("failed")
    if (unreadableResult.kind === "failed") expect(unreadableResult.reason).toContain("could not be read")
  })
})
