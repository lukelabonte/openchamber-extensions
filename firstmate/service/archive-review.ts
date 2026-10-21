import { randomUUID } from "node:crypto"
import type { FileSystemPort } from "./file-system"
import { resolveProjectHomeDirectory } from "./launch"
import { loadRegistry, type Registration } from "./registry"
import { normalizeProjectDirectory } from "./slug"
import { loadCleanupRevision } from "./cleanup-revision"

const reviewIntervalMs = 24 * 60 * 60 * 1000
const retryIntervalMs = 5 * 60 * 1000

interface ReviewProgress {
  coordinatorSessionId?: string
  projectDirectory?: string
  lastDeliveredAt?: number
  lastReviewAttemptAt?: number
  lastCleanupAttemptAt?: number
  reviewFingerprint?: string
  cleanupFingerprint?: string
  reviewFailed?: boolean
  cleanupFailed?: boolean
}

// Static instructions avoid treating backlog titles or worker output as orders.
// This schedules a decision by the coordinator, never archival by age or idle.
const reviewPrompt = `Scheduled worker-session archival review for this project only.

Read backlog.md and the saved briefs and reports. Follow the charter's cleanup process. Review tracked worker sessions, including legacy entries and board-only End entries. Check live status and evidence before deciding which sessions no longer need review, follow-up, or an open decision. Reconcile missing task IDs or reports before requesting retirement. Age, idle status, and a worker's own done claim aren't completion evidence.

Run the guarded command in the composed PR link cleanup instructions as part of this audit. Record its confirmed removals, keep unresolved links, and report failures. It changes only coordinator link metadata and never authorizes repository deletion.

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
  // False defers a busy coordinator without consuming its revision or slot.
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
    const state: Record<string, unknown> = { version: 2, ...pending.progress }
    for (const key of ["lastDeliveredAt", "lastReviewAttemptAt", "lastCleanupAttemptAt"] as const) {
      if (pending.progress[key] !== undefined) state[key] = new Date(pending.progress[key]).toISOString()
    }
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
      let persisted: ReviewProgress = {}
      if (await input.filesystem.exists(filePath)) {
        try {
          persisted = parseProgress(JSON.parse(await input.filesystem.readFile(filePath)))
        } catch {
          throw new Error(`archive review state is unreadable or invalid: ${filePath}`)
        }
      }
      const current = mergeProgress(persisted, progress.get(slug), registration)
      const pendingSave = pendingSaves.get(slug)
      if (pendingSave !== undefined) {
        if (Object.entries(pendingSave.progress).every(([key, value]) => persisted[key] === value)) pendingSaves.delete(slug)
        else await saveProgress(slug, filePath, pendingSave)
      }
      progress.set(slug, current)
      // Capture once, before any callback. A newer revision arriving during a
      // cleanup/send stays pending for the next tick, including after restart.
      const revision = await loadCleanupRevision({ ...input, registration, coordinatorIds })
      const cleanupInterval = revision.hasPullCandidates || current.cleanupFailed ? retryIntervalMs : reviewIntervalMs
      const cleanupBackoff = current.cleanupFailed && current.lastCleanupAttemptAt !== undefined && input.nowMs() - current.lastCleanupAttemptAt < retryIntervalMs
      const cleanupDue = current.cleanupFingerprint !== revision.cleanup || current.lastCleanupAttemptAt === undefined || input.nowMs() - current.lastCleanupAttemptAt >= cleanupInterval
      if (input.cleanup !== undefined && cleanupDue && !cleanupBackoff) {
        let attempted = false
        failures.delete(`${slug}:cleanup`)
        try {
          attempted = await input.cleanup(registration)
          if (attempted) current.cleanupFailed = false
        } catch (error) {
          attempted = true
          current.cleanupFailed = true
          reportFailure(`${slug}:cleanup`, error)
        }
        if (attempted) {
          current.lastCleanupAttemptAt = input.nowMs()
          current.cleanupFingerprint = revision.cleanup
          await remember()
        }
      }
      if (!revision.hasReviewCandidates && current.reviewFingerprint !== revision.review) {
        // Observing no eligible work is a no-op, not prompt delivery. Remember
        // the empty baseline so a reopened task can become newly eligible again.
        current.reviewFingerprint = revision.review
        if (current.lastDeliveredAt !== undefined || current.lastCleanupAttemptAt !== undefined || current.lastReviewAttemptAt !== undefined) await remember()
      }
      const reviewBackoff = current.reviewFailed && current.lastReviewAttemptAt !== undefined && input.nowMs() - current.lastReviewAttemptAt < retryIntervalMs
      const reviewDue = current.lastDeliveredAt === undefined || input.nowMs() - current.lastDeliveredAt >= reviewIntervalMs || revision.hasReviewCandidates && current.reviewFingerprint !== revision.review
      if (!revision.hasWorkers || !reviewDue || reviewBackoff) return
      failures.delete(`${slug}:review`)
      try {
        if (!(await input.deliver(registration, reviewPrompt))) return
        current.lastDeliveredAt = input.nowMs()
        current.reviewFingerprint = revision.review
        current.reviewFailed = false
      } catch (error) {
        current.reviewFailed = true
        reportFailure(`${slug}:review`, error)
      }
      current.lastReviewAttemptAt = input.nowMs()
      // Host acceptance isn't review completion. Remember it before saving so
      // a storage failure doesn't resend the prompt every supervision tick.
      await remember()

      async function remember(): Promise<void> {
        progress.set(slug, { ...current })
        const pending = { progress: { ...current }, temporaryPath: pendingSaves.get(slug)?.temporaryPath ?? `${filePath}.${randomUUID()}.tmp` }
        pendingSaves.set(slug, pending)
        await saveProgress(slug, filePath, pending)
      }
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

function parseProgress(parsed: unknown): ReviewProgress {
  if (typeof parsed !== "object" || parsed === null || !("version" in parsed) || ![1, 2].includes(parsed.version as number)) throw new Error("invalid review state")
  const value = parsed as Record<string, unknown>
  const result: ReviewProgress = {}
  for (const key of ["lastDeliveredAt", "lastReviewAttemptAt", "lastCleanupAttemptAt"] as const) {
    if (!(key in value)) continue
    if (typeof value[key] !== "string" || !Number.isFinite(Date.parse(value[key]))) throw new Error("invalid review timestamp")
    result[key] = Date.parse(value[key])
  }
  if (result.lastDeliveredAt === undefined && result.lastReviewAttemptAt === undefined && result.lastCleanupAttemptAt === undefined) throw new Error("missing review timestamp")
  if (value.version === 1) return result
  for (const key of ["coordinatorSessionId", "projectDirectory"] as const) {
    if (typeof value[key] !== "string" || value[key] === "") throw new Error("missing review scope")
    result[key] = value[key]
  }
  for (const key of ["reviewFingerprint", "cleanupFingerprint"] as const) {
    if (!(key in value)) continue
    if (typeof value[key] !== "string" || !/^[a-f0-9]{64}$/.test(value[key])) throw new Error("invalid review fingerprint")
    result[key] = value[key]
  }
  for (const key of ["reviewFailed", "cleanupFailed"] as const) {
    if (!(key in value)) continue
    if (typeof value[key] !== "boolean") throw new Error("invalid review retry state")
    result[key] = value[key]
  }
  return result
}

function mergeProgress(persisted: ReviewProgress, local: ReviewProgress | undefined, registration: Registration): ReviewProgress {
  const matchesScope = (entry: ReviewProgress) => entry.coordinatorSessionId === undefined || entry.coordinatorSessionId === registration.coordinatorSessionId && entry.projectDirectory === registration.projectDirectory
  const disk = matchesScope(persisted) ? persisted : {}
  const memory = local !== undefined && matchesScope(local) ? local : {}
  const review = (memory.lastReviewAttemptAt ?? memory.lastDeliveredAt ?? -Infinity) >= (disk.lastReviewAttemptAt ?? disk.lastDeliveredAt ?? -Infinity) ? memory : disk
  const cleanup = (memory.lastCleanupAttemptAt ?? -Infinity) >= (disk.lastCleanupAttemptAt ?? -Infinity) ? memory : disk
  return {
    coordinatorSessionId: registration.coordinatorSessionId, projectDirectory: registration.projectDirectory,
    lastDeliveredAt: review.lastDeliveredAt, lastReviewAttemptAt: review.lastReviewAttemptAt,
    reviewFingerprint: review.reviewFingerprint, reviewFailed: review.reviewFailed,
    lastCleanupAttemptAt: cleanup.lastCleanupAttemptAt, cleanupFingerprint: cleanup.cleanupFingerprint, cleanupFailed: cleanup.cleanupFailed,
  }
}
