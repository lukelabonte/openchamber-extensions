import { createHash } from "node:crypto"
import { loadHostArchivedSessionIds } from "./archive"
import { loadBacklog } from "./backlog"
import type { FileSystemPort } from "./file-system"
import type { Registration } from "./registry"

// Hash facts that can change cleanup eligibility, not timestamps, report prose,
// live running/idle status or the review's own archive-session request. Those
// would turn a review into another review trigger.
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
      id: task.id, title: task.title, kind: task.kind, state: task.state, sessionId: task.sessionId,
      worktreeDirectory: task.worktreeDirectory, branch: task.branch, startRef: task.startRef,
      prUrl: task.prUrl, hold: task.hold, blockedBy: task.blockedBy, actions: task.actions,
      reviewHead: task.reviewHead, reportReady, hostArchived,
    }
    rows.push(row)
    if (tracked && !hostArchived && task.archiveSessionId !== task.sessionId && ["Done", "Failed", "Idle"].includes(task.state)) reviewRows.push(row)
    if (task.prUrl !== undefined && task.state === "Done" && tracked && hostArchived && reportReady && task.hold === undefined && task.blockedBy === undefined && (task.actions?.length ?? 0) === 0) hasPullCandidates = true
  }
  const fingerprint = (records: Record<string, unknown>[]) => createHash("sha256").update(JSON.stringify(records.map((record) => JSON.stringify(record)).sort())).digest("hex")
  return { cleanup: fingerprint(rows), review: fingerprint(reviewRows), hasWorkers, hasReviewCandidates: reviewRows.length > 0, hasPullCandidates }
}
