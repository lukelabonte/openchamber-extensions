import { describe, expect, test } from "bun:test"
import { archivePath, archiveSession } from "../service/archive"
import { parseBacklog, type BacklogTask } from "../service/backlog"
import type { ExecRunner } from "../service/control-client"
import type { FileSystemPort } from "../service/file-system"
import type { HttpFetcher, InterruptSupport } from "../service/interrupt"
import { createSupervisionPoller } from "../service/poller"
import { InMemoryFileSystem } from "./helpers/in-memory-file-system"

const homeRoot = "/home/firstmate"
const projectDirectory = "/repos/sunrise"
const worktreeDirectory = "/repos/sunrise/.worktrees/fm/login-fix"

// A fixed epoch every test's fake clock starts from — no test ever reads the
// real clock.
const t0 = 1_760_000_000_000
const iso = (ms: number): string => new Date(ms).toISOString()

const workerBacklog = ["- Fix flaky login test", "  state: Working", "  session: ses_11bb"].join("\n")

// The control client builds the attested CLI argv, so the fakes dispatch on
// that layout (same shape as poller.test.ts): the subcommand sits at args[1]
// behind "session" and the session id follows "--session".
function subcommand(args: readonly string[]): string {
  return args[0] === "session" ? (args[1] ?? "") : ""
}

function sessionArg(args: readonly string[]): string | undefined {
  const index = args.indexOf("--session")
  return index === -1 ? undefined : args[index + 1]
}

function scriptExec(script: (args: readonly string[]) => string): { exec: ExecRunner; calls: string[][] } {
  const calls: string[][] = []
  const exec: ExecRunner = async (_command, args) => {
    calls.push([...args])
    return script(args)
  }
  return { exec, calls }
}

function idleExec(): { exec: ExecRunner } {
  const { exec } = scriptExec((args) => (subcommand(args) === "status" ? '{"type":"idle"}' : '{"text":"the last word"}'))
  return { exec }
}

function busyExec(): { exec: ExecRunner; calls: string[][] } {
  return scriptExec((args) => (subcommand(args) === "status" ? '{"sessionStatus":{"type":"busy"}}' : '{"text":"the last word"}'))
}

// A controllable clock: the poller reads nowMs() during each poll and tests
// advance it explicitly, so every threshold and timestamp is deterministic.
class FakeClock {
  currentMs: number

  constructor(startMs: number) {
    this.currentMs = startMs
  }

  nowMs = (): number => this.currentMs

  advance(ms: number): void {
    this.currentMs += ms
  }
}

// The runtime-verified `session messages --last-assistant --json` shape;
// optional identity fields are omitted when absent, like real host output.
function lastAssistantMessage(input: { id?: string; createdAt?: number; completedAt?: number; text: string }): string {
  return JSON.stringify({
    status: "ok",
    sessionId: "ses_11bb",
    directory: projectDirectory,
    role: "assistant",
    sessionStatus: { type: "busy" },
    messages: [
      {
        ...(input.id !== undefined ? { id: input.id } : {}),
        role: "assistant",
        ...(input.createdAt !== undefined ? { createdAt: input.createdAt } : {}),
        ...(input.completedAt !== undefined ? { completedAt: input.completedAt } : {}),
        model: "test-model",
        text: input.text,
      },
    ],
  })
}

interface RecordedCall {
  url: string
  init: { method: string; body?: string }
}

type HostAnswer = { status: number; text?: string } | "throw"

// A per-URL recording fetcher: the round-level pending snapshot, each
// worker's authoritative session-info read, the auto-accept PUT, and the
// captain emit each answer from one routes table, so every test runs without
// host traffic. Routes are read at call time — tests flip them between polls.
function hostFetcher(routes: { snapshot?: HostAnswer; info?: HostAnswer } = {}): {
  fetcher: HttpFetcher
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  const fetcher: HttpFetcher = async (url, init) => {
    calls.push({ url, init: { method: init.method, ...(init.body !== undefined ? { body: init.body } : {}) } })
    const answer = route(url, init.method)
    if (answer === "throw") throw new Error("connection refused")
    const { status, text } = answer
    return { status, ...(text === undefined ? {} : { text: async () => text }) }
  }
  function route(url: string, method: string): HostAnswer {
    if (method === "GET" && url.endsWith("/api/sessions/status")) {
      return routes.snapshot ?? { status: 200, text: '{"pending":{}}' }
    }
    if (method === "GET" && url.includes("/api/session/")) {
      return routes.info ?? { status: 200, text: JSON.stringify({ id: sessionIdFromInfoUrl(url), time: {} }) }
    }
    return { status: 200 }
  }
  return { fetcher, calls }
}

function sessionIdFromInfoUrl(url: string): string {
  const match = /\/api\/session\/([^?]+)\?/.exec(url)
  return match === null ? "" : decodeURIComponent(match[1] ?? "")
}

const infoUrl = (sessionId: string, directory: string): string =>
  `http://127.0.0.1:4096/api/session/${encodeURIComponent(sessionId)}?directory=${encodeURIComponent(directory)}`

const infoCalls = (calls: RecordedCall[]): RecordedCall[] =>
  calls.filter((call) => call.init.method === "GET" && call.url.includes("/api/session/"))
const emitCalls = (calls: RecordedCall[]): RecordedCall[] => calls.filter((call) => call.url.endsWith("/api/notifications/emit"))

function makePoller(input: {
  filesystem: FileSystemPort
  exec: ExecRunner
  fetcher?: HttpFetcher
  resolveSupport?: () => Promise<InterruptSupport>
  clock: FakeClock
}): ReturnType<typeof createSupervisionPoller> {
  return createSupervisionPoller({
    homeRoot,
    filesystem: input.filesystem,
    exec: input.exec,
    fetcher: input.fetcher ?? (async () => ({ status: 200 })),
    // A supported proxy carrying a token, so any reason-string leak of the
    // local-client token would be caught by the sanitization test.
    resolveSupport: input.resolveSupport ?? (async () => ({ kind: "supported", port: 4096, token: "tok_local_secret" })),
    nowMs: input.clock.nowMs,
  })
}

function seededProject(backlog: string = workerBacklog): InMemoryFileSystem {
  const filesystem = new InMemoryFileSystem()
  filesystem.seedFile(
    `${homeRoot}/registry.json`,
    JSON.stringify({
      sunrise: {
        slug: "sunrise",
        projectDirectory,
        homeDirectory: `${homeRoot}/projects/sunrise`,
        coordinatorSessionId: "ses_coord_1",
        createdAt: "2026-10-01T08:00:00Z",
      },
    }),
  )
  filesystem.seedFile(`${homeRoot}/projects/sunrise/backlog.md`, backlog)
  return filesystem
}

function backlogTasks(filesystem: InMemoryFileSystem): BacklogTask[] {
  return parseBacklog(filesystem.fileContents(`${homeRoot}/projects/sunrise/backlog.md`)).tasks
}

describe("supervision health record", () => {
  test("a never-polled slug reads the initial unknown record, which no caller can mutate either", () => {
    const filesystem = new InMemoryFileSystem()
    const poller = makePoller({ filesystem: filesystem.port, exec: idleExec().exec, clock: new FakeClock(t0) })

    const initial = poller.getSupervisionHealth("sunrise")
    expect(initial).toEqual({
      blockedObservation: "unavailable",
      blockedObservationReason: "Not polled yet",
      failureObservation: "unavailable",
      failureObservationReason: "Not polled yet",
    })
    expect(initial.lastSuccessfulPollAt).toBeUndefined()

    initial.blockedObservation = "working"
    initial.lastSuccessfulPollAt = "tampered"
    expect(poller.getSupervisionHealth("sunrise")).toEqual({
      blockedObservation: "unavailable",
      blockedObservationReason: "Not polled yet",
      failureObservation: "unavailable",
      failureObservationReason: "Not polled yet",
    })
  })

  test("a clean round records both channels working with the poll time, and the stored record resists caller mutation", async () => {
    const filesystem = seededProject()
    const { fetcher } = hostFetcher()
    const poller = makePoller({ filesystem: filesystem.port, exec: idleExec().exec, fetcher, clock: new FakeClock(t0) })

    await poller.poll()

    const recorded = poller.getSupervisionHealth("sunrise")
    expect(recorded).toEqual({
      blockedObservation: "working",
      failureObservation: "working",
      lastSuccessfulPollAt: iso(t0),
    })
    expect(recorded.blockedObservationReason).toBeUndefined()

    recorded.failureObservation = "degraded"
    recorded.lastSuccessfulPollAt = "tampered"
    expect(poller.getSupervisionHealth("sunrise")).toEqual({
      blockedObservation: "working",
      failureObservation: "working",
      lastSuccessfulPollAt: iso(t0),
    })
  })

  test("a snapshot transport failure or a malformed payload reads the blocked observation degraded, with a reason and no clean stamp", async () => {
    const brokenSnapshots: HostAnswer[] = [
      "throw",
      { status: 200, text: "not json" },
      { status: 200, text: '"just a string"' },
      // The nested pending map itself is null / an array: malformed, not clean.
      { status: 200, text: '{"pending":null}' },
      { status: 200, text: '{"pending":[]}' },
    ]
    for (const snapshot of brokenSnapshots) {
      const filesystem = seededProject()
      const { fetcher } = hostFetcher({ snapshot })
      const poller = makePoller({ filesystem: filesystem.port, exec: idleExec().exec, fetcher, clock: new FakeClock(t0) })

      await poller.poll()

      const health = poller.getSupervisionHealth("sunrise")
      expect(health.blockedObservation).toBe("degraded")
      expect(health.blockedObservationReason).toBeDefined()
      // The authoritative-failure channel read fine this round; only the
      // blocked channel is degraded.
      expect(health.failureObservation).toBe("working")
      expect(health.lastSuccessfulPollAt).toBeUndefined()
    }
  })

  test("a host without the proxy leaves both observations unavailable and still stamps the CLI-only round clean", async () => {
    const filesystem = seededProject()
    const poller = makePoller({
      filesystem: filesystem.port,
      exec: idleExec().exec,
      resolveSupport: async () => ({ kind: "unsupported", reason: "the OpenChamber settings file could not be read" }),
      clock: new FakeClock(t0),
    })

    await poller.poll()

    expect(poller.getSupervisionHealth("sunrise")).toEqual({
      blockedObservation: "unavailable",
      blockedObservationReason: "the OpenChamber settings file could not be read",
      failureObservation: "unavailable",
      failureObservationReason: "the OpenChamber settings file could not be read",
      lastSuccessfulPollAt: iso(t0),
    })
  })

  test("a proxy support resolution failure reads both observations unavailable without failing the round", async () => {
    const filesystem = seededProject()
    const poller = makePoller({
      filesystem: filesystem.port,
      exec: idleExec().exec,
      resolveSupport: async () => {
        throw new Error("discovery exploded")
      },
      clock: new FakeClock(t0),
    })

    const round = await poller.poll()

    expect(round.notifications).toHaveLength(1) // the round itself survives
    const health = poller.getSupervisionHealth("sunrise")
    expect(health.blockedObservation).toBe("unavailable")
    expect(health.failureObservation).toBe("unavailable")
    expect(health.lastSuccessfulPollAt).toBe(iso(t0))
  })

  test("malformed pending map entries read degraded — never claiming a clean channel, never crashing the round", async () => {
    // The host's per-session entries are untrusted JSON: a null entry, an
    // entry that is itself an array, and an entry whose permission list is
    // not an array are all malformed pending observations. The channel must
    // say so, no worker may be claimed blocked by garbage, and the round must
    // survive.
    for (const pending of [{ ses_11bb: null }, { ses_11bb: ["not", "a", "record"] }, { ses_11bb: { permissions: "garbage" } }]) {
      const filesystem = seededProject()
      const { fetcher, calls } = hostFetcher({ snapshot: { status: 200, text: JSON.stringify({ pending }) } })
      const poller = makePoller({ filesystem: filesystem.port, exec: idleExec().exec, fetcher, clock: new FakeClock(t0) })

      const round = await poller.poll() // must survive the garbage entry

      const health = poller.getSupervisionHealth("sunrise")
      expect(health.blockedObservation).toBe("degraded")
      expect(health.blockedObservationReason).toBeDefined()
      expect(poller.getBoardWorkers("sunrise", backlogTasks(filesystem))[0]?.blockedReason).toBeUndefined()
      expect(round.notifications.every((notification) => !notification.message.includes("failed (outcome"))).toBe(true)
      expect(emitCalls(calls)).toHaveLength(0)
    }
  })

  test("supervision health is per project: each slug records its own clean poll", async () => {
    const filesystem = new InMemoryFileSystem()
    filesystem.seedFile(
      `${homeRoot}/registry.json`,
      JSON.stringify({
        sunrise: {
          slug: "sunrise",
          projectDirectory,
          homeDirectory: `${homeRoot}/projects/sunrise`,
          coordinatorSessionId: "ses_coord_1",
          createdAt: "2026-10-01T08:00:00Z",
        },
        sunset: {
          slug: "sunset",
          projectDirectory: "/repos/sunset",
          homeDirectory: `${homeRoot}/projects/sunset`,
          coordinatorSessionId: "ses_coord_2",
          createdAt: "2026-10-01T08:00:00Z",
        },
      }),
    )
    filesystem.seedFile(`${homeRoot}/projects/sunrise/backlog.md`, workerBacklog)
    filesystem.seedFile(
      `${homeRoot}/projects/sunset/backlog.md`,
      ["- Sunset task", "  state: Working", "  session: ses_sunset"].join("\n"),
    )
    let failSunsetStatus = true
    const { exec } = scriptExec((args) => {
      if (subcommand(args) !== "status") return '{"text":"the last word"}'
      if (failSunsetStatus && sessionArg(args) === "ses_sunset") throw new Error("openchamber exited with code 1: no such session")
      return '{"type":"idle"}'
    })
    const clock = new FakeClock(t0)
    const { fetcher } = hostFetcher()
    const poller = makePoller({ filesystem: filesystem.port, exec, fetcher, clock })

    await poller.poll()

    const sunrise = poller.getSupervisionHealth("sunrise")
    expect(sunrise.lastSuccessfulPollAt).toBe(iso(t0))
    expect(sunrise.blockedObservation).toBe("working")
    expect(sunrise.failureObservation).toBe("working")

    const sunset = poller.getSupervisionHealth("sunset")
    expect(sunset.lastSuccessfulPollAt).toBeUndefined()
    // The CLI is not one of the two host-observation channels: a CLI failure
    // withholds the clean-poll stamp without degrading either channel.
    expect(sunset.blockedObservation).toBe("working")
    expect(sunset.failureObservation).toBe("working")

    failSunsetStatus = false
    clock.advance(60_000)
    await poller.poll()
    expect(poller.getSupervisionHealth("sunrise").lastSuccessfulPollAt).toBe(iso(t0 + 60_000))
    expect(poller.getSupervisionHealth("sunset").lastSuccessfulPollAt).toBe(iso(t0 + 60_000))
  })

  test("a failed backlog read keeps the previous health record whole", async () => {
    const filesystem = seededProject()
    const clock = new FakeClock(t0)
    const { fetcher } = hostFetcher()
    const poller = makePoller({ filesystem: filesystem.port, exec: idleExec().exec, fetcher, clock })

    await poller.poll()
    const recorded = poller.getSupervisionHealth("sunrise")
    expect(recorded.lastSuccessfulPollAt).toBe(iso(t0))

    // A directory node makes the backlog read fail while existing().
    filesystem.seedDirectory(`${homeRoot}/projects/sunrise/backlog.md`)
    clock.advance(60_000)
    await poller.poll()

    expect(poller.getSupervisionHealth("sunrise")).toEqual(recorded)
  })

  test("a failed archive read keeps the previous health record whole", async () => {
    const filesystem = seededProject()
    await archiveSession(filesystem.port, homeRoot, "sunrise", {
      sessionId: "ses_11bb",
      title: "Fix flaky login test",
      archivedAt: "2026-10-01T09:00:00.000Z",
    })
    let breakArchive = false
    const brokenPort: FileSystemPort = {
      ...filesystem.port,
      readFile: async (filePath) => {
        if (breakArchive && filePath === archivePath(homeRoot, "sunrise")) throw new Error("disk gone")
        return filesystem.port.readFile(filePath)
      },
    }
    const clock = new FakeClock(t0)
    const { fetcher } = hostFetcher()
    const poller = makePoller({ filesystem: brokenPort, exec: idleExec().exec, fetcher, clock })

    await poller.poll()
    const recorded = poller.getSupervisionHealth("sunrise")
    expect(recorded.lastSuccessfulPollAt).toBe(iso(t0))

    breakArchive = true
    clock.advance(60_000)
    await poller.poll()

    expect(poller.getSupervisionHealth("sunrise")).toEqual(recorded)
  })

  test("a CLI observation failure keeps the prior clean-poll timestamp without degrading either host channel", async () => {
    const filesystem = seededProject()
    let failStatus = false
    const { exec } = scriptExec((args) => {
      if (subcommand(args) === "status" && failStatus) throw new Error("openchamber exited with code 1: no such session")
      return subcommand(args) === "status" ? '{"type":"idle"}' : '{"text":"the last word"}'
    })
    const clock = new FakeClock(t0)
    const { fetcher } = hostFetcher()
    const poller = makePoller({ filesystem: filesystem.port, exec, fetcher, clock })

    await poller.poll()
    expect(poller.getSupervisionHealth("sunrise").lastSuccessfulPollAt).toBe(iso(t0))

    failStatus = true
    clock.advance(60_000)
    await poller.poll()

    const health = poller.getSupervisionHealth("sunrise")
    expect(health.lastSuccessfulPollAt).toBe(iso(t0))
    expect(health.blockedObservation).toBe("working")
    expect(health.failureObservation).toBe("working")
  })

  test("host observation failures keep the prior clean-poll timestamp and classify the channel they broke", async () => {
    const filesystem = seededProject()
    const routes: { snapshot?: HostAnswer; info?: HostAnswer } = {}
    const { fetcher } = hostFetcher(routes)
    const clock = new FakeClock(t0)
    const poller = makePoller({ filesystem: filesystem.port, exec: idleExec().exec, fetcher, clock })

    await poller.poll()
    expect(poller.getSupervisionHealth("sunrise").lastSuccessfulPollAt).toBe(iso(t0))

    routes.info = { status: 200, text: "not json" }
    clock.advance(60_000)
    await poller.poll()
    let health = poller.getSupervisionHealth("sunrise")
    expect(health.failureObservation).toBe("degraded")
    expect(health.failureObservationReason).toBeDefined()
    expect(health.blockedObservation).toBe("working")
    expect(health.lastSuccessfulPollAt).toBe(iso(t0))

    routes.info = undefined
    routes.snapshot = "throw"
    clock.advance(60_000)
    await poller.poll()
    health = poller.getSupervisionHealth("sunrise")
    expect(health.blockedObservation).toBe("degraded")
    expect(health.blockedObservationReason).toBeDefined()
    // The failure channel read clean again this round — states describe this
    // round only.
    expect(health.failureObservation).toBe("working")
    expect(health.lastSuccessfulPollAt).toBe(iso(t0))
  })

  test("health reasons stay sanitized: no local-client token and no raw host body reaches them", async () => {
    const filesystem = seededProject()
    const leakedBody = 'tok_supersecret "pending":{"ses_11bb":"everything"} Authorization: Bearer tok_supersecret'
    const routes: { snapshot?: HostAnswer; info?: HostAnswer } = {
      snapshot: { status: 500, text: leakedBody },
      info: { status: 500, text: leakedBody },
    }
    const { fetcher } = hostFetcher(routes)
    const poller = makePoller({ filesystem: filesystem.port, exec: idleExec().exec, fetcher, clock: new FakeClock(t0) })

    const assertReasonsClean = (): void => {
      const health = poller.getSupervisionHealth("sunrise")
      for (const reason of [health.blockedObservationReason, health.failureObservationReason]) {
        expect(reason).toBeDefined()
        expect(reason).not.toContain("tok_")
        expect(reason).not.toContain("everything")
        expect(reason).not.toContain("Bearer")
      }
    }

    await poller.poll()
    assertReasonsClean()

    // The same leak on a 2xx malformed body stays out of the reasons too.
    routes.snapshot = { status: 200, text: leakedBody }
    routes.info = { status: 200, text: leakedBody }
    await poller.poll()
    assertReasonsClean()
  })
})

describe("failed terminal observation", () => {
  test("an idle worker with an explicit failed outcome keyed by a finite time.idle reports failed once — coordinator message, captain POST, and board Failed", async () => {
    const filesystem = seededProject()
    const routes: { info?: HostAnswer } = {
      info: { status: 200, text: JSON.stringify({ id: "ses_11bb", outcome: "failed", time: { idle: 123 } }) },
    }
    const { fetcher, calls } = hostFetcher(routes)
    const poller = makePoller({ filesystem: filesystem.port, exec: idleExec().exec, fetcher, clock: new FakeClock(t0) })

    const round = await poller.poll()

    expect(round.notifications).toHaveLength(1)
    expect(round.notifications[0]?.message).toContain("failed (outcome: failed).")
    // A failed turn never also reports finished — that would contradict the
    // failure.
    expect(round.notifications[0]?.message).not.toContain("finished its turn")

    const emits = emitCalls(calls)
    expect(emits).toHaveLength(1)
    expect(JSON.parse(emits[0]?.init.body ?? "{}")).toEqual({
      title: "FirstMate — sunrise",
      body: '"Fix flaky login test" failed.',
      sessionId: "ses_11bb",
      directory: projectDirectory,
    })

    expect(poller.getBoardWorkers("sunrise", backlogTasks(filesystem))[0]?.state).toBe("Failed")

    // The same terminal re-observed on the next poll is quiet again.
    const second = await poller.poll()
    expect(second.notifications).toEqual([])
    expect(emitCalls(calls)).toHaveLength(1)
  })

  test("a DISTINCT second failed terminal re-notifies even with no intermediate succeeded outcome", async () => {
    const filesystem = seededProject()
    const routes: { info?: HostAnswer } = {
      info: { status: 200, text: JSON.stringify({ id: "ses_11bb", outcome: "failed", time: { idle: 123 } }) },
    }
    const { fetcher, calls } = hostFetcher(routes)
    const poller = makePoller({ filesystem: filesystem.port, exec: idleExec().exec, fetcher, clock: new FakeClock(t0) })
    await poller.poll()

    // A new time.idle is a second failed turn: the worker ran and failed
    // again — no intermediate succeeded outcome is needed for the re-notify.
    routes.info = { status: 200, text: JSON.stringify({ id: "ses_11bb", outcome: "failed", time: { idle: 456 } }) }
    const second = await poller.poll()

    expect(second.notifications).toHaveLength(1)
    expect(second.notifications[0]?.message).toContain("failed (outcome: failed).")
    expect(emitCalls(calls)).toHaveLength(2)
  })

  test("a busy worker with an old failed outcome must not board Failed nor notify", async () => {
    const filesystem = seededProject()
    const { fetcher, calls } = hostFetcher({
      info: { status: 200, text: JSON.stringify({ id: "ses_11bb", outcome: "failed", time: { idle: 123 } }) },
    })
    const poller = makePoller({ filesystem: filesystem.port, exec: busyExec().exec, fetcher, clock: new FakeClock(t0) })

    const round = await poller.poll()

    // The outcome is the LAST completed execution and persists while the
    // session runs again — a busy worker's failed outcome is stale history.
    expect(round.notifications).toEqual([])
    expect(emitCalls(calls)).toHaveLength(0)
    expect(poller.getBoardWorkers("sunrise", backlogTasks(filesystem))[0]?.state).toBe("Working")
  })

  test("busy then idle with the SAME previous failed time.idle must not re-notify the historical outcome", async () => {
    // The host schema keeps the LAST completed execution while the session
    // runs again: a failed terminal seen during a busy round is history, and
    // the idle round that re-observes the SAME time.idle must stay quiet —
    // nothing new failed between the rounds.
    const filesystem = seededProject()
    const { fetcher, calls } = hostFetcher({
      info: { status: 200, text: JSON.stringify({ id: "ses_11bb", outcome: "failed", time: { idle: 123 } }) },
    })
    let busy = true
    const { exec } = scriptExec((args) =>
      subcommand(args) === "status" ? (busy ? '{"sessionStatus":{"type":"busy"}}' : '{"type":"idle"}') : '{"text":"the last word"}',
    )
    const poller = makePoller({ filesystem: filesystem.port, exec, fetcher, clock: new FakeClock(t0) })

    await poller.poll() // busy: the stale failed outcome must not fire
    busy = false
    const idleRound = await poller.poll()

    expect(idleRound.notifications).toEqual([])
    expect(emitCalls(calls)).toHaveLength(0)
  })

  test("an interrupted terminal is never a failure", async () => {
    const filesystem = seededProject()
    const { fetcher, calls } = hostFetcher({
      info: { status: 200, text: JSON.stringify({ id: "ses_11bb", outcome: "interrupted", time: { idle: 5 } }) },
    })
    const poller = makePoller({ filesystem: filesystem.port, exec: idleExec().exec, fetcher, clock: new FakeClock(t0) })

    const round = await poller.poll()

    expect(round.notifications[0]?.message).toContain("finished its turn")
    expect(round.notifications[0]?.message).not.toContain("failed")
    expect(emitCalls(calls)).toHaveLength(0)
    expect(poller.getBoardWorkers("sunrise", backlogTasks(filesystem))[0]?.state).toBe("Idle")
  })

  test("a failure is never inferred from an idle activity or a failure-sounding last message", async () => {
    const filesystem = seededProject()
    const { exec } = scriptExec((args) =>
      subcommand(args) === "status" ? '{"type":"idle"}' : '{"text":"the build FAILED with exit code 1"}',
    )
    const { fetcher, calls } = hostFetcher() // session info carries no outcome yet
    const poller = makePoller({ filesystem: filesystem.port, exec, fetcher, clock: new FakeClock(t0) })

    const round = await poller.poll()

    expect(round.notifications[0]?.message).not.toContain("failed (outcome")
    expect(emitCalls(calls)).toHaveLength(0)
    expect(poller.getBoardWorkers("sunrise", backlogTasks(filesystem))[0]?.state).not.toBe("Failed")
  })

  test("a 401, unreachable, malformed, or id-mismatched session-info read fakes no failed outcome and classifies the channel", async () => {
    const variants: { info: HostAnswer; expectedFailureState: "unavailable" | "degraded" }[] = [
      { info: { status: 401 }, expectedFailureState: "unavailable" },
      { info: { status: 403 }, expectedFailureState: "unavailable" },
      { info: "throw", expectedFailureState: "degraded" },
      { info: { status: 200, text: "not json" }, expectedFailureState: "degraded" },
      {
        info: { status: 200, text: JSON.stringify({ id: "ses_other", outcome: "failed", time: { idle: 123 } }) },
        expectedFailureState: "degraded",
      },
    ]
    for (const variant of variants) {
      const filesystem = seededProject()
      const { fetcher, calls } = hostFetcher({ info: variant.info })
      const poller = makePoller({ filesystem: filesystem.port, exec: idleExec().exec, fetcher, clock: new FakeClock(t0) })

      const round = await poller.poll()

      expect(round.notifications[0]?.message).not.toContain("failed (outcome")
      expect(emitCalls(calls)).toHaveLength(0)
      expect(poller.getBoardWorkers("sunrise", backlogTasks(filesystem))[0]?.state).not.toBe("Failed")
      const health = poller.getSupervisionHealth("sunrise")
      expect(health.failureObservation).toBe(variant.expectedFailureState)
      expect(health.failureObservationReason).toBeDefined()
    }
  })

  test("a session info with no outcome yet is a normal new session, and a failed outcome without a finite time.idle is no terminal", async () => {
    const filesystem = seededProject()
    const routes: { info?: HostAnswer } = {}
    const { fetcher, calls } = hostFetcher(routes)
    const poller = makePoller({ filesystem: filesystem.port, exec: idleExec().exec, fetcher, clock: new FakeClock(t0) })

    const first = await poller.poll()
    expect(first.notifications[0]?.message).not.toContain("failed (outcome")
    expect(poller.getBoardWorkers("sunrise", backlogTasks(filesystem))[0]?.state).not.toBe("Failed")

    // No finite time.idle to key the terminal by — nothing to act on.
    routes.info = { status: 200, text: JSON.stringify({ id: "ses_11bb", outcome: "failed", time: {} }) }
    const second = await poller.poll()
    expect(second.notifications).toEqual([])
    expect(emitCalls(calls)).toHaveLength(0)
    expect(poller.getBoardWorkers("sunrise", backlogTasks(filesystem))[0]?.state).not.toBe("Failed")
  })
})

describe("session-info read pattern", () => {
  test("each worker costs exactly one authoritative session-info GET per round, scoped to its recorded worktree or the repo directory", async () => {
    const filesystem = seededProject(
      [
        "- Fix flaky login test",
        "  state: Working",
        "  session: ses_11bb",
        `  worktree: ${worktreeDirectory}`,
        "",
        "- Add dark mode",
        "  state: Working",
        "  session: ses_22cc",
        "",
      ].join("\n"),
    )
    const { exec } = busyExec()
    const { fetcher, calls } = hostFetcher()
    const poller = makePoller({ filesystem: filesystem.port, exec, fetcher, clock: new FakeClock(t0) })

    await poller.poll()
    await poller.poll()

    expect(infoCalls(calls)).toEqual([
      { url: infoUrl("ses_11bb", worktreeDirectory), init: { method: "GET" } },
      { url: infoUrl("ses_22cc", projectDirectory), init: { method: "GET" } },
      { url: infoUrl("ses_11bb", worktreeDirectory), init: { method: "GET" } },
      { url: infoUrl("ses_22cc", projectDirectory), init: { method: "GET" } },
    ])
  })

  test("each worker still costs exactly one status and one messages CLI call per round, on the attested argv", async () => {
    const filesystem = seededProject(
      [
        "- Fix flaky login test",
        "  state: Working",
        "  session: ses_11bb",
        "",
        "- Add dark mode",
        "  state: Working",
        "  session: ses_22cc",
        "",
      ].join("\n"),
    )
    const { exec, calls } = busyExec()
    const { fetcher } = hostFetcher()
    const poller = makePoller({ filesystem: filesystem.port, exec, fetcher, clock: new FakeClock(t0) })

    await poller.poll()
    await poller.poll()

    const statusCalls = calls.filter((args) => subcommand(args) === "status")
    const messagesCalls = calls.filter((args) => subcommand(args) === "messages")
    expect(statusCalls.map((args) => sessionArg(args))).toEqual(["ses_11bb", "ses_22cc", "ses_11bb", "ses_22cc"])
    expect(messagesCalls).toHaveLength(4)
    expect(messagesCalls[0]).toEqual([
      "session",
      "messages",
      "--session",
      "ses_11bb",
      "--dir",
      projectDirectory,
      "--last-assistant",
      "--json",
    ])
  })
})

describe("stall detection", () => {
  const stableMessage = lastAssistantMessage({ id: "msg_1", createdAt: 100, completedAt: 200, text: "step 1 done, moving on" })

  function runningProject(initialMessage: string = stableMessage): {
    filesystem: InMemoryFileSystem
    poller: ReturnType<typeof createSupervisionPoller>
    clock: FakeClock
    setMessage: (message: string) => void
    setStatus: (status: string) => void
  } {
    const filesystem = seededProject()
    let message = initialMessage
    let status = '{"sessionStatus":{"type":"busy"}}'
    const { exec } = scriptExec((args) => (subcommand(args) === "status" ? status : message))
    const clock = new FakeClock(t0)
    const { fetcher } = hostFetcher()
    const poller = makePoller({ filesystem: filesystem.port, exec, fetcher, clock })
    return {
      filesystem,
      poller,
      clock,
      setMessage: (next) => {
        message = next
      },
      setStatus: (next) => {
        status = next
      },
    }
  }

  test("a worker continuously seen running with an unchanged recognizable message flags stalled at exactly the fixed 30 minutes, advisory only", async () => {
    const { filesystem, poller, clock } = runningProject()

    await poller.poll() // first sight: the baseline starts now, at t0
    clock.advance(29 * 60 * 1000)
    await poller.poll()
    expect(poller.getBoardWorkers("sunrise", backlogTasks(filesystem))[0]?.possiblyStalledSince).toBeUndefined()

    clock.advance(60 * 1000) // exactly 30 minutes of unchanged progress
    await poller.poll()

    const stalled = poller.getBoardWorkers("sunrise", backlogTasks(filesystem))[0]
    expect(stalled?.possiblyStalledSince).toBe(iso(t0))
    // Advisory only — a stall flag never claims Failed.
    expect(stalled?.state).toBe("Working")
  })

  test("the baseline starts at first sight, never back-dated to the message's old createdAt", async () => {
    const { filesystem, poller, clock } = runningProject(
      lastAssistantMessage({
        id: "msg_old",
        createdAt: t0 - 10 * 60 * 60 * 1000,
        completedAt: t0 - 9 * 60 * 60 * 1000,
        text: "old message",
      }),
    )

    await poller.poll()
    clock.advance(29 * 60 * 1000)
    await poller.poll()
    // The message is ten hours old but was only observed for 29 minutes — no
    // retrospective claim.
    expect(poller.getBoardWorkers("sunrise", backlogTasks(filesystem))[0]?.possiblyStalledSince).toBeUndefined()

    clock.advance(60 * 1000)
    await poller.poll()
    expect(poller.getBoardWorkers("sunrise", backlogTasks(filesystem))[0]?.possiblyStalledSince).toBe(iso(t0))
  })

  test("a streaming message that keeps its id while its full text grows past the board preview is progress, not a stall", async () => {
    const longText = "A".repeat(300)
    const { filesystem, poller, clock, setMessage } = runningProject(lastAssistantMessage({ id: "msg_1", createdAt: 100, text: longText }))

    await poller.poll()
    // Same id and timestamps; the text grows past the 280-char board preview
    // while keeping its first 280 characters — only the FULL text signature
    // can tell this progress from a stall.
    setMessage(lastAssistantMessage({ id: "msg_1", createdAt: 100, text: longText + "B".repeat(20) }))
    clock.advance(31 * 60 * 1000)
    await poller.poll()
    expect(poller.getBoardWorkers("sunrise", backlogTasks(filesystem))[0]?.possiblyStalledSince).toBeUndefined()

    // The growth reset the baseline: it flags on its own 30-minute schedule.
    clock.advance(30 * 60 * 1000)
    await poller.poll()
    expect(poller.getBoardWorkers("sunrise", backlogTasks(filesystem))[0]?.possiblyStalledSince).toBe(iso(t0 + 31 * 60 * 1000))
  })

  test("a changed timestamp or a new message id resets the stall baseline", async () => {
    // A new completedAt — the message completed — is progress.
    const completedChange = runningProject(lastAssistantMessage({ id: "msg_1", createdAt: 100, completedAt: 200, text: "same text" }))
    await completedChange.poller.poll()
    completedChange.setMessage(lastAssistantMessage({ id: "msg_1", createdAt: 100, completedAt: 201, text: "same text" }))
    completedChange.clock.advance(31 * 60 * 1000)
    await completedChange.poller.poll()
    expect(
      completedChange.poller.getBoardWorkers("sunrise", backlogTasks(completedChange.filesystem))[0]?.possiblyStalledSince,
    ).toBeUndefined()
    completedChange.clock.advance(30 * 60 * 1000)
    await completedChange.poller.poll()
    expect(
      completedChange.poller.getBoardWorkers("sunrise", backlogTasks(completedChange.filesystem))[0]?.possiblyStalledSince,
    ).toBe(iso(t0 + 31 * 60 * 1000))

    // A new message id is progress too.
    const idChange = runningProject(lastAssistantMessage({ id: "msg_1", createdAt: 100, completedAt: 200, text: "same text" }))
    await idChange.poller.poll()
    idChange.setMessage(lastAssistantMessage({ id: "msg_2", createdAt: 100, completedAt: 200, text: "same text" }))
    idChange.clock.advance(61 * 60 * 1000)
    await idChange.poller.poll()
    expect(idChange.poller.getBoardWorkers("sunrise", backlogTasks(idChange.filesystem))[0]?.possiblyStalledSince).toBeUndefined()
    idChange.clock.advance(30 * 60 * 1000)
    await idChange.poller.poll()
    expect(idChange.poller.getBoardWorkers("sunrise", backlogTasks(idChange.filesystem))[0]?.possiblyStalledSince).toBe(
      iso(t0 + 61 * 60 * 1000),
    )
  })

  test("waiting, idle, or unknown activity breaks continuity, clears a showing flag, and restarts the clock", async () => {
    for (const breakAnswer of ['{"type":"idle"}', '{"type":"waiting-question"}', "{}" /* unrecognizable → unknown */]) {
      const { filesystem, poller, clock, setStatus } = runningProject()

      await poller.poll()
      clock.advance(30 * 60 * 1000)
      await poller.poll()
      expect(poller.getBoardWorkers("sunrise", backlogTasks(filesystem))[0]?.possiblyStalledSince).toBe(iso(t0))

      // The same old message, but the activity broke the running run.
      setStatus(breakAnswer)
      clock.advance(5 * 60 * 1000)
      await poller.poll()
      expect(poller.getBoardWorkers("sunrise", backlogTasks(filesystem))[0]?.possiblyStalledSince).toBeUndefined()

      // Continuity must re-accumulate from scratch after the break.
      setStatus('{"sessionStatus":{"type":"busy"}}')
      clock.advance(60 * 1000)
      await poller.poll()
      expect(poller.getBoardWorkers("sunrise", backlogTasks(filesystem))[0]?.possiblyStalledSince).toBeUndefined()
      clock.advance(30 * 60 * 1000)
      await poller.poll()
      expect(poller.getBoardWorkers("sunrise", backlogTasks(filesystem))[0]?.possiblyStalledSince).toBe(iso(t0 + 36 * 60 * 1000))
    }
  })

  test("a failed poll breaks continuity and clears a showing flag from the board", async () => {
    const filesystem = seededProject()
    let failStatus = false
    const { exec } = scriptExec((args) => {
      if (subcommand(args) === "status") {
        if (failStatus) throw new Error("openchamber exited with code 1: no such session")
        return '{"sessionStatus":{"type":"busy"}}'
      }
      return stableMessage
    })
    const clock = new FakeClock(t0)
    const { fetcher } = hostFetcher()
    const poller = makePoller({ filesystem: filesystem.port, exec, fetcher, clock })

    await poller.poll()
    clock.advance(30 * 60 * 1000)
    await poller.poll()
    expect(poller.getBoardWorkers("sunrise", backlogTasks(filesystem))[0]?.possiblyStalledSince).toBe(iso(t0))

    failStatus = true
    clock.advance(5 * 60 * 1000)
    await poller.poll()
    const duringFailure = poller.getBoardWorkers("sunrise", backlogTasks(filesystem))[0]
    expect(duringFailure?.lastPollError).toContain("no such session")
    expect(duringFailure?.possiblyStalledSince).toBeUndefined()

    // Recovery restarts the baseline — an unobserved round never accumulates.
    failStatus = false
    clock.advance(60 * 1000)
    await poller.poll()
    expect(poller.getBoardWorkers("sunrise", backlogTasks(filesystem))[0]?.possiblyStalledSince).toBeUndefined()
    clock.advance(30 * 60 * 1000)
    await poller.poll()
    expect(poller.getBoardWorkers("sunrise", backlogTasks(filesystem))[0]?.possiblyStalledSince).toBe(iso(t0 + 36 * 60 * 1000))
  })

  test("a message with no recognizable id or timestamp never establishes a stall, however long it sits", async () => {
    const { filesystem, poller, clock, setMessage } = runningProject()
    setMessage(lastAssistantMessage({ text: "still here" }))

    await poller.poll()
    clock.advance(60 * 60 * 1000)
    await poller.poll()

    expect(poller.getBoardWorkers("sunrise", backlogTasks(filesystem))[0]?.possiblyStalledSince).toBeUndefined()
  })

  test("a task the coordinator owns (Done, Parked, Failed) never flags stalled", async () => {
    for (const state of ["Done", "Parked", "Failed"] as const) {
      const filesystem = seededProject(["- Fix flaky login test", `  state: ${state}`, "  session: ses_11bb"].join("\n"))
      const { exec } = scriptExec((args) => (subcommand(args) === "status" ? '{"sessionStatus":{"type":"busy"}}' : stableMessage))
      const { fetcher } = hostFetcher()
      const clock = new FakeClock(t0)
      const poller = makePoller({ filesystem: filesystem.port, exec, fetcher, clock })

      await poller.poll()
      clock.advance(60 * 60 * 1000)
      await poller.poll()

      expect(poller.getBoardWorkers("sunrise", backlogTasks(filesystem))[0]?.possiblyStalledSince).toBeUndefined()
    }
  })
})
