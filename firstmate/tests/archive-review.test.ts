import { describe, expect, test } from "bun:test"
import { archiveSession } from "../service/archive"
import { archiveReviewPath, createArchiveReviewSweep } from "../service/archive-review"
import type { FileSystemPort } from "../service/file-system"
import type { Registration } from "../service/registry"
import { InMemoryFileSystem } from "./helpers/in-memory-file-system"

const homeRoot = "/home/firstmate"
const day = 24 * 60 * 60 * 1000
const start = Date.parse("2026-10-21T10:00:00Z")

function fixture() {
  const filesystem = new InMemoryFileSystem()
  const registrations: Record<string, Registration> = {}
  const deliveries: { registration: Registration; prompt: string }[] = []
  const errors: { slug: string; reason: string }[] = []
  let now = start
  let deliver: (registration: Registration, prompt: string) => Promise<boolean> = async () => true
  let cleanup: (registration: Registration) => Promise<boolean>
  function register(slug = "app") {
    const registration: Registration = {
      slug, projectDirectory: `/repos/${slug}`, homeDirectory: `${homeRoot}/projects/${slug}`,
      coordinatorSessionId: `ses_${slug}_coordinator`, createdAt: new Date(start).toISOString(),
    }
    registrations[slug] = registration
    filesystem.seedFile(`${homeRoot}/registry.json`, JSON.stringify(registrations))
    filesystem.seedFile(`${registration.homeDirectory}/backlog.md`, "- Old worker\n  state: Done\n  session: ses_old")
    return registration
  }
  const registration = register()
  function create(filesystemPort = filesystem.port) {
    return createArchiveReviewSweep({
      filesystem: filesystemPort, homeRoot, nowMs: () => now,
      deliver: async (current, prompt) => { deliveries.push({ registration: current, prompt }); return deliver(current, prompt) },
      cleanup,
      failed: (slug, reason) => { errors.push({ slug, reason }) },
    })
  }
  return {
    filesystem, registration, deliveries, errors, register, create,
    setNow(value: number) { now = value },
    setDeliver(value: typeof deliver) { deliver = value },
    setCleanup(value: typeof cleanup) { cleanup = value },
  }
}

describe("daily coordinator archival review", () => {
  test("requests review of legacy tracked workers on first check, without changing their backlog or archival state", async () => {
    const { filesystem, registration, deliveries, create } = fixture()
    const backlogBefore = filesystem.fileContents(`${registration.homeDirectory}/backlog.md`)
    await create().check()
    expect(deliveries).toHaveLength(1)
    const prompt = deliveries[0]!.prompt
    expect(prompt).toContain("Scheduled worker-session archival review")
    expect(prompt).toContain("archive-session: <exact current session id>")
    expect(prompt).toContain("Age, idle status, and a worker's own done claim aren't completion evidence")
    expect(prompt).toContain("Leave untracked sessions untouched")
    expect(prompt).toContain("Don't start, steer, interrupt, or relaunch workers")
    expect(filesystem.fileContents(`${registration.homeDirectory}/backlog.md`)).toBe(backlogBefore)
    expect(await filesystem.port.exists(`${registration.homeDirectory}/reports/archive.jsonl`)).toBe(false)
    expect(JSON.parse(filesystem.fileContents(archiveReviewPath(registration.homeDirectory)))).toEqual({ version: 1, lastDeliveredAt: new Date(start).toISOString() })
    expect(filesystem.renames.some((rename) => rename.toPath === archiveReviewPath(registration.homeDirectory))).toBe(true)
  })

  test("suppresses restart duplicates and becomes due exactly 24 hours after delivery", async () => {
    const { deliveries, create, setNow } = fixture()
    await create().check()
    const restarted = create()
    await restarted.check()
    setNow(start + day - 1)
    await restarted.check()
    expect(deliveries).toHaveLength(1)
    setNow(start + day)
    await restarted.check()
    expect(deliveries).toHaveLength(2)
  })

  test("uses successful delivery time, not check-start time", async () => {
    const { filesystem, registration, create, setNow, setDeliver } = fixture()
    setDeliver(async () => { setNow(start + 60_000); return true })
    await create().check()
    expect(JSON.parse(filesystem.fileContents(archiveReviewPath(registration.homeDirectory))).lastDeliveredAt).toBe(new Date(start + 60_000).toISOString())
  })

  test("deduplicates overlapping checks while delivery is in flight", async () => {
    const { deliveries, create, setDeliver } = fixture()
    let complete!: (sent: boolean) => void
    let started!: () => void
    const began = new Promise<void>((resolve) => { started = resolve })
    setDeliver(() => { started(); return new Promise<boolean>((resolve) => { complete = resolve }) })
    const sweep = create()
    const first = sweep.check()
    await began
    await sweep.check()
    expect(deliveries).toHaveLength(1)
    complete(true)
    await first
    await sweep.check()
    expect(deliveries).toHaveLength(1)
  })

  test("defers busy coordinators without saving a delivery timestamp", async () => {
    const { filesystem, registration, deliveries, create, setDeliver } = fixture()
    const sweep = create()
    setDeliver(async () => false)
    await sweep.check()
    expect(await filesystem.port.exists(archiveReviewPath(registration.homeDirectory))).toBe(false)
    setDeliver(async () => true)
    await sweep.check()
    expect(deliveries).toHaveLength(2)
    expect(await filesystem.port.exists(archiveReviewPath(registration.homeDirectory))).toBe(true)
  })

  test("a failed send stays due, and repeated identical failures are reported once", async () => {
    const { filesystem, registration, deliveries, errors, create, setDeliver } = fixture()
    const sweep = create()
    setDeliver(async () => { throw new Error("host offline") })
    await sweep.check()
    await sweep.check()
    expect(errors).toEqual([{ slug: "app", reason: "host offline" }])
    expect(await filesystem.port.exists(archiveReviewPath(registration.homeDirectory))).toBe(false)
    setDeliver(async () => true)
    await sweep.check()
    expect(deliveries).toHaveLength(3)
  })

  test("a slow project's delivery doesn't stop another project's review", async () => {
    const { register, deliveries, create, setDeliver } = fixture()
    register("other")
    let complete!: (sent: boolean) => void
    let otherStarted!: () => void
    const otherBegan = new Promise<void>((resolve) => { otherStarted = resolve })
    setDeliver(async (registration) => {
      if (registration.slug === "app") return new Promise<boolean>((resolve) => { complete = resolve })
      otherStarted()
      return true
    })
    const check = create().check()
    await otherBegan
    expect(deliveries.map((entry) => entry.registration.slug).sort()).toEqual(["app", "other"])
    complete(true)
    await check
  })

  test.each(["", "- Not dispatched\n  state: Queued", "- Coordinator\n  state: Done\n  session: ses_app_coordinator"])("doesn't wake a coordinator without tracked workers: %s", async (backlog) => {
    const { filesystem, registration, deliveries, create } = fixture()
    filesystem.seedFile(`${registration.homeDirectory}/backlog.md`, backlog)
    await create().check()
    expect(deliveries).toHaveLength(0)
    expect(await filesystem.port.exists(archiveReviewPath(registration.homeDirectory))).toBe(false)
  })

  test("skips confirmed host-archived workers but includes old board-only End entries", async () => {
    const { filesystem, deliveries, create } = fixture()
    await archiveSession(filesystem.port, homeRoot, "app", { sessionId: "ses_old", title: "Old worker", archivedAt: new Date(start).toISOString() })
    await create().check()
    expect(deliveries).toHaveLength(1)
    await archiveSession(filesystem.port, homeRoot, "app", { sessionId: "ses_old", title: "Old worker", archivedAt: new Date(start).toISOString(), hostArchived: true })
    // Remove the delivery timestamp to prove that candidates, not cadence,
    // prevent a second review.
    const onlyArchiveRecords: FileSystemPort = { ...filesystem.port, exists: async (filePath) => filePath.endsWith("archive-review.json") ? false : filesystem.port.exists(filePath) }
    await create(onlyArchiveRecords).check()
    expect(deliveries).toHaveLength(1)
  })

  test.each(["{", '{"version":2,"lastDeliveredAt":"2026-10-21T10:00:00Z"}', '{"version":1,"lastDeliveredAt":"invalid"}'])("fails closed without overwriting invalid review state: %s", async (state) => {
    const { filesystem, registration, deliveries, errors, create } = fixture()
    const filePath = archiveReviewPath(registration.homeDirectory)
    filesystem.seedFile(filePath, state)
    await create().check()
    expect(deliveries).toHaveLength(0)
    expect(errors).toHaveLength(1)
    expect(filesystem.fileContents(filePath)).toBe(state)
  })

  test("skips malformed or unreadable backlog evidence", async () => {
    const { filesystem, registration, deliveries, errors, create } = fixture()
    filesystem.seedFile(`${registration.homeDirectory}/backlog.md`, "- Broken\n  state: Invalid\n  session: ses_old")
    await create().check()
    expect(deliveries).toHaveLength(0)
    expect(errors).toHaveLength(1)
  })

  test("a failed timestamp save doesn't resend every supervision tick", async () => {
    const { filesystem, registration, deliveries, errors, create, setNow } = fixture()
    const brokenStore: FileSystemPort = { ...filesystem.port, rename: async () => { throw new Error("disk unavailable") } }
    const sweep = create(brokenStore)
    await sweep.check()
    await sweep.check()
    expect(deliveries).toHaveLength(1)
    expect(errors[0]!.reason).toContain("disk unavailable")
    expect(await filesystem.port.exists(archiveReviewPath(registration.homeDirectory))).toBe(false)
    setNow(start + day)
    await sweep.check()
    expect(deliveries).toHaveLength(1)
  })

  test("retries a failed timestamp save without resending, then suppresses review after restart", async () => {
    const { filesystem, registration, deliveries, create } = fixture()
    let storageAvailable = false
    const temporaryPaths: string[] = []
    const recoveringStore: FileSystemPort = { ...filesystem.port, rename: async (fromPath, toPath) => {
      temporaryPaths.push(fromPath)
      if (!storageAvailable) throw new Error("storage offline")
      await filesystem.port.rename(fromPath, toPath)
    } }
    const sweep = create(recoveringStore)
    await sweep.check()
    expect(deliveries).toHaveLength(1)
    expect(await filesystem.port.exists(archiveReviewPath(registration.homeDirectory))).toBe(false)
    storageAvailable = true
    await sweep.check()
    expect(deliveries).toHaveLength(1)
    expect(temporaryPaths[1]).toBe(temporaryPaths[0])
    await create().check()
    expect(deliveries).toHaveLength(1)
  })

  test("uses the latest registered coordinator after a replacement", async () => {
    const { filesystem, registration, deliveries, create, setDeliver } = fixture()
    const sweep = create()
    setDeliver(async () => false)
    await sweep.check()
    filesystem.seedFile(`${homeRoot}/registry.json`, JSON.stringify({ app: { ...registration, coordinatorSessionId: "ses_replacement" } }))
    setDeliver(async () => true)
    await sweep.check()
    expect(deliveries.at(-1)!.registration.coordinatorSessionId).toBe("ses_replacement")
  })

  test("cleans historical PR links even when every worker is host-archived, without waking the coordinator", async () => {
    const { filesystem, registration, deliveries, create, setCleanup, setNow } = fixture()
    await archiveSession(filesystem.port, homeRoot, "app", { sessionId: "ses_old", title: "Old worker", archivedAt: new Date(start).toISOString(), hostArchived: true })
    const cleaned: string[] = []
    setCleanup(async (current) => { cleaned.push(current.coordinatorSessionId); return true })
    await create().check()
    expect(cleaned).toEqual([registration.coordinatorSessionId])
    expect(deliveries).toHaveLength(0)
    expect(JSON.parse(filesystem.fileContents(archiveReviewPath(registration.homeDirectory)))).toEqual({ version: 1, lastCleanupAttemptAt: new Date(start).toISOString() })
    const restarted = create()
    await restarted.check()
    setNow(start + day)
    await restarted.check()
    expect(cleaned).toHaveLength(2)
  })

  test("cleans independently of a recent archive-review delivery and keeps both timestamps", async () => {
    const { filesystem, registration, deliveries, create, setCleanup } = fixture()
    await create().check()
    let cleaned = false
    setCleanup(async () => { cleaned = true; return true })
    await create().check()
    expect(cleaned).toBe(true)
    expect(deliveries).toHaveLength(1)
    expect(JSON.parse(filesystem.fileContents(archiveReviewPath(registration.homeDirectory)))).toEqual({ version: 1, lastDeliveredAt: new Date(start).toISOString(), lastCleanupAttemptAt: new Date(start).toISOString() })
  })

  test("defers busy cleanup and bounds failed cleanup to one attempt a day without blocking archival review", async () => {
    const { filesystem, registration, deliveries, errors, create, setCleanup, setDeliver, setNow } = fixture()
    let attempts = 0
    let activity = "busy"
    setCleanup(async () => { attempts += 1; if (activity === "busy") return false; throw new Error("unlink unavailable") })
    setDeliver(async () => false)
    const sweep = create()
    await sweep.check()
    expect(await filesystem.port.exists(archiveReviewPath(registration.homeDirectory))).toBe(false)
    activity = "idle"
    setDeliver(async () => true)
    await sweep.check()
    await sweep.check()
    expect(attempts).toBe(2)
    expect(errors).toHaveLength(1)
    expect(deliveries).toHaveLength(2)
    await create().check()
    expect(attempts).toBe(2)
    setNow(start + day)
    await sweep.check()
    expect(attempts).toBe(3)
    expect(errors).toHaveLength(2)
    await sweep.check()
    expect(errors).toHaveLength(2)
  })

  test("deduplicates cleanup while in flight and doesn't repeat it after a failed timestamp save", async () => {
    const { filesystem, create, setCleanup, setNow } = fixture()
    let complete!: (cleaned: boolean) => void
    let started!: () => void
    let attempts = 0
    const began = new Promise<void>((resolve) => { started = resolve })
    setCleanup(async () => { attempts += 1; started(); return new Promise<boolean>((resolve) => { complete = resolve }) })
    const temporaryPaths: string[] = []
    const brokenStore: FileSystemPort = { ...filesystem.port,
      writeFile: async (filePath, contents) => { temporaryPaths.push(filePath); await filesystem.port.writeFile(filePath, contents) },
      rename: async () => { throw new Error("disk unavailable") },
    }
    const sweep = create(brokenStore)
    const first = sweep.check()
    await began
    await sweep.check()
    expect(attempts).toBe(1)
    complete(true)
    await first
    await sweep.check()
    expect(attempts).toBe(1)
    setNow(start + day)
    await sweep.check()
    expect(attempts).toBe(1)
    expect(temporaryPaths.length).toBeGreaterThan(1)
    expect(new Set(temporaryPaths).size).toBe(1)
  })
})
