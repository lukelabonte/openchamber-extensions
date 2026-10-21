import { archiveSession, loadHostArchivedSessionIds } from "./archive"
import { formatBacklogEntry, loadBacklog } from "./backlog"
import { sessionStatus, type ExecRunner } from "./control-client"
import { callDesktopProxy } from "./desktop-proxy"
import type { FileSystemPort } from "./file-system"
import type { HttpFetcher, InterruptSupport } from "./interrupt"
import { loadRegistry } from "./registry"
import { fetchSessionInfo } from "./session-observation"

export type WorkerArchiveOutcome =
  | { kind: "archived" }
  | { kind: "already-archived" }
  | { kind: "refused" | "failed"; reason: string }

// A coordinator opts in for one exact session, not every Done task or future
// replacement worker. Host archival is reversible and never removes a worktree.
// The host has no atomic idle-only archive, so the live checks below are best
// effort: a concurrent external sender can still start a turn after the check.
export async function archiveFinishedWorker(input: {
  filesystem: FileSystemPort
  exec: ExecRunner
  fetcher: HttpFetcher
  support: InterruptSupport
  homeRoot: string
  slug: string
  sessionId: string
  blockingState: "clear" | "waiting" | "unknown"
  nowMs: () => number
}): Promise<WorkerArchiveOutcome> {
  const { filesystem, homeRoot, slug, sessionId } = input
  const refuse = (reason: string): WorkerArchiveOutcome => ({ kind: "refused", reason })
  try {
    const registrations = await loadRegistry(filesystem, homeRoot)
    const registration = Object.hasOwn(registrations, slug) ? registrations[slug] : undefined
    if (registration === undefined) return refuse("the project has no registered first mate")
    if (Object.values(registrations).some((entry) => entry.coordinatorSessionId === sessionId)) {
      return refuse("a coordinator session cannot be archived as a worker")
    }
    const backlogPath = `${homeRoot}/projects/${slug}/backlog.md`
    const backlog = await loadBacklog(filesystem, backlogPath)
    const matches = backlog.tasks.filter((task) => task.sessionId === sessionId)
    if (backlog.errors.length > 0 || matches.length !== 1) return refuse("worker ownership is missing or ambiguous in the backlog")
    const task = matches[0]!
    if (task.archiveSessionId !== sessionId) return refuse("the coordinator has not requested archival of this exact session")
    if (task.state !== "Done" || task.hold !== undefined || task.blockedBy !== undefined || (task.actions?.length ?? 0) > 0) {
      return refuse("the task must be Done with no unresolved dependencies, holds, or decisions")
    }
    if (task.id === undefined || task.kind === "captain") return refuse("the worker needs a task id and a saved outcome")
    for (const other of Object.values(registrations)) {
      if (other.slug === slug) continue
      const otherBacklog = await loadBacklog(filesystem, `${homeRoot}/projects/${other.slug}/backlog.md`)
      if (otherBacklog.errors.length > 0 || otherBacklog.tasks.some((entry) => entry.sessionId === sessionId)) {
        return refuse("exclusive worker ownership could not be established across projects")
      }
    }
    const archived = await loadHostArchivedSessionIds(filesystem, homeRoot, slug)
    if (archived.has(sessionId)) return { kind: "already-archived" }
    if (input.blockingState !== "clear") return refuse("the worker has pending questions or permissions, or their state is unknown")
    const reportPath = `${homeRoot}/projects/${slug}/reports/${task.id}.md`
    if (!(await filesystem.exists(reportPath)) || (await filesystem.readFile(reportPath)).trim() === "") {
      return refuse("save the checked outcome and evidence in the task report before archiving")
    }
    if (input.support.kind === "unsupported") return { kind: "failed", reason: input.support.reason }
    const directory = task.worktreeDirectory ?? registration.projectDirectory
    // Verify existence as well as activity: the host archive route itself
    // accepts arbitrary IDs, and a missing entry in a status list proves nothing.
    const info = await fetchSessionInfo({ fetcher: input.fetcher, support: input.support, sessionId, directory })
    if (info.kind !== "ok") return { kind: "failed", reason: info.reason }
    const status = await sessionStatus(input.exec, { sessionId, directory })
    if (status.activity !== "idle") return refuse("the worker is not confirmed idle")
    const latest = await loadBacklog(filesystem, backlogPath)
    const latestMatches = latest.tasks.filter((entry) => entry.sessionId === sessionId)
    if (latest.errors.length > 0 || latestMatches.length !== 1 || formatBacklogEntry(latestMatches[0]!) !== formatBacklogEntry(task)) {
      return refuse("the task changed during archive checks; reconcile it before trying again")
    }
    const outcome = await callDesktopProxy({
      fetcher: input.fetcher, support: input.support, method: "POST",
      path: "/api/openchamber/sessions/archive", body: JSON.stringify({ ids: [sessionId] }), label: "session archive",
    })
    if (outcome.kind !== "ok") return { kind: "failed", reason: outcome.kind === "failed" ? outcome.message : outcome.reason }
    if (!confirmsArchive(outcome.text, sessionId)) return { kind: "failed", reason: "the host did not confirm archival of the requested session" }
    // Record local retirement only after host confirmation. If this append
    // fails, leave the request available to retry the idempotent host operation.
    try {
      await archiveSession(filesystem, homeRoot, slug, { sessionId, title: task.title, archivedAt: new Date(input.nowMs()).toISOString(), hostArchived: true })
    } catch {
      return { kind: "failed", reason: "the host confirmed archival, but local board retirement could not be saved; reconcile both records before retrying" }
    }
    return { kind: "archived" }
  } catch {
    return { kind: "failed", reason: "worker archival could not be completed; reconcile live session and archive records before retrying" }
  }
}

function confirmsArchive(text: string | undefined, sessionId: string): boolean {
  if (text === undefined) return false
  try {
    const parsed = JSON.parse(text)
    if (typeof parsed !== "object" || parsed === null || !Array.isArray(parsed.archived) || !Array.isArray(parsed.failedIds)) return false
    if (parsed.failedIds.length !== 0 || parsed.archived.length !== 1) return false
    const entry = parsed.archived[0]
    return typeof entry === "object" && entry !== null && entry.id === sessionId && Number.isSafeInteger(entry.archivedAt) && entry.archivedAt > 0
  } catch {
    return false
  }
}
