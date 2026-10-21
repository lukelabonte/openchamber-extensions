import { randomUUID } from "node:crypto"
import { loadHostArchivedSessionIds } from "./archive"
import { loadBacklog } from "./backlog"
import type { FileSystemPort } from "./file-system"
import { resolveProjectHomeDirectory } from "./launch"
import { loadRegistry, type Registration } from "./registry"
import { normalizeProjectDirectory } from "./slug"

const reviewIntervalMs = 24 * 60 * 60 * 1000

interface ReviewProgress {
  lastDeliveredAt?: number
  lastCleanupAttemptAt?: number
}

// Static instructions avoid treating backlog titles or worker output as orders.
// This schedules a decision by the coordinator, never archival by age or idle.
const reviewPrompt = `Scheduled worker-session archival review for this project only.

Read backlog.md and the saved briefs and reports. Follow the charter's cleanup process. Review tracked worker sessions, including legacy entries and board-only End entries. Check live status and evidence before deciding which sessions no longer need review, follow-up, or an open decision. Reconcile missing task IDs or reports before requesting retirement. Age, idle status, and a worker's own done claim aren't completion evidence.

Respect the captain's orders and requests to keep sessions active. Save checked results, evidence and message links, session/worktree references, and the retirement reason in reports/<id>.md. Only for a genuinely Done task with no remaining dependency, hold, or answer action, add archive-session: <exact current session id> to its backlog entry. The service checks ownership, a saved report, idle status, and pending questions/permissions. Wait for its confirmation before claiming archival. Leave failed archive attempts paused until their failure has been reconciled.

Keep running, waiting, failed, unknown, or unresolved workers available. Leave untracked sessions untouched. Don't start, steer, interrupt, or relaunch workers. This review doesn't authorize landing, scope expansion, deletion, discard, or repository cleanup. Preserve conversations, branches, worktrees, and existing evidence. Keep routine no-change results quiet; report real failures or decisions.`

export function archiveReviewPath(homeDirectory: string): string {
  return `${homeDirectory}/archive-review.json`
}

export function createArchiveReviewSweep(input: {
  filesystem: FileSystemPort
  homeRoot: string
  nowMs(): number
  // False means deferred (busy or released), not successfully delivered.
  deliver(registration: Registration, prompt: string): Promise<boolean>
  // Runs independently of archival candidates, including historical workers.
  // False defers a busy coordinator. Failures are reported and retried next day.
  cleanup?(registration: Registration): Promise<boolean>
  failed(slug: string, reason: string): void
}) {
  const inFlight = new Set<string>()
  const progress = new Map<string, ReviewProgress>()
  const pendingSaves = new Map<string, { progress: ReviewProgress; temporaryPath: string }>()
  const failures = new Map<string, string>()

  function reportFailure(slug: string, error: unknown): void {
    const reason = error instanceof Error ? error.message : String(error)
    if (failures.get(slug) === reason) return
    failures.set(slug, reason)
    input.failed(slug, reason)
  }

  async function saveProgress(slug: string, filePath: string, pending: { progress: ReviewProgress; temporaryPath: string }): Promise<void> {
    // Reuse the temporary path after a failed save rather than accumulating a
    // new file per tick. Successful rename consumes it on the host filesystem.
    const state = { version: 1 }
    for (const [key, value] of Object.entries(pending.progress)) state[key] = new Date(value).toISOString()
    await input.filesystem.writeFile(pending.temporaryPath, `${JSON.stringify(state, null, 2)}\n`)
    await input.filesystem.rename(pending.temporaryPath, filePath)
    pendingSaves.delete(slug)
    failures.delete(slug)
  }

  async function reviewProject(registration: Registration, coordinatorIds: ReadonlySet<string>): Promise<void> {
    const { slug } = registration
    if (inFlight.has(slug)) return
    inFlight.add(slug)
    try {
      const homeDirectory = resolveProjectHomeDirectory(input.homeRoot, slug)
      if (normalizeProjectDirectory(registration.homeDirectory) !== homeDirectory) throw new Error("archive review project home doesn't match its registration")
      const filePath = archiveReviewPath(homeDirectory)
      const current = { ...progress.get(slug) }
      const persisted: ReviewProgress = {}
      if (await input.filesystem.exists(filePath)) {
        let parsed: unknown
        try {
          parsed = JSON.parse(await input.filesystem.readFile(filePath))
        } catch {
          throw new Error(`archive review state is unreadable: ${filePath}`)
        }
        if (typeof parsed !== "object" || parsed === null || !("version" in parsed) || parsed.version !== 1 || (!("lastDeliveredAt" in parsed) && !("lastCleanupAttemptAt" in parsed))) {
          throw new Error(`archive review state is invalid: ${filePath}`)
        }
        for (const key of ["lastDeliveredAt", "lastCleanupAttemptAt"] as const) {
          if (!(key in parsed)) continue
          if (typeof parsed[key] !== "string" || !Number.isFinite(Date.parse(parsed[key]))) throw new Error(`archive review state is invalid: ${filePath}`)
          persisted[key] = Date.parse(parsed[key])
          current[key] = Math.max(current[key] ?? -Infinity, persisted[key])
        }
      }
      const pendingSave = pendingSaves.get(slug)
      if (pendingSave !== undefined) {
        if (Object.entries(pendingSave.progress).every(([key, value]) => persisted[key] !== undefined && persisted[key] >= value)) pendingSaves.delete(slug)
        else await saveProgress(slug, filePath, pendingSave)
      }
      progress.set(slug, current)
      if (input.cleanup !== undefined && (current.lastCleanupAttemptAt === undefined || input.nowMs() - current.lastCleanupAttemptAt >= reviewIntervalMs)) {
        let attempted = false
        // Deduplicate within an attempt, not across separate daily attempts.
        failures.delete(`${slug}:cleanup`)
        try {
          attempted = await input.cleanup(registration)
        } catch (error) {
          attempted = true
          reportFailure(`${slug}:cleanup`, error)
        }
        if (attempted) {
          current.lastCleanupAttemptAt = input.nowMs()
          const pending = { progress: { ...current }, temporaryPath: `${filePath}.${randomUUID()}.tmp` }
          pendingSaves.set(slug, pending)
          await saveProgress(slug, filePath, pending)
        }
      }
      if (current.lastDeliveredAt !== undefined && input.nowMs() - current.lastDeliveredAt < reviewIntervalMs) return
      const backlog = await loadBacklog(input.filesystem, `${homeDirectory}/backlog.md`)
      if (backlog.errors.length > 0) throw new Error("archive review is waiting for a readable backlog without malformed entries")
      // Board-only End never archived the host session. Include those workers
      // so the sweep can reconcile old, hidden cards as well as visible ones.
      const archived = await loadHostArchivedSessionIds(input.filesystem, input.homeRoot, slug)
      if (!backlog.tasks.some((task) => task.sessionId !== undefined && !coordinatorIds.has(task.sessionId) && !archived.has(task.sessionId))) return
      if (!(await input.deliver(registration, reviewPrompt))) return
      // CLI acceptance is not review completion. Remember it before saving so
      // a storage failure doesn't resend the prompt every supervision tick.
      const completedAt = input.nowMs()
      current.lastDeliveredAt = completedAt
      const pending = { progress: { ...current }, temporaryPath: `${filePath}.${randomUUID()}.tmp` }
      pendingSaves.set(slug, pending)
      await saveProgress(slug, filePath, pending)
    } catch (error) {
      reportFailure(slug, error)
    } finally {
      inFlight.delete(slug)
    }
  }

  async function check(): Promise<void> {
    try {
      const registrations = Object.values(await loadRegistry(input.filesystem, input.homeRoot))
      const coordinatorIds = new Set(registrations.map((registration) => registration.coordinatorSessionId))
      await Promise.all(registrations.map((registration) => reviewProject(registration, coordinatorIds)))
    } catch (error) {
      reportFailure("registry", error)
    }
  }

  return { check }
}
