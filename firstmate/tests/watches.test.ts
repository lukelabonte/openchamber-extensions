import { describe, expect, test } from "bun:test"
import type { ClockPort } from "../service/clock"
import type { HttpFetcher, InterruptSupport } from "../service/interrupt"
import { createWatchRunner, WatchSettingsError, type WatchExecPort } from "../service/watches"
import { InMemoryFileSystem } from "./helpers/in-memory-file-system"

const homeRoot = "/home/firstmate"
const projectHome = `${homeRoot}/projects/sunrise`
const slug = "sunrise"

// All dates are built with local-time constructors so the tests pass in any
// time zone.
function local(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0)
}

// A controllable clock: the runner reads nowMs() at the start of a tick and
// again after each run, so tests advance currentMs between manual ticks.
// Anchored on a weekday minute boundary (2026-10-01 is a Thursday): every
// fixture schedule (`* * * * *`, `*/5 * * * *`, `0 9 * * 1-5`) first becomes
// due at 09:00:00 sharp, exactly one dueAdvanceMs after the anchor — from
// epoch 0 the `*/5` and `0 9` watches would sit up to hours away from their
// next boundary and a 61 s advance would never reach them.
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

function execStub(results: WatchExecStubResult[]): { exec: WatchExecPort; calls: ExecCall[] } {
  const calls: ExecCall[] = []
  const exec: WatchExecPort = async (input) => {
    calls.push({ scriptPath: input.scriptPath, cwd: input.cwd, env: { ...input.env } })
    const result = results.shift() ?? { stdout: "", exitCode: 0 }
    return { stdout: result.stdout, exitCode: result.exitCode, timedOut: result.timedOut === true }
  }
  return { exec, calls }
}

type WatchExecStubResult = { stdout: string; exitCode: number | null; timedOut?: boolean }

const noopFetcher: HttpFetcher = async () => ({ status: 200 })
const noopResolveSupport = async (): Promise<InterruptSupport> => ({ kind: "unsupported", reason: "test" })

// Records the captain-notification POSTs a firing watch makes, always
// answering 200 (mirrors poller.test.ts's recordingFetcher).
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

function seedWatches(filesystem: InMemoryFileSystem): void {
  filesystem.seedExecutableFile(`${homeRoot}/shared/watches/pr-watch`, "#!/bin/sh\n# schedule: */5 * * * *\n")
  filesystem.seedExecutableFile(`${projectHome}/watches/nightly`, "#!/bin/sh\n# schedule: 0 9 * * 1-5\n")
}

// One minute of schedule granularity plus slack, so a tick past the minute
// boundary makes every watch due.
const dueAdvanceMs = 61_000

describe("createWatchRunner discovery", () => {
  test("lists shared and project watches with source and schedule", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    seedWatches(filesystem)
    const runner = createWatchRunner({ filesystem: filesystem.port, exec: execStub([]).exec, clock: new FakeClock().port, fetcher: noopFetcher, resolveSupport: noopResolveSupport, homeRoot })

    expect(await runner.listWatches(slug)).toEqual([
      {
        name: "pr-watch",
        source: "shared",
        schedule: "*/5 * * * *",
        enabled: true,
        nextRun: local(2026, 10, 1, 9, 0).getTime(),
        path: `${homeRoot}/shared/watches/pr-watch`,
      },
      {
        name: "nightly",
        source: "project",
        schedule: "0 9 * * 1-5",
        enabled: true,
        nextRun: local(2026, 10, 1, 9, 0).getTime(),
        path: `${projectHome}/watches/nightly`,
      },
    ])
  })

  test("only executable files with a schedule comment are watches", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    filesystem.seedExecutableFile(`${homeRoot}/shared/watches/scripted`, "#!/bin/sh\n# schedule: 0 9 * * *\n")
    filesystem.seedFile(`${homeRoot}/shared/watches/not-executable`, "#!/bin/sh\n# schedule: 0 9 * * *\n")
    filesystem.seedExecutableFile(`${homeRoot}/shared/watches/no-schedule`, "#!/bin/sh\necho hi\n")

    const runner = createWatchRunner({ filesystem: filesystem.port, exec: execStub([]).exec, clock: new FakeClock().port, fetcher: noopFetcher, resolveSupport: noopResolveSupport, homeRoot })

    const watches = await runner.listWatches(slug)
    expect(watches).toHaveLength(1)
    expect(watches[0].name).toBe("scripted")
  })

  test("a watch with a malformed schedule is listed with an error and never run", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    filesystem.seedExecutableFile(`${projectHome}/watches/broken`, "#!/bin/sh\n# schedule: 0 25 * * *\n")
    const { exec, calls } = execStub([])
    const clock = new FakeClock()
    const runner = createWatchRunner({ filesystem: filesystem.port, exec, clock: clock.port, fetcher: noopFetcher, resolveSupport: noopResolveSupport, homeRoot })

    const watches = await runner.listWatches(slug)
    expect(watches[0].name).toBe("broken")
    expect(watches[0].error).toContain("invalid watch schedule")

    clock.advance(dueAdvanceMs)
    await runner.tick()
    clock.advance(dueAdvanceMs)
    const round = await runner.tick()

    expect(calls).toEqual([])
    expect(round.notifications).toEqual([])
  })
})

describe("createWatchRunner tick", () => {
  test("a due watch runs in the project home with the env contract", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    seedWatches(filesystem)
    const { exec, calls } = execStub([
      { stdout: "all quiet", exitCode: 0 },
      { stdout: "all quiet", exitCode: 0 },
    ])
    const clock = new FakeClock()
    const runner = createWatchRunner({ filesystem: filesystem.port, exec, clock: clock.port, fetcher: noopFetcher, resolveSupport: noopResolveSupport, homeRoot })

    await runner.tick() // first sight: schedules forward, runs nothing
    expect(calls).toEqual([])

    clock.advance(dueAdvanceMs)
    const round = await runner.tick()

    // Shared watches run once per project: both watches fire for sunrise.
    expect(calls).toHaveLength(2)
    expect(calls[0].cwd).toBe(projectHome)
    expect(calls[0].env.FIRSTMATE_HOME).toBe(projectHome)
    expect(calls[0].env.FIRSTMATE_BACKLOG).toBe(`${projectHome}/backlog.md`)
    expect(calls[0].env.FIRSTMATE_WATCH_STATE).toBe(`${projectHome}/watch-state/pr-watch`)
    expect(calls[1].env.FIRSTMATE_WATCH_STATE).toBe(`${projectHome}/watch-state/nightly`)
    expect(filesystem.directoryExists(`${projectHome}/watch-state/nightly`)).toBe(true)
    expect(round.notifications).toEqual([
      {
        slug,
        coordinatorSessionId: "ses_coord_1",
        homeDirectory: projectHome,
        message: "FirstMate (sunrise) watch pr-watch:\nall quiet",
      },
      {
        slug,
        coordinatorSessionId: "ses_coord_1",
        homeDirectory: projectHome,
        message: "FirstMate (sunrise) watch nightly:\nall quiet",
      },
    ])
  })

  test("a watch that prints nothing sends no message and records empty", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    filesystem.seedExecutableFile(`${projectHome}/watches/nightly`, "#!/bin/sh\n# schedule: * * * * *\n")
    const { exec, calls } = execStub([{ stdout: "  \n", exitCode: 0 }])
    const clock = new FakeClock()
    const runner = createWatchRunner({ filesystem: filesystem.port, exec, clock: clock.port, fetcher: noopFetcher, resolveSupport: noopResolveSupport, homeRoot })

    await runner.tick()
    clock.advance(dueAdvanceMs)
    const round = await runner.tick()

    expect(calls).toHaveLength(1)
    expect(round.notifications).toEqual([])
    const watches = await runner.listWatches(slug)
    expect(watches[0].lastOutcome).toBe("empty")
    expect(watches[0].lastOutput).toBeUndefined()
  })

  test("a failing watch notifies once per failure streak and resets on success", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    filesystem.seedExecutableFile(`${projectHome}/watches/nightly`, "#!/bin/sh\n# schedule: * * * * *\n")
    const results: WatchExecStubResult[] = [
      { stdout: "", exitCode: 1 },
      { stdout: "", exitCode: 1 },
      { stdout: "", exitCode: 0 },
      { stdout: "", exitCode: 1 },
    ]
    const { exec } = execStub(results)
    const clock = new FakeClock()
    const runner = createWatchRunner({ filesystem: filesystem.port, exec, clock: clock.port, fetcher: noopFetcher, resolveSupport: noopResolveSupport, homeRoot })

    await runner.tick()
    clock.advance(dueAdvanceMs)
    const firstFailure = await runner.tick()
    clock.advance(dueAdvanceMs)
    const secondFailure = await runner.tick()
    clock.advance(dueAdvanceMs)
    const recovery = await runner.tick()
    clock.advance(dueAdvanceMs)
    const refailure = await runner.tick()

    expect(firstFailure.notifications).toHaveLength(1)
    expect(firstFailure.notifications[0].message).toContain("watch nightly failed")
    expect(firstFailure.notifications[0].message).toContain("exited with code 1")
    expect(secondFailure.notifications).toEqual([])
    expect(recovery.notifications).toEqual([])
    expect(refailure.notifications).toHaveLength(1)
    const watches = await runner.listWatches(slug)
    expect(watches[0].lastOutcome).toBe("failed")
  })

  test("a timeout counts as a failure", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    filesystem.seedExecutableFile(`${projectHome}/watches/nightly`, "#!/bin/sh\n# schedule: * * * * *\n")
    const { exec } = execStub([{ stdout: "partial", exitCode: null, timedOut: true }])
    const clock = new FakeClock()
    const runner = createWatchRunner({ filesystem: filesystem.port, exec, clock: clock.port, fetcher: noopFetcher, resolveSupport: noopResolveSupport, homeRoot, timeoutMs: 50 })

    await runner.tick()
    clock.advance(dueAdvanceMs)
    const round = await runner.tick()

    expect(round.notifications).toHaveLength(1)
    expect(round.notifications[0].message).toContain("timed out after 50 ms")
  })

  test("a disabled watch never runs; the default is enabled", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    seedWatches(filesystem)
    filesystem.seedFile(`${projectHome}/settings.json`, JSON.stringify({ watches: { project: { nightly: { enabled: false } } } }))
    const { exec, calls } = execStub([])
    const clock = new FakeClock()
    const runner = createWatchRunner({ filesystem: filesystem.port, exec, clock: clock.port, fetcher: noopFetcher, resolveSupport: noopResolveSupport, homeRoot })

    await runner.tick()
    clock.advance(dueAdvanceMs)
    await runner.tick()

    expect(calls).toHaveLength(1)
    expect(calls[0].scriptPath).toBe(`${homeRoot}/shared/watches/pr-watch`)
  })

  test("oversized output is tail-kept with a truncation marker for message and card", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    filesystem.seedExecutableFile(`${projectHome}/watches/nightly`, "#!/bin/sh\n# schedule: * * * * *\n")
    const longOutput = `${"x".repeat(2500)}tail`
    const { exec } = execStub([{ stdout: longOutput, exitCode: 0 }])
    const clock = new FakeClock()
    const runner = createWatchRunner({ filesystem: filesystem.port, exec, clock: clock.port, fetcher: noopFetcher, resolveSupport: noopResolveSupport, homeRoot })

    await runner.tick()
    clock.advance(dueAdvanceMs)
    const round = await runner.tick()

    // 2504 chars of output, last 2000 kept, 504 dropped — the tail survives.
    expect(round.notifications[0].message).toContain("…[truncated 504 chars]")
    expect(round.notifications[0].message).toContain("tail")
    const watches = await runner.listWatches(slug)
    expect(watches[0].lastOutput).toBe(`…[truncated 504 chars]\n${"x".repeat(1996)}tail`)
  })

  test("a corrupt registry makes the tick a no-op", async () => {
    const filesystem = new InMemoryFileSystem()
    filesystem.seedFile(`${homeRoot}/registry.json`, "not json")
    filesystem.seedExecutableFile(`${projectHome}/watches/nightly`, "#!/bin/sh\n# schedule: * * * * *\n")
    const { exec, calls } = execStub([])
    const clock = new FakeClock()
    const runner = createWatchRunner({ filesystem: filesystem.port, exec, clock: clock.port, fetcher: noopFetcher, resolveSupport: noopResolveSupport, homeRoot })

    clock.advance(dueAdvanceMs)
    const round = await runner.tick()

    expect(calls).toEqual([])
    expect(round.notifications).toEqual([])
  })
})

describe("createWatchRunner setEnabled", () => {
  test("persists the switch per source under watches and never overwrites other settings", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    seedWatches(filesystem)
    filesystem.seedFile(`${projectHome}/settings.json`, JSON.stringify({ projectDirectory: "/repos/sunrise" }))
    const runner = createWatchRunner({ filesystem: filesystem.port, exec: execStub([]).exec, clock: new FakeClock().port, fetcher: noopFetcher, resolveSupport: noopResolveSupport, homeRoot })

    const result = await runner.setEnabled(slug, "project", "nightly", false)

    expect(result).toBe("ok")
    expect(JSON.parse(filesystem.fileContents(`${projectHome}/settings.json`))).toEqual({
      projectDirectory: "/repos/sunrise",
      watches: { project: { nightly: { enabled: false } } },
    })
    const watches = await runner.listWatches(slug)
    expect(watches.find((watch) => watch.name === "nightly")?.enabled).toBe(false)
    // A shared watch's switch is keyed per project: disabling it for sunrise
    // writes to sunrise's settings only.
    expect(await runner.setEnabled(slug, "shared", "pr-watch", false)).toBe("ok")
    expect(JSON.parse(filesystem.fileContents(`${projectHome}/settings.json`)).watches).toEqual({
      project: { nightly: { enabled: false } },
      shared: { "pr-watch": { enabled: false } },
    })
  })

  test("a shared and a project watch sharing a name switch independently", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    seedWatches(filesystem)
    filesystem.seedExecutableFile(`${projectHome}/watches/pr-watch`, "#!/bin/sh\n# schedule: 0 9 * * *\n")
    const runner = createWatchRunner({ filesystem: filesystem.port, exec: execStub([]).exec, clock: new FakeClock().port, fetcher: noopFetcher, resolveSupport: noopResolveSupport, homeRoot })

    // Without a source the name is ambiguous and the toggle is refused.
    expect(await runner.setEnabled(slug, undefined, "pr-watch", false)).toBe("ambiguous-watch")

    expect(await runner.setEnabled(slug, "shared", "pr-watch", false)).toBe("ok")
    const watches = await runner.listWatches(slug)
    expect(watches.find((watch) => watch.source === "shared" && watch.name === "pr-watch")?.enabled).toBe(false)
    expect(watches.find((watch) => watch.source === "project" && watch.name === "pr-watch")?.enabled).toBe(true)
  })

  test("a corrupt settings.json stops the toggle with a named error instead of being overwritten", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    seedWatches(filesystem)
    filesystem.seedFile(`${projectHome}/settings.json`, "this is not json")
    const runner = createWatchRunner({ filesystem: filesystem.port, exec: execStub([]).exec, clock: new FakeClock().port, fetcher: noopFetcher, resolveSupport: noopResolveSupport, homeRoot })

    const failure = runner.setEnabled(slug, "project", "nightly", false)
    await expect(failure).rejects.toBeInstanceOf(WatchSettingsError)
    await expect(failure).rejects.toThrow("is unreadable")
    expect(filesystem.fileContents(`${projectHome}/settings.json`)).toBe("this is not json")

    filesystem.seedFile(`${projectHome}/settings.json`, JSON.stringify(["not an object"]))
    await expect(runner.setEnabled(slug, "project", "nightly", false)).rejects.toThrow("not a JSON object")
  })

  test("writes the settings file atomically through a temp file and rename", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    seedWatches(filesystem)
    const runner = createWatchRunner({ filesystem: filesystem.port, exec: execStub([]).exec, clock: new FakeClock().port, fetcher: noopFetcher, resolveSupport: noopResolveSupport, homeRoot })

    await runner.setEnabled(slug, "project", "nightly", false)

    // The in-memory port records the rename from a temp sibling; the settings
    // file is only ever replaced whole.
    expect(filesystem.renamedFrom(`${projectHome}/settings.json`)).toContain(".tmp")
  })

  test("answers unknown-watch for a name that is not a watch", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    seedWatches(filesystem)
    const runner = createWatchRunner({ filesystem: filesystem.port, exec: execStub([]).exec, clock: new FakeClock().port, fetcher: noopFetcher, resolveSupport: noopResolveSupport, homeRoot })

    expect(await runner.setEnabled(slug, undefined, "absent", false)).toBe("unknown-watch")
    expect(await runner.setEnabled(slug, "shared", "nightly", false)).toBe("unknown-watch")
  })
})

describe("createWatchRunner nextRun and captain notifications", () => {
  test("enabled watches carry their next scheduled run; disabled watches carry none", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    seedWatches(filesystem)
    filesystem.seedFile(`${projectHome}/settings.json`, JSON.stringify({ watches: { project: { nightly: { enabled: false } } } }))
    const runner = createWatchRunner({ filesystem: filesystem.port, exec: execStub([]).exec, clock: new FakeClock().port, fetcher: noopFetcher, resolveSupport: noopResolveSupport, homeRoot })

    const watches = await runner.listWatches(slug)
    expect(watches.find((watch) => watch.name === "pr-watch")?.nextRun).toBe(local(2026, 10, 1, 9, 0).getTime())
    expect(watches.find((watch) => watch.name === "nightly")?.nextRun).toBeNull()
  })

  test("a watch with a broken schedule carries no next run", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    filesystem.seedExecutableFile(`${projectHome}/watches/broken`, "#!/bin/sh\n# schedule: 0 25 * * *\n")
    const runner = createWatchRunner({ filesystem: filesystem.port, exec: execStub([]).exec, clock: new FakeClock().port, fetcher: noopFetcher, resolveSupport: noopResolveSupport, homeRoot })

    const watches = await runner.listWatches(slug)
    expect(watches[0].nextRun).toBeNull()
  })

  test("a firing watch notifies the captain once with the 500-character output cap", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    filesystem.seedExecutableFile(`${projectHome}/watches/nightly`, "#!/bin/sh\n# schedule: * * * * *\n")
    const { exec } = execStub([{ stdout: "x".repeat(600), exitCode: 0 }])
    const clock = new FakeClock()
    const { fetcher, calls } = emitRecording()
    const runner = createWatchRunner({
      filesystem: filesystem.port,
      exec,
      clock: clock.port,
      fetcher,
      resolveSupport: async () => ({ kind: "supported", port: 4096 }),
      homeRoot,
    })

    await runner.tick() // first sight: schedules forward, runs nothing
    clock.advance(dueAdvanceMs)
    await runner.tick()

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://127.0.0.1:4096/api/notifications/emit")
    expect(calls[0].init.method).toBe("POST")
    expect(JSON.parse(calls[0].init.body ?? "")).toEqual({
      title: "FirstMate — nightly fired",
      body: "x".repeat(500),
    })
  })

  test("a watch that prints nothing makes no captain-notification call", async () => {
    const filesystem = new InMemoryFileSystem()
    seedRegistry(filesystem)
    filesystem.seedExecutableFile(`${projectHome}/watches/nightly`, "#!/bin/sh\n# schedule: * * * * *\n")
    const { exec } = execStub([{ stdout: "  \n", exitCode: 0 }])
    const clock = new FakeClock()
    const { fetcher, calls } = emitRecording()
    const runner = createWatchRunner({
      filesystem: filesystem.port,
      exec,
      clock: clock.port,
      fetcher,
      resolveSupport: async () => ({ kind: "supported", port: 4096 }),
      homeRoot,
    })

    await runner.tick()
    clock.advance(dueAdvanceMs)
    await runner.tick()

    expect(calls).toEqual([])
  })
})
