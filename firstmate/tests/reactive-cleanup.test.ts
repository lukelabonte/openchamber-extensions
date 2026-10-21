import { describe, expect, test } from "bun:test"
import { archiveSession } from "../service/archive"
import { archiveReviewPath, createArchiveReviewSweep } from "../service/archive-review"
import { InMemoryFileSystem } from "./helpers/in-memory-file-system"

const homeRoot = "/fm"
const homeDirectory = "/fm/projects/app"
const registration = { slug: "app", projectDirectory: "/repo", homeDirectory, coordinatorSessionId: "ses_mate", createdAt: "2026-10-21T00:00:00Z" }
const start = Date.parse("2026-10-21T10:00:00Z")
const fiveMinutes = 5 * 60 * 1000
const task = (state = "Working", extra = "") => `- Ship search\n  state: ${state}\n  id: search\n  session: ses_worker\n  pr: https://github.com/owner/repo/pull/7\n${extra}`

function fixture() {
  const filesystem = new InMemoryFileSystem()
  filesystem.seedFile(`${homeRoot}/registry.json`, JSON.stringify({ app: registration }))
  filesystem.seedFile(`${homeDirectory}/backlog.md`, task())
  let now = start
  let busy = false
  let fail = false
  let beforeCleanup = async () => {}
  let beforeDeliver = async () => {}
  const cleanups: string[] = []
  const reviews: string[] = []
  const errors: string[] = []
  const create = () => createArchiveReviewSweep({
    filesystem: filesystem.port, homeRoot, nowMs: () => now,
    cleanup: async (current) => { if (busy) return false; cleanups.push(current.coordinatorSessionId); await beforeCleanup(); if (fail) throw new Error("host unavailable"); return true },
    deliver: async (current) => { if (busy) return false; reviews.push(current.coordinatorSessionId); await beforeDeliver(); return true },
    failed: (_slug, reason) => errors.push(reason),
  })
  return { filesystem, create, cleanups, reviews, errors,
    setNow(value: number) { now = value },
    setBusy(value: boolean) { busy = value },
    setFailure(value: boolean) { fail = value },
    beforeCleanup(value: typeof beforeCleanup) { beforeCleanup = value },
    beforeDeliver(value: typeof beforeDeliver) { beforeDeliver = value },
  }
}

describe("reactive cleanup reconciliation", () => {
  test("reacts to checked task completion on the next check, not the next day", async () => {
    const { filesystem, create, cleanups, reviews } = fixture()
    const sweep = create()
    await sweep.check()
    filesystem.seedFile(`${homeDirectory}/backlog.md`, task("Done"))
    await sweep.check()
    expect(cleanups).toHaveLength(2)
    expect(reviews).toHaveLength(2)
    await sweep.check()
    await create().check()
    expect(cleanups).toHaveLength(2)
    expect(reviews).toHaveLength(2)
  })

  test("coalesces changes while busy and reconciles the latest state once idle", async () => {
    const { filesystem, create, cleanups, reviews, setBusy } = fixture()
    const sweep = create()
    await sweep.check()
    setBusy(true)
    filesystem.seedFile(`${homeDirectory}/backlog.md`, task("Done", "  hold: keep available\n"))
    await sweep.check()
    filesystem.seedFile(`${homeDirectory}/backlog.md`, task("Done"))
    await sweep.check()
    expect(reviews).toHaveLength(1)
    setBusy(false)
    await sweep.check()
    await sweep.check()
    expect(cleanups).toHaveLength(2)
    expect(reviews).toHaveLength(2)
  })

  test("archival triggers historical PR cleanup without another review prompt", async () => {
    const { filesystem, create, cleanups, reviews } = fixture()
    filesystem.seedFile(`${homeDirectory}/backlog.md`, task("Done"))
    const sweep = create()
    await sweep.check()
    await archiveSession(filesystem.port, homeRoot, "app", { sessionId: "ses_worker", title: "Ship search", archivedAt: new Date(start).toISOString(), hostArchived: true })
    await sweep.check()
    expect(cleanups).toHaveLength(2)
    expect(reviews).toHaveLength(1)
  })

  test("report availability triggers reconciliation, but report rewrites and bookkeeping timestamps don't loop", async () => {
    const { filesystem, create, cleanups, reviews } = fixture()
    filesystem.seedFile(`${homeDirectory}/backlog.md`, task("Done"))
    const sweep = create()
    await sweep.check()
    filesystem.seedFile(`${homeDirectory}/reports/search.md`, "Verified outcome")
    await sweep.check()
    expect(cleanups).toHaveLength(2)
    expect(reviews).toHaveLength(2)
    filesystem.seedFile(`${homeDirectory}/reports/search.md`, "Verified outcome with review notes")
    filesystem.seedFile(`${homeDirectory}/backlog.md`, task("Done", "  updated: 2026-10-21T10:00:15Z\n  archive-session: ses_worker\n"))
    await sweep.check()
    expect(reviews).toHaveLength(2)
  })

  test("GitHub-only merges remain discoverable every five minutes for archived eligible PRs", async () => {
    const { filesystem, create, cleanups, reviews, setNow } = fixture()
    filesystem.seedFile(`${homeDirectory}/backlog.md`, task("Done"))
    filesystem.seedFile(`${homeDirectory}/reports/search.md`, "Verified outcome")
    await archiveSession(filesystem.port, homeRoot, "app", { sessionId: "ses_worker", title: "Ship search", archivedAt: new Date(start).toISOString(), hostArchived: true })
    await create().check()
    const restarted = create()
    setNow(start + fiveMinutes - 1)
    await restarted.check()
    expect(cleanups).toHaveLength(1)
    setNow(start + fiveMinutes)
    await restarted.check()
    expect(cleanups).toHaveLength(2)
    expect(reviews).toHaveLength(0)
  })

  test("a change arriving during cleanup isn't consumed as if that newer revision was handled", async () => {
    const { filesystem, create, cleanups, beforeCleanup } = fixture()
    let first = true
    beforeCleanup(async () => { if (first) { first = false; filesystem.seedFile(`${homeDirectory}/backlog.md`, task("Done")) } })
    const sweep = create()
    await sweep.check()
    await sweep.check()
    expect(cleanups).toHaveLength(2)
    await sweep.check()
    expect(cleanups).toHaveLength(2)
  })

  test("a change arriving during review delivery remains pending after restart", async () => {
    const { filesystem, create, reviews, beforeDeliver } = fixture()
    let first = true
    beforeDeliver(async () => { if (first) { first = false; filesystem.seedFile(`${homeDirectory}/backlog.md`, task("Done")) } })
    await create().check()
    await create().check()
    expect(reviews).toHaveLength(2)
  })

  test("failures back off for five minutes even when backlog changes or the service restarts", async () => {
    const { filesystem, create, cleanups, errors, setFailure, setNow } = fixture()
    setFailure(true)
    await create().check()
    filesystem.seedFile(`${homeDirectory}/backlog.md`, task("Done"))
    setNow(start + fiveMinutes - 1)
    await create().check()
    expect(cleanups).toHaveLength(1)
    setNow(start + fiveMinutes)
    await create().check()
    expect(cleanups).toHaveLength(2)
    expect(errors).toHaveLength(2)
  })

  test("new worker dispatch doesn't wake archival review, but a later Done transition does", async () => {
    const { filesystem, create, reviews } = fixture()
    const sweep = create()
    await sweep.check()
    filesystem.seedFile(`${homeDirectory}/backlog.md`, task() + "\n- Second worker\n  state: Working\n  id: second\n  session: ses_second\n")
    await sweep.check()
    expect(reviews).toHaveLength(1)
    filesystem.seedFile(`${homeDirectory}/backlog.md`, task() + "\n- Second worker\n  state: Done\n  id: second\n  session: ses_second\n")
    await sweep.check()
    expect(reviews).toHaveLength(2)
  })

  test("coordinator replacement invalidates old revision state and failure backoff", async () => {
    const { filesystem, create, cleanups, reviews } = fixture()
    await create().check()
    filesystem.seedFile(`${homeRoot}/registry.json`, JSON.stringify({ app: { ...registration, coordinatorSessionId: "ses_replacement" } }))
    await create().check()
    expect(cleanups).toEqual(["ses_mate", "ses_replacement"])
    expect(reviews).toEqual(["ses_mate", "ses_replacement"])
    expect(JSON.parse(filesystem.fileContents(archiveReviewPath(homeDirectory))).coordinatorSessionId).toBe("ses_replacement")
  })

  test("review-send failures retain their revision and back off across restart", async () => {
    const { filesystem, create, reviews, setNow, beforeDeliver } = fixture()
    beforeDeliver(async () => { throw new Error("delivery unavailable") })
    await create().check()
    filesystem.seedFile(`${homeDirectory}/backlog.md`, task("Done"))
    await create().check()
    expect(reviews).toHaveLength(1)
    expect(JSON.parse(filesystem.fileContents(archiveReviewPath(homeDirectory))).lastDeliveredAt).toBeUndefined()
    beforeDeliver(async () => {})
    setNow(start + fiveMinutes)
    await create().check()
    expect(reviews).toHaveLength(2)
    await create().check()
    expect(reviews).toHaveLength(2)
  })

  test("migrates legacy timestamps once, then persists reactive deduplication", async () => {
    const { filesystem, create, cleanups, reviews } = fixture()
    filesystem.seedFile(`${homeDirectory}/backlog.md`, task("Done"))
    filesystem.seedFile(archiveReviewPath(homeDirectory), JSON.stringify({ version: 1, lastDeliveredAt: new Date(start).toISOString(), lastCleanupAttemptAt: new Date(start).toISOString() }))
    await create().check()
    expect(cleanups).toHaveLength(1)
    expect(reviews).toHaveLength(1)
    await create().check()
    expect(cleanups).toHaveLength(1)
    expect(reviews).toHaveLength(1)
  })

  test("a reopened task can become newly eligible again without waiting a day", async () => {
    const { filesystem, create, reviews } = fixture()
    filesystem.seedFile(`${homeDirectory}/backlog.md`, task("Done"))
    await create().check()
    filesystem.seedFile(`${homeDirectory}/backlog.md`, task("Working"))
    await create().check()
    expect(reviews).toHaveLength(1)
    filesystem.seedFile(`${homeDirectory}/backlog.md`, task("Done"))
    await create().check()
    expect(reviews).toHaveLength(2)
  })
})
