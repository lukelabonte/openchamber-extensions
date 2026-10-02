import type { FileSystemPort } from "./file-system"

// Extension-owned End state: an archived card is excluded from the board and
// from supervision, while the session and worktree are left exactly as they
// are. The log is one JSON object per line in the project home, so archive
// state survives a service restart and a torn final line (a crash mid-append)
// only costs that one entry.
export interface ArchiveEntry {
  sessionId: string
  title: string
  archivedAt: string
}

export function archivePath(homeRoot: string, slug: string): string {
  return `${homeRoot}/projects/${slug}/reports/archive.jsonl`
}

export async function loadArchivedSessionIds(filesystem: FileSystemPort, homeRoot: string, slug: string): Promise<Set<string>> {
  const filePath = archivePath(homeRoot, slug)
  if (!(await filesystem.exists(filePath))) return new Set()
  const ids = new Set<string>()
  for (const line of (await filesystem.readFile(filePath)).split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "") continue
    try {
      const parsed = JSON.parse(trimmed) as unknown
      if (isArchiveEntry(parsed)) ids.add(parsed.sessionId)
    } catch {
      // A torn or malformed line is skipped, not fatal.
    }
  }
  return ids
}

export async function archiveSession(filesystem: FileSystemPort, homeRoot: string, slug: string, entry: ArchiveEntry): Promise<void> {
  await filesystem.createDirectory(`${homeRoot}/projects/${slug}/reports`)
  await filesystem.appendFile(archivePath(homeRoot, slug), `${JSON.stringify(entry)}\n`)
}

function isArchiveEntry(value: unknown): value is ArchiveEntry {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as Record<string, unknown>).sessionId === "string" &&
    typeof (value as Record<string, unknown>).title === "string" &&
    typeof (value as Record<string, unknown>).archivedAt === "string"
  )
}
