import { describe, expect, test } from "bun:test"
import type { FileSystemPort } from "../service/file-system"
import { WatchStoreError, watchStorePath } from "../service/watch-store"
import { createWatchRunner, type WatchExecPort } from "../service/watches"
import { InMemoryFileSystem } from "./helpers/in-memory-file-system"

const homeRoot = "/home/firstmate"
const slug = "sunrise"
const projectHome = `${homeRoot}/projects/${slug}`

function deferred<Value>() {
  let resolve!: (value: Value) => void
  const promise = new Promise<Value>((resolvePromise) => { resolve = resolvePromise })
  return { promise, resolve }
}

function fixture() {
  const filesystem = new InMemoryFileSystem()
  filesystem.seedFile(`${homeRoot}/registry.json`, JSON.stringify({
    [slug]: {
      slug,
      projectDirectory: "/repos/sunrise",
      homeDirectory: projectHome,
      coordinatorSessionId: "ses_coord_1",
      createdAt: "2026-10-01T08:00:00Z",
    },
  }))
  filesystem.seedExecutableFile(`${projectHome}/watches/nightly`, "#!/bin/sh\n# schedule: * * * * *\n")
  const clock = { currentMs: new Date(2026, 9, 1, 8, 59).getTime(), nowMs() { return this.currentMs } }
  const deliveries: string[] = []
  let output = "news"
  let exitCode = 0
  const calls: Parameters<WatchExecPort>[0][] = []
  const exec: WatchExecPort = async (input) => {
    calls.push(input)
    return { stdout: output, exitCode, timedOut: false }
  }
  const runner = (port: FileSystemPort = filesystem.port, executor = exec) => createWatchRunner({
    filesystem: port,
    exec: executor,
    clock,
    homeRoot,
    fetcher: async (url) => { deliveries.push(url); return { status: 200 } },
    resolveSupport: async () => ({ kind: "supported", port: 4096 }),
  })
  return { filesystem, clock, calls, deliveries, runner, setOutput: (value: string) => { output = value }, setExitCode: (value: number) => { exitCode = value } }
}

describe("durable watch notifications", () => {
  test("restores queued notes and last-run details after restart without delivering or replaying missed runs", async () => {
    const setup = fixture()
    const runner = setup.runner()
    const result = await runner.runNow(slug, "project", "nightly")
    expect(result).toMatchObject({ kind: "ran", lastOutcome: "ok" })
    const pending = await runner.pendingNotifications(slug)
    expect(pending.dropped).toBe(0)
    expect(pending.notes).toHaveLength(1)
    expect(pending.notes[0]).toMatchObject({
      createdAt: new Date(setup.clock.currentMs).toISOString(),
      notification: { slug, message: "FirstMate (sunrise) watch nightly:\nnews", watchName: "nightly", source: "project" },
    })
    expect(pending.notes[0].id).toBeString()
    expect(setup.deliveries).toEqual([])

    setup.clock.currentMs += 3_600_000
    const restarted = setup.runner()
    expect(await restarted.pendingNotifications(slug)).toEqual(pending)
    expect((await restarted.listWatches(slug))[0]).toMatchObject({
      lastRunAt: pending.notes[0].createdAt,
      lastOutcome: "ok",
      lastOutput: "news",
    })
    expect(await restarted.tick()).toEqual({ notifications: [] })
    expect(setup.calls).toHaveLength(1)
    setup.clock.currentMs += 60_000
    expect((await restarted.tick()).notifications).toHaveLength(1)
    expect((await restarted.pendingNotifications(slug)).notes).toHaveLength(2)
    expect(setup.calls).toHaveLength(2)
  })

  test("acknowledges only delivered IDs while a new run queues another note, retaining history across restart", async () => {
    const setup = fixture()
    const runner = setup.runner()
    await runner.runNow(slug, "project", "nightly")
    const snapshot = await runner.pendingNotifications(slug)
    setup.setOutput("new news")
    await Promise.all([
      runner.runNow(slug, "project", "nightly"),
      runner.acknowledgeNotifications(slug, snapshot.notes.map((note) => note.id)),
    ])
    const pending = await runner.pendingNotifications(slug)
    expect(pending.notes).toHaveLength(1)
    expect(pending.notes[0].notification.message).toContain("new news")
    expect(await runner.deliveredNotes(slug)).toEqual(snapshot.notes)
    await runner.acknowledgeNotifications(slug, [snapshot.notes[0].id, "unknown"])
    expect(await runner.pendingNotifications(slug)).toEqual(pending)
    expect(await setup.runner().deliveredNotes(slug)).toEqual(snapshot.notes)
  })

  test("keeps the latest 20 pending notes and acknowledges only the observed dropped count", async () => {
    const setup = fixture()
    const runner = setup.runner()
    for (let index = 0; index < 22; index += 1) {
      setup.setOutput(`news ${index}`)
      await runner.runNow(slug, "project", "nightly")
    }
    const snapshot = await runner.pendingNotifications(slug)
    expect(snapshot.notes).toHaveLength(20)
    expect(snapshot.dropped).toBe(2)
    expect(snapshot.notes[0].notification.message).toContain("news 2")
    expect(snapshot.notes[19].notification.message).toContain("news 21")

    setup.setOutput("news 22")
    await runner.runNow(slug, "project", "nightly")
    await runner.acknowledgeNotifications(slug, [], snapshot.dropped)
    const remaining = await setup.runner().pendingNotifications(slug)
    expect(remaining.dropped).toBe(1)
    expect(remaining.notes).toHaveLength(20)
    expect(await runner.deliveredNotes(slug)).toEqual([])
  })

  test("retains only the latest 50 acknowledged notes", async () => {
    const setup = fixture()
    const runner = setup.runner()
    for (let index = 0; index < 55; index += 1) {
      setup.setOutput(`news ${index}`)
      await runner.runNow(slug, "project", "nightly")
      const pending = await runner.pendingNotifications(slug)
      await runner.acknowledgeNotifications(slug, pending.notes.map((note) => note.id))
    }
    const history = await setup.runner().deliveredNotes(slug)
    expect(history).toHaveLength(50)
    expect(history[0].notification.message).toContain("news 5")
    expect(history[49].notification.message).toContain("news 54")
    expect(await runner.pendingNotifications(slug)).toEqual({ notes: [], dropped: 0 })
  })

  test("bounds queued messages and stored error text to 16000 characters even for an oversized exception", async () => {
    const setup = fixture()
    const runner = setup.runner(setup.filesystem.port, async () => { throw new Error(`${"x".repeat(20_000)}last diagnostic`) })
    const result = await runner.runNow(slug, "project", "nightly")
    expect(result.kind).toBe("ran")
    if (result.kind !== "ran") throw new Error("watch did not run")
    expect(result.lastError!.length).toBeLessThanOrEqual(16_000)
    expect(result.notifications[0].message.length).toBeLessThanOrEqual(16_000)
    expect(result.notifications[0].message).toEndWith("last diagnostic")
    const pending = await setup.runner().pendingNotifications(slug)
    expect(pending.notes[0].notification).toEqual(result.notifications[0])
    expect((await setup.runner().listWatches(slug))[0].lastError).toBe(result.lastError)
  })

  test("restores failure suppression while recording repeated failures, and an empty success resets the streak", async () => {
    const setup = fixture()
    setup.setOutput("first failure log")
    setup.setExitCode(1)
    await setup.runner().runNow(slug, "project", "nightly")
    const runner = setup.runner()
    const first = await runner.pendingNotifications(slug)
    await runner.acknowledgeNotifications(slug, first.notes.map((note) => note.id))
    setup.clock.currentMs += 60_000
    setup.setOutput("second failure log")
    expect(await runner.runNow(slug, "project", "nightly")).toMatchObject({ kind: "ran", lastOutcome: "failed", notifications: [] })
    expect((await setup.runner().listWatches(slug))[0]).toMatchObject({
      lastRunAt: new Date(setup.clock.currentMs).toISOString(),
      lastOutput: "second failure log",
      lastOutcome: "failed",
      lastError: "exited with code 1",
    })
    expect((await setup.runner().pendingNotifications(slug)).notes).toEqual([])

    setup.setExitCode(0)
    setup.setOutput("  \n")
    expect(await runner.runNow(slug, "project", "nightly")).toMatchObject({ kind: "ran", lastOutcome: "empty", notifications: [] })
    expect((await setup.runner().listWatches(slug))[0].lastError).toBeUndefined()
    expect((await setup.runner().pendingNotifications(slug)).notes).toEqual([])
    setup.setExitCode(2)
    expect((await setup.runner().runNow(slug, "project", "nightly"))).toMatchObject({ kind: "ran", lastOutcome: "failed" })
    expect((await runner.pendingNotifications(slug)).notes).toHaveLength(1)
    expect(setup.deliveries).toEqual([])
  })

  test("serializes atomic commits for overlapping scheduled and manual runs of different watches", async () => {
    const setup = fixture()
    setup.filesystem.seedExecutableFile(`${homeRoot}/shared/watches/pr-watch`, "#!/bin/sh\n# schedule: @daily\n")
    const scheduledStarted = deferred<void>()
    const manualStarted = deferred<void>()
    const scheduledResult = deferred<void>()
    const manualResult = deferred<void>()
    const writeStarted = deferred<void>()
    const releaseWrite = deferred<void>()
    let activeWrites = 0
    let maximumActiveWrites = 0
    let writes = 0
    const port: FileSystemPort = {
      ...setup.filesystem.port,
      writeFile: async (path, contents) => {
        activeWrites += 1
        maximumActiveWrites = Math.max(maximumActiveWrites, activeWrites)
        writes += 1
        if (writes === 1) { writeStarted.resolve(); await releaseWrite.promise }
        await setup.filesystem.port.writeFile(path, contents)
        activeWrites -= 1
      },
    }
    const runner = setup.runner(port, async ({ scriptPath }) => {
      const manual = scriptPath.endsWith("pr-watch")
      if (manual) { manualStarted.resolve(); await manualResult.promise }
      else { scheduledStarted.resolve(); await scheduledResult.promise }
      return { stdout: manual ? "manual news" : "scheduled news", exitCode: 0, timedOut: false }
    })
    await runner.tick()
    setup.clock.currentMs += 60_000
    const scheduled = runner.tick()
    await scheduledStarted.promise
    const manual = runner.runNow(slug, "shared", "pr-watch")
    await manualStarted.promise
    scheduledResult.resolve()
    manualResult.resolve()
    await writeStarted.promise
    releaseWrite.resolve()
    expect((await scheduled).notifications).toHaveLength(1)
    expect(await manual).toMatchObject({ kind: "ran", lastOutcome: "ok" })
    const restored = setup.runner()
    expect((await restored.pendingNotifications(slug)).notes.map((note) => note.notification.watchName).sort()).toEqual(["nightly", "pr-watch"])
    expect((await restored.listWatches(slug)).map((watch) => watch.lastOutput).sort()).toEqual(["manual news", "scheduled news"])
    expect(maximumActiveWrites).toBe(1)
    expect(setup.filesystem.renamedFrom(watchStorePath(projectHome))).toEndWith(".tmp")
  })

  test("uses the 120000 ms default and leaves script-owned state outside the runner store", async () => {
    const setup = fixture()
    setup.filesystem.seedFile(`${projectHome}/watch-state/nightly/cursor.json`, "script state")
    await setup.runner().runNow(slug, "project", "nightly")
    expect(setup.calls[0].timeoutMs).toBe(120_000)
    expect(setup.calls[0].env.FIRSTMATE_WATCH_STATE).toBe(`${projectHome}/watch-state/nightly`)
    expect(setup.filesystem.fileContents(`${projectHome}/watch-state/nightly/cursor.json`)).toBe("script state")
  })

  test("persists independent failure streaks for shared and project watches with the same name", async () => {
    const setup = fixture()
    setup.filesystem.seedExecutableFile(`${homeRoot}/shared/watches/nightly`, "#!/bin/sh\n# schedule: @daily\n")
    setup.setExitCode(1)
    const runner = setup.runner()
    await Promise.all([
      runner.runNow(slug, "shared", "nightly"),
      runner.runNow(slug, "project", "nightly"),
    ])
    expect((await runner.pendingNotifications(slug)).notes.map((note) => note.notification.source).sort()).toEqual(["project", "shared"])
    const restarted = setup.runner()
    expect(await restarted.runNow(slug, "shared", "nightly")).toMatchObject({ kind: "ran", lastOutcome: "failed", notifications: [] })
    expect(await restarted.runNow(slug, "project", "nightly")).toMatchObject({ kind: "ran", lastOutcome: "failed", notifications: [] })
    expect((await restarted.listWatches(slug)).every((watch) => watch.lastOutcome === "failed")).toBe(true)
  })

  test("stores notes in the registered project home and keeps another project's shared-watch state separate", async () => {
    const setup = fixture()
    const elsewhereHome = "/other/project-home"
    const registry = JSON.parse(setup.filesystem.fileContents(`${homeRoot}/registry.json`))
    registry.elsewhere = { ...registry.sunrise, slug: "elsewhere", homeDirectory: elsewhereHome, coordinatorSessionId: "ses_coord_2" }
    setup.filesystem.seedFile(`${homeRoot}/registry.json`, JSON.stringify(registry))
    setup.filesystem.seedExecutableFile(`${homeRoot}/shared/watches/pr-watch`, "#!/bin/sh\n# schedule: @daily\n")
    const runner = setup.runner()
    await Promise.all([
      runner.runNow(slug, "shared", "pr-watch"),
      runner.runNow("elsewhere", "shared", "pr-watch"),
    ])
    const sunrise = await runner.pendingNotifications(slug)
    const elsewhere = await runner.pendingNotifications("elsewhere")
    expect(elsewhere.notes[0].notification).toMatchObject({ slug: "elsewhere", homeDirectory: elsewhereHome, coordinatorSessionId: "ses_coord_2" })
    expect(setup.filesystem.renamedFrom(watchStorePath(elsewhereHome))).toEndWith(".tmp")
    await runner.acknowledgeNotifications(slug, sunrise.notes.map((note) => note.id))
    expect(await setup.runner().pendingNotifications("elsewhere")).toEqual(elsewhere)
    expect(await runner.deliveredNotes("elsewhere")).toEqual([])
  })
})

describe("durable watch store failures", () => {
  test.each(["invalid JSON", "invalid schema", "unsupported version"])("fails closed on %s without executing or overwriting the store", async (corruption) => {
    const setup = fixture()
    const path = watchStorePath(projectHome)
    const text = corruption === "invalid JSON" ? "broken JSON" : corruption === "invalid schema" ? "{}" : JSON.stringify({ version: 2, runs: {}, pending: [], delivered: [], dropped: 0 })
    setup.filesystem.seedFile(path, text)
    const runner = setup.runner()
    await expect(runner.pendingNotifications(slug)).rejects.toBeInstanceOf(WatchStoreError)
    await expect(runner.deliveredNotes(slug)).rejects.toBeInstanceOf(WatchStoreError)
    await expect(runner.acknowledgeNotifications(slug, [])).rejects.toBeInstanceOf(WatchStoreError)
    await expect(runner.runNow(slug, "project", "nightly")).rejects.toBeInstanceOf(WatchStoreError)
    await expect(runner.listWatches(slug)).rejects.toBeInstanceOf(WatchStoreError)
    await runner.tick()
    setup.clock.currentMs += 60_000
    expect(await runner.tick()).toEqual({ notifications: [] })
    expect(setup.calls).toEqual([])
    expect(setup.filesystem.fileContents(path)).toBe(text)
    expect(setup.filesystem.renamedFrom(path)).toBeUndefined()
  })

  test.each(["exists", "read", "write", "rename"])("a failed %s cannot claim a committed run or suppress its next failure", async (failure) => {
    const setup = fixture()
    const original = setup.runner()
    await original.runNow(slug, "project", "nightly")
    const pending = await original.pendingNotifications(slug)
    const path = watchStorePath(projectHome)
    const originalText = setup.filesystem.fileContents(path)
    let fail = true
    const port: FileSystemPort = {
      ...setup.filesystem.port,
      exists: async (filePath) => {
        if (fail && failure === "exists" && filePath === path) throw new Error("disk offline")
        return setup.filesystem.port.exists(filePath)
      },
      readFile: async (filePath) => {
        if (fail && failure === "read" && filePath === path) throw new Error("disk offline")
        return setup.filesystem.port.readFile(filePath)
      },
      writeFile: async (filePath, contents) => {
        if (fail && failure === "write" && filePath.startsWith(path)) throw new Error("disk full")
        return setup.filesystem.port.writeFile(filePath, contents)
      },
      rename: async (from, to) => {
        if (fail && failure === "rename" && to === path) throw new Error("rename denied")
        return setup.filesystem.port.rename(from, to)
      },
    }
    setup.setExitCode(1)
    const runner = setup.runner(port)
    await expect(runner.runNow(slug, "project", "nightly")).rejects.toBeInstanceOf(WatchStoreError)
    expect(setup.filesystem.fileContents(path)).toBe(originalText)
    expect(await original.pendingNotifications(slug)).toEqual(pending)
    expect((await original.listWatches(slug))[0].lastOutcome).toBe("ok")
    await runner.tick()
    setup.clock.currentMs += 60_000
    expect(await runner.tick()).toEqual({ notifications: [] })
    expect(setup.filesystem.fileContents(path)).toBe(originalText)
    fail = false
    expect(await runner.runNow(slug, "project", "nightly")).toMatchObject({ kind: "ran", lastOutcome: "failed", notifications: [expect.anything()] })
    expect((await original.pendingNotifications(slug)).notes).toHaveLength(2)
    expect(setup.deliveries).toEqual([])
  })

  test.each(["read", "write", "rename"])("a failed %s during acknowledgement leaves pending notes and history unchanged", async (failure) => {
    const setup = fixture()
    const original = setup.runner()
    await original.runNow(slug, "project", "nightly")
    const pending = await original.pendingNotifications(slug)
    const path = watchStorePath(projectHome)
    const originalText = setup.filesystem.fileContents(path)
    const port: FileSystemPort = {
      ...setup.filesystem.port,
      readFile: async (filePath) => {
        if (failure === "read" && filePath === path) throw new Error("read denied")
        return setup.filesystem.port.readFile(filePath)
      },
      writeFile: async (filePath, contents) => {
        if (failure === "write" && filePath.startsWith(path)) throw new Error("write denied")
        return setup.filesystem.port.writeFile(filePath, contents)
      },
      rename: async (from, to) => {
        if (failure === "rename" && to === path) throw new Error("rename denied")
        return setup.filesystem.port.rename(from, to)
      },
    }
    await expect(setup.runner(port).acknowledgeNotifications(slug, pending.notes.map((note) => note.id))).rejects.toBeInstanceOf(WatchStoreError)
    expect(setup.filesystem.fileContents(path)).toBe(originalText)
    expect(await original.pendingNotifications(slug)).toEqual(pending)
    expect(await original.deliveredNotes(slug)).toEqual([])
  })

  test("a store corrupted during an execution is not overwritten when the run finishes", async () => {
    const setup = fixture()
    const started = deferred<void>()
    const finish = deferred<void>()
    const runner = setup.runner(setup.filesystem.port, async () => {
      started.resolve()
      await finish.promise
      return { stdout: "news", exitCode: 0, timedOut: false }
    })
    const running = runner.runNow(slug, "project", "nightly")
    await started.promise
    setup.filesystem.seedFile(watchStorePath(projectHome), "corrupt during run")
    finish.resolve()
    await expect(running).rejects.toBeInstanceOf(WatchStoreError)
    expect(setup.filesystem.fileContents(watchStorePath(projectHome))).toBe("corrupt during run")
    expect(setup.filesystem.renamedFrom(watchStorePath(projectHome))).toBeUndefined()
  })

  test.each([-1, 0.5, Number.NaN, Number.POSITIVE_INFINITY])("refuses an invalid dropped acknowledgement count %s", async (count) => {
    const setup = fixture()
    const runner = setup.runner()
    await runner.runNow(slug, "project", "nightly")
    const pending = await runner.pendingNotifications(slug)
    await expect(runner.acknowledgeNotifications(slug, pending.notes.map((note) => note.id), count)).rejects.toThrow("invalid dropped watch notification count")
    expect(await runner.pendingNotifications(slug)).toEqual(pending)
    expect(await runner.deliveredNotes(slug)).toEqual([])
  })
})
