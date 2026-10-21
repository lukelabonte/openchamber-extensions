import { createHash } from "node:crypto"
import { loadHostArchivedSessionIds } from "./archive"
import { loadBacklog } from "./backlog"
import type { FileSystemPort } from "./file-system"
import type { Registration } from "./registry"

// Hash identities and eligibility, not presentation or gate wording. Routine
// bookkeeping and the review's own prose mustn't become new review triggers.
export async function loadCleanupRevision(input: {
  filesystem: FileSystemPort
  homeRoot: string
  registration: Registration
  coordinatorIds: ReadonlySet<string>
}) {
  const { filesystem, homeRoot, registration, coordinatorIds } = input
  const backlog = await loadBacklog(filesystem, `${registration.homeDirectory}/backlog.md`)
  if (backlog.errors.length > 0) throw new Error("archive review is waiting for a readable backlog without malformed entries")
  const archived = await loadHostArchivedSessionIds(filesystem, homeRoot, registration.slug)
  const rows: Record<string, unknown>[] = []
  const reviewRows: Record<string, unknown>[] = []
  let hasWorkers = false
  let hasPullCandidates = false
  for (const task of backlog.tasks) {
    if (task.kind === "captain" || task.sessionId !== undefined && coordinatorIds.has(task.sessionId)) continue
    const hostArchived = task.sessionId !== undefined && archived.has(task.sessionId)
    const tracked = task.sessionId !== undefined
    if (tracked && !hostArchived) hasWorkers = true
    const reportPath = task.id === undefined ? undefined : `${registration.homeDirectory}/reports/${task.id}.md`
    const reportReady = reportPath !== undefined && ["Done", "Failed", "Idle"].includes(task.state) && await filesystem.exists(reportPath) && (await filesystem.readFile(reportPath)).trim() !== ""
    const row = {
      id: task.id, kind: task.kind, state: task.state, sessionId: task.sessionId, prUrl: task.prUrl,
      hasHold: task.hold !== undefined, hasDependency: task.blockedBy !== undefined,
      hasActions: (task.actions?.length ?? 0) > 0, reportReady, hostArchived,
    }
    // All references to a PR matter, including active ones that keep it linked.
    // Unrelated non-PR tasks cannot change the unlinking predicate.
    if (task.prUrl !== undefined) rows.push(row)
    if (tracked && !hostArchived && task.archiveSessionId !== task.sessionId && ["Done", "Failed", "Idle"].includes(task.state)) reviewRows.push(row)
    if (task.prUrl !== undefined && task.state === "Done" && tracked && hostArchived && reportReady && task.hold === undefined && task.blockedBy === undefined && (task.actions?.length ?? 0) === 0) hasPullCandidates = true
  }
  const fingerprint = (records: Record<string, unknown>[]) => createHash("sha256").update(JSON.stringify(records.map((record) => JSON.stringify(record)).sort())).digest("hex")
  return { cleanup: fingerprint(rows), review: fingerprint(reviewRows), hasWorkers, hasReviewCandidates: reviewRows.length > 0, hasPullCandidates }
}
