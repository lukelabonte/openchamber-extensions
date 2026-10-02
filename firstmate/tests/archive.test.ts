import { describe, expect, test } from "bun:test"
import { archivePath, archiveSession, loadArchivedSessionIds } from "../service/archive"
import { InMemoryFileSystem } from "./helpers/in-memory-file-system"

const homeRoot = "/home/firstmate"

describe("archive", () => {
  test("a project that never archived anything loads as an empty set", async () => {
    const filesystem = new InMemoryFileSystem()
    expect(await loadArchivedSessionIds(filesystem.port, homeRoot, "sunrise")).toEqual(new Set())
  })

  test("archiving appends an entry that loads by session id and survives a restart", async () => {
    const filesystem = new InMemoryFileSystem()

    await archiveSession(filesystem.port, homeRoot, "sunrise", {
      sessionId: "ses_11bb",
      title: "Fix flaky login test",
      archivedAt: "2026-10-01T09:00:00.000Z",
    })

    const firstLoad = await loadArchivedSessionIds(filesystem.port, homeRoot, "sunrise")
    expect(firstLoad).toEqual(new Set(["ses_11bb"]))

    // A second load call stands in for a service restart: the state lives in
    // the project home, not in memory.
    const reloaded = await loadArchivedSessionIds(filesystem.port, homeRoot, "sunrise")
    expect(reloaded).toEqual(new Set(["ses_11bb"]))

    const entry = JSON.parse(filesystem.fileContents(archivePath(homeRoot, "sunrise")).trim()) as Record<string, unknown>
    expect(entry).toEqual({ sessionId: "ses_11bb", title: "Fix flaky login test", archivedAt: "2026-10-01T09:00:00.000Z" })
  })

  test("each archive is its own line in the jsonl log", async () => {
    const filesystem = new InMemoryFileSystem()

    await archiveSession(filesystem.port, homeRoot, "sunrise", { sessionId: "ses_1", title: "a", archivedAt: "t1" })
    await archiveSession(filesystem.port, homeRoot, "sunrise", { sessionId: "ses_2", title: "b", archivedAt: "t2" })

    const archived = await loadArchivedSessionIds(filesystem.port, homeRoot, "sunrise")
    expect(archived).toEqual(new Set(["ses_1", "ses_2"]))
  })

  test("a torn last line from a crash mid-append is skipped, earlier entries survive", async () => {
    const filesystem = new InMemoryFileSystem()
    filesystem.seedFile(
      archivePath(homeRoot, "sunrise"),
      `${JSON.stringify({ sessionId: "ses_1", title: "a", archivedAt: "t1" })}\n{"sessionId":"ses_2",`,
    )

    const archived = await loadArchivedSessionIds(filesystem.port, homeRoot, "sunrise")
    expect(archived).toEqual(new Set(["ses_1"]))
  })

  test("the archive is scoped per project home", async () => {
    const filesystem = new InMemoryFileSystem()
    await archiveSession(filesystem.port, homeRoot, "sunrise", { sessionId: "ses_1", title: "a", archivedAt: "t1" })

    expect(await loadArchivedSessionIds(filesystem.port, homeRoot, "storm")).toEqual(new Set())
  })
})
