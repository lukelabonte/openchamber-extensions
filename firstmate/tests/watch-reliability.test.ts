import { describe, expect, test } from "bun:test"
import type { ClockPort } from "../service/clock"
import type { HttpFetcher, InterruptSupport } from "../service/interrupt"
import { createWatchRunner, type WatchExecPort, type WatchRunner } from "../service/watches"
import { InMemoryFileSystem } from "./helpers/in-memory-file-system"

// runNow reliability: the manual path shares the scheduler's one execution
// path (same executor, run state, streak, and per-watch lock), answers the
// resolution failures the panel must handle, and never delivers the returned
// notifications itself — main's shared delivery path does. All waiting is
// promise-gated: no sleeps, no real time.

const homeRoot = "/home/firstmate"
const projectHome = `${homeRoot}/projects/sunrise`
const slug = "sunrise"

// All dates are built with local-time constructors so the tests pass in any
// time zone. Anchored on a weekday minute boundary (2026-10-01, Thursday):
// the `* * * * *` fixture first becomes due at 09:00:00 sharp.
function local(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0)
}

class FakeClock {
  currentMs = local(2026, 10, 1, 8, 59).getTime()
  readonly port: ClockPort = {
    nowMs: () => this.currentMs,
    delay: async () => {},
    startInterval: () => ({ cancel: () => {} }),
  }
  advance(ms: number): void {
    this.currentMs += ms
  }
}

interface ExecCall {
  scriptPath: string
  cwd: string
  env: Record<string, string>
}

type WatchExecStubResult = { stdout: string; exitCode: number | null; timedOut?: boolean }

// A recording exec stub that answers each call with the next queued result.
function execStub(results: WatchExecStubResult[]): { exec: WatchExecPort; calls: ExecCall[] } {
  const calls: ExecCall[] = []
  const exec: WatchExecPort = async (input) => {
    calls.push({ scriptPath: input.scriptPath, cwd: input.cwd, env: { ...input.env } })
    const result = results.shift() ?? { stdout: "", exitCode: 0 }
    return { stdout: result.stdout, exitCode: result.exitCode, timedOut: result.timedOut === true }
  }
  return { exec, calls }
}

// An exec stub whose first call hangs until released — the barrier that holds
// the per-watch lock without a single real sleep.
function gatedExec(): { exec: WatchExecPort; calls: ExecCall[]; release: (result?: WatchExecStubResult) => void } {
  const calls: ExecCall[] = []
  let releaseInFlight: ((result: WatchExecStubResult) => void) | undefined
  const exec: WatchExecPort = (input) => {
    calls.push({ scriptPath: input.scriptPath, cwd: input.cwd, env: { ...input.env } })
    return new Promise((resolve) => {
      releaseInFlight = (result) =>
        resolve({ stdout: result?.stdout ?? "", exitCode: result?.exitCode ?? 0, timedOut: result?.timedOut === true })
    })
  }
  return {
    exec,
    calls,
    release: (result) => releaseInFlight?.(result ?? { stdout: "", exitCode: 0 }),
  }
}

// Records every captain-notification POST by URL — the per-URL recording
// fetcher. resolveSupport answers supported so the emit route is exercised.
interface RecordedEmitCall {
  url: string
  init: { method: string; body?: string }
}

function emitRecording(): { fetcher: HttpFetcher; calls: RecordedEmitCall[] } {
  const calls: RecordedEmitCall[] = []
  const fetcher: HttpFetcher = async (url, init) => {
    calls.push({ url, init })
    return { status: 200 }
  }
  return { fetcher, calls }
}

const resolveSupported = async (): Promise<InterruptSupport> => ({ kind: "supported", port: 4096 })

function makeRunner(filesystem: InMemoryFileSystem, exec: WatchExecPort, clock: FakeClock, fetcher: HttpFetcher): WatchRunner {
  return createWatchRunner({ filesystem: filesystem.port, exec, clock: clock.port, fetcher, resolveSupport: resolveSupported, homeRoot })
}

function seedRegistry(filesystem: InMemoryFileSystem): void {
  filesystem.seedFile(
    `${homeRoot}/registry.json`,
    JSON.stringify({
      sunrise: {
        slug,
        projectDirectory: "/repos/sunrise",
        homeDirectory: projectHome,
        coordinatorSessionId: "ses_coord_1",
        createdAt: "2026-10-01T08:00:00Z",
      },
    }),
  )
}

function seedNightly(filesystem: InMemoryFileSystem): void {
  filesystem.seedExecutableFile(`${projectHome}/watches/nightly`, "#!/bin/sh\n# schedule: * * * * *\n")
}

// One minute of schedule granularity plus slack, so a tick past the minute
// boundary makes the fixture watch due.
const dueAdvanceMs = 61_000

describe("createWatchRunner runNow resolution", () => {
  test("answers unknown-slug for an unregistered slug", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    seedNightly(filesystem)
    const runner = makeRunner(filesystem, execStub([]).exec, new FakeClock(), emitRecording().fetcher)

    expect(await runner.runNow("elsewhere", undefined, "nightly")).toEqual({ kind: "unknown-slug" })
  })

  test("answers unknown-watch for a name that matches nothing, with or without a source", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    seedNightly(filesystem)
    const { exec, calls } = execStub([])
    const runner = makeRunner(filesystem, exec, new FakeClock(), emitRecording().fetcher)

    expect(await runner.runNow(slug, undefined, "absent")).toEqual({ kind: "unknown-watch" })
    expect(await runner.runNow(slug, "shared", "nightly")).toEqual({ kind: "unknown-watch" })
    expect(calls).toEqual([])
  })

  test("answers ambiguous-watch when the name matches a shared and a project watch", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    filesystem.seedExecutableFile(`${homeRoot}/shared/watches/twin`, "#!/bin/sh\n# schedule: 0 9 * * *\n")
    filesystem.seedExecutableFile(`${projectHome}/watches/twin`, "#!/bin/sh\n# schedule: 0 9 * * *\n")
    const { exec, calls } = execStub([])
    const runner = makeRunner(filesystem, exec, new FakeClock(), emitRecording().fetcher)

    expect(await runner.runNow(slug, undefined, "twin")).toEqual({ kind: "ambiguous-watch" })
    expect(calls).toEqual([])
  })

  test("refuses a broken-schedule watch with the parser's reason and never execs", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    filesystem.seedExecutableFile(`${projectHome}/watches/broken`, "#!/bin/sh\n# schedule: 0 25 * * *\n")
    const { exec, calls } = execStub([])
    const runner = makeRunner(filesystem, exec, new FakeClock(), emitRecording().fetcher)

    const result = await runner.runNow(slug, "project", "broken")
    expect(result.kind).toBe("invalid-schedule")
    if (result.kind === "invalid-schedule") {
      expect(result.error).toContain(`invalid watch schedule "0 25 * * *"`)
    }
    expect(calls).toEqual([])
  })

  test("runs the watch through the shared path and returns the result without delivering", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    seedNightly(filesystem)
    const { exec, calls } = execStub([{ stdout: "all quiet", exitCode: 0 }])
    const { fetcher, calls: emitCalls } = emitRecording()
    const runner = makeRunner(filesystem, exec, new FakeClock(), fetcher)

    const result = await runner.runNow(slug, "project", "nightly")

    expect(result).toEqual({
      kind: "ran",
      name: "nightly",
      source: "project",
      lastOutcome: "ok",
      notifications: [
        {
          slug,
          coordinatorSessionId: "ses_coord_1",
          homeDirectory: projectHome,
          message: "FirstMate (sunrise) watch nightly:\nall quiet",
          watchName: "nightly",
          source: "project",
        },
      ],
    })
    // The runner execs (same path as the scheduler) and tells the captain,
    // but never delivers the coordinator notification itself.
    expect(calls).toHaveLength(1)
    expect(calls[0].cwd).toBe(projectHome)
    expect(calls[0].env.FIRSTMATE_WATCH_STATE).toBe(`${projectHome}/watch-state/nightly`)
    expect(emitCalls).toHaveLength(1)
    expect(emitCalls[0].url).toBe("http://127.0.0.1:4096/api/notifications/emit")
    expect(emitCalls[0].init.method).toBe("POST")
  })
})

describe("createWatchRunner runNow shares the scheduler's lock", () => {
  test("answers already-running to a second run-now and holds the tick while a manual run is in flight", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    seedNightly(filesystem)
    const { exec, calls, release } = gatedExec()
    const clock = new FakeClock()
    const runner = makeRunner(filesystem, exec, clock, emitRecording().fetcher)

    // The manual run holds the lock before its first real wait; the clock
    // then makes the watch due, so the tick would run it if the lock failed.
    const first = runner.runNow(slug, "project", "nightly")
    clock.advance(dueAdvanceMs)

    expect(await runner.runNow(slug, "project", "nightly")).toEqual({ kind: "already-running" })
    const round = await runner.tick()
    expect(round.notifications).toEqual([])
    expect(calls).toHaveLength(1)

    release({ stdout: "late", exitCode: 0 })
    expect(await first).toEqual({
      kind: "ran",
      name: "nightly",
      source: "project",
      lastOutcome: "ok",
      notifications: [
        {
          slug,
          coordinatorSessionId: "ses_coord_1",
          homeDirectory: projectHome,
          message: "FirstMate (sunrise) watch nightly:\nlate",
          watchName: "nightly",
          source: "project",
        },
      ],
    })
    expect(calls).toHaveLength(1)
  })

  test("a due manual run consumes the scheduled slot, so the next tick does not repeat it", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    seedNightly(filesystem)
    const { exec, calls } = execStub([{ stdout: "", exitCode: 0 }])
    const clock = new FakeClock()
    const runner = makeRunner(filesystem, exec, clock, emitRecording().fetcher)

    await runner.tick() // first sight: schedules forward, runs nothing
    clock.advance(dueAdvanceMs) // the watch is now due
    const result = await runner.runNow(slug, "project", "nightly")
    expect(result).toEqual({ kind: "ran", name: "nightly", source: "project", lastOutcome: "empty", notifications: [] })
    expect(calls).toHaveLength(1)

    // Same clock instant: the manual run advanced next-run past now, so the
    // tick must not execute the watch a second time.
    const round = await runner.tick()
    expect(round.notifications).toEqual([])
    expect(calls).toHaveLength(1)
  })

  test("a disabled watch may run manually and the switch stays off", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    seedNightly(filesystem)
    filesystem.seedFile(`${projectHome}/settings.json`, JSON.stringify({ watches: { project: { nightly: { enabled: false } } } }))
    const { exec, calls } = execStub([{ stdout: "manual output", exitCode: 0 }])
    const clock = new FakeClock()
    const runner = makeRunner(filesystem, exec, clock, emitRecording().fetcher)

    await runner.tick()
    clock.advance(dueAdvanceMs)
    await runner.tick()
    expect(calls).toEqual([]) // the switch only toggles automatic scheduling

    const result = await runner.runNow(slug, "project", "nightly")
    expect(result).toMatchObject({ kind: "ran", name: "nightly", lastOutcome: "ok" })
    expect(calls).toHaveLength(1)

    const watches = await runner.listWatches(slug)
    expect(watches[0]).toMatchObject({ name: "nightly", enabled: false })

    clock.advance(dueAdvanceMs)
    await runner.tick()
    expect(calls).toHaveLength(1) // the tick still skips the disabled watch
  })
})

describe("createWatchRunner runNow failure streak and lastError", () => {
  test("the first failure of a streak notifies coordinator and captain once; repeats stay silent", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    seedNightly(filesystem)
    const { exec } = execStub([
      { stdout: "crash log", exitCode: 1 },
      { stdout: "crash log", exitCode: 1 },
    ])
    const { fetcher, calls: emitCalls } = emitRecording()
    const runner = makeRunner(filesystem, exec, new FakeClock(), fetcher)

    const firstFailure = await runner.runNow(slug, "project", "nightly")
    expect(firstFailure.kind).toBe("ran")
    if (firstFailure.kind === "ran") {
      expect(firstFailure.lastOutcome).toBe("failed")
      expect(firstFailure.lastError).toBe("exited with code 1")
      expect(firstFailure.notifications).toEqual([
        {
          slug,
          coordinatorSessionId: "ses_coord_1",
          homeDirectory: projectHome,
          message: "FirstMate (sunrise) watch nightly failed: exited with code 1",
          watchName: "nightly",
          source: "project",
        },
      ])
    }
    expect(emitCalls).toHaveLength(1)
    expect(emitCalls[0].url).toBe("http://127.0.0.1:4096/api/notifications/emit")
    expect(JSON.parse(emitCalls[0].init.body ?? "")).toEqual({
      title: "FirstMate — nightly failed",
      body: "exited with code 1",
    })
    const watches = await runner.listWatches(slug)
    expect(watches[0]).toMatchObject({ lastOutcome: "failed", lastError: "exited with code 1" })

    const repeatFailure = await runner.runNow(slug, "project", "nightly")
    expect(repeatFailure.kind).toBe("ran")
    if (repeatFailure.kind === "ran") {
      expect(repeatFailure.lastOutcome).toBe("failed")
      expect(repeatFailure.notifications).toEqual([])
    }
    expect(emitCalls).toHaveLength(1) // the captain is not told twice in a streak
  })

  test("a success — empty output included — resets the streak and clears lastError", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    seedNightly(filesystem)
    const { exec } = execStub([
      { stdout: "crash log", exitCode: 1 },
      { stdout: "  \n", exitCode: 0 },
      { stdout: "crash log", exitCode: 1 },
    ])
    const { fetcher, calls: emitCalls } = emitRecording()
    const runner = makeRunner(filesystem, exec, new FakeClock(), fetcher)

    await runner.runNow(slug, "project", "nightly") // failure: streak opens
    const recovery = await runner.runNow(slug, "project", "nightly") // empty success
    expect(recovery.kind).toBe("ran")
    if (recovery.kind === "ran") {
      expect(recovery.lastOutcome).toBe("empty")
      expect(recovery.lastError).toBeUndefined()
      expect(recovery.notifications).toEqual([])
    }
    const cleared = await runner.listWatches(slug)
    expect(cleared[0].lastError).toBeUndefined()
    expect(cleared[0].lastOutcome).toBe("empty")

    const refailure = await runner.runNow(slug, "project", "nightly") // streak reopens
    expect(refailure.kind).toBe("ran")
    if (refailure.kind === "ran") {
      expect(refailure.lastOutcome).toBe("failed")
      expect(refailure.notifications).toHaveLength(1)
      expect(refailure.notifications[0].message).toContain("watch nightly failed: exited with code 1")
    }
    // Two streaks, two captain calls; the empty success made none.
    expect(emitCalls).toHaveLength(2)
    const reopened = await runner.listWatches(slug)
    expect(reopened[0]).toMatchObject({ lastOutcome: "failed", lastError: "exited with code 1" })
  })
})
