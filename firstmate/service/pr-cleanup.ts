import { loadHostArchivedSessionIds } from "./archive"
import { loadBacklog, type BacklogTask } from "./backlog"
import type { ExecRunner } from "./control-client"
import { callDesktopProxy } from "./desktop-proxy"
import type { FileSystemPort } from "./file-system"
import type { HttpFetcher, InterruptSupport } from "./interrupt"
import { loadRegistry, type Registration } from "./registry"

interface PullLink {
  id: string
  title: string
  kind: "pull"
  url: string
}

// Bookkeeping only. The host's per-entry operation preserves concurrently added
// links; sending a replacement metadata array would lose them. Like archival,
// this uses a private desktop route and requires a verified response body.
export async function cleanupCoordinatorPullRequests(input: {
  filesystem: FileSystemPort
  homeRoot: string
  registration: Registration
  exec: ExecRunner
  fetcher: HttpFetcher
  support: InterruptSupport
}): Promise<string[]> {
  const { filesystem, homeRoot, registration } = input
  const backlogPath = `${registration.homeDirectory}/backlog.md`
  const backlog = await loadBacklog(filesystem, backlogPath)
  if (backlog.errors.length > 0) throw new Error("PR cleanup needs a readable backlog without malformed entries")
  const archived = await loadHostArchivedSessionIds(filesystem, homeRoot, registration.slug)
  const candidates = new Set<string>()
  for (const task of backlog.tasks) {
    const url = canonicalPullUrl(task.prUrl)
    if (url === undefined || candidates.has(url)) continue
    const references = backlog.tasks.filter((entry) => canonicalPullUrl(entry.prUrl) === url)
    if (references.every((entry) => resolvedTask(entry, archived)) && await reportsExist(references)) candidates.add(url)
  }
  if (candidates.size === 0) return []
  const sessionPath = `/api/openchamber/sessions/${encodeURIComponent(registration.coordinatorSessionId)}`
  const observation = await callDesktopProxy({ ...input, method: "GET", path: `${sessionPath}/metadata?directory=${encodeURIComponent(registration.homeDirectory)}`, label: "PR cleanup metadata" })
  if (observation.kind !== "ok") throw new Error(observation.kind === "failed" ? observation.message : observation.reason)
  const links = readLinks(observation.text)
  const entries: PullLink[] = []
  for (const value of links) {
    if (!isPullLink(value)) continue
    const url = canonicalPullUrl(value.url)
    if (url === undefined || !candidates.has(url)) continue
    // An ambiguous identity would also remove a different thread in the host.
    if (links.some((other) => isRecord(other) && other.id === value.id && (!isPullLink(other) || canonicalPullUrl(other.url) !== url))) continue
    const response: unknown = JSON.parse(await input.exec("gh", ["pr", "view", url, "--json", "state,mergedAt,url"]))
    if (!isRecord(response) || canonicalPullUrl(response.url) !== url || !["OPEN", "CLOSED", "MERGED"].includes(response.state as string)) {
      throw new Error(`GitHub did not identify the requested PR: ${url}`)
    }
    if (response.state !== "MERGED") continue
    if (typeof response.mergedAt !== "string" || !Number.isFinite(Date.parse(response.mergedAt))) throw new Error(`GitHub did not confirm a merge time: ${url}`)
    entries.push(value)
  }
  if (entries.length === 0) return []
  // The CLI lookup can take time. Refuse a changed backlog or replacement
  // coordinator rather than applying a stale cleanup decision to either one.
  const current = (await loadRegistry(filesystem, homeRoot))[registration.slug]
  if (current?.coordinatorSessionId !== registration.coordinatorSessionId || current?.homeDirectory !== registration.homeDirectory || current?.projectDirectory !== registration.projectDirectory) {
    throw new Error("the registered first mate changed during PR cleanup")
  }
  const latest = await loadBacklog(filesystem, backlogPath)
  if (latest.errors.length > 0 || JSON.stringify(latest.tasks) !== JSON.stringify(backlog.tasks)) throw new Error("the backlog changed during PR cleanup")
  const references = backlog.tasks.filter((task) => entries.some((entry) => canonicalPullUrl(entry.url) === canonicalPullUrl(task.prUrl)))
  if (!(await reportsExist(references))) throw new Error("saved reports changed during PR cleanup")
  const outcome = await callDesktopProxy({
    ...input, method: "POST", path: `${sessionPath}/links`, label: "PR unlink",
    body: JSON.stringify({ directory: registration.homeDirectory, entries, linked: false }),
  })
  if (outcome.kind !== "ok") throw new Error(outcome.kind === "failed" ? outcome.message : outcome.reason)
  const remaining = readLinks(outcome.text, true)
  if (remaining.some((entry) => isRecord(entry) && entries.some((removed) => entry.id === removed.id || canonicalPullUrl(entry.url) === canonicalPullUrl(removed.url)))) {
    throw new Error("the host did not confirm removal of the completed PR links")
  }
  return [...new Set(entries.map((entry) => entry.url))]

  async function reportsExist(tasks: readonly BacklogTask[]): Promise<boolean> {
    for (const task of tasks) {
      const reportPath = `${registration.homeDirectory}/reports/${task.id}.md`
      if (!(await filesystem.exists(reportPath)) || (await filesystem.readFile(reportPath)).trim() === "") return false
    }
    return true
  }
}

function resolvedTask(task: BacklogTask, archived: ReadonlySet<string>): boolean {
  return task.state === "Done" && task.kind !== "captain" && task.id !== undefined && task.sessionId !== undefined && archived.has(task.sessionId)
    && task.hold === undefined && task.blockedBy === undefined && (task.actions?.length ?? 0) === 0
}

function canonicalPullUrl(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  try {
    const url = new URL(value)
    if (url.protocol !== "https:" || url.hostname !== "github.com" || url.port !== "" || url.username !== "" || url.password !== "") return undefined
    const match = /^\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/([1-9]\d*)\/?$/i.exec(url.pathname)
    return match === null ? undefined : `https://github.com/${match[1].toLowerCase()}/${match[2].toLowerCase()}/pull/${match[3]}`
  } catch {
    return undefined
  }
}

function readLinks(text: string | undefined, requireList = false): unknown[] {
  const parsed: unknown = JSON.parse(text ?? "null")
  if (!isRecord(parsed) || !isRecord(parsed.metadata)) throw new Error("the host did not return session metadata for PR cleanup")
  const metadata = parsed.metadata
  if (metadata.openchamber === undefined && !requireList) return []
  if (!isRecord(metadata.openchamber)) throw new Error("the host returned malformed PR link metadata")
  const links = metadata.openchamber.linked_issues
  if (links === undefined && !requireList) return []
  if (!Array.isArray(links)) throw new Error("the host returned a malformed PR link list")
  return links
}

function isPullLink(value: unknown): value is PullLink {
  return isRecord(value) && value.kind === "pull" && typeof value.id === "string" && value.id !== ""
    && typeof value.title === "string" && value.title !== "" && typeof value.url === "string"
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
