import { associateSessionProject, MissingCliError, UnsupportedSessionProjectError, type ExecRunner } from "./control-client"
import type { FileSystemPort } from "./file-system"
import { loadRegistry, type Registration } from "./registry"
import { callDesktopProxy } from "./desktop-proxy"
import type { HttpFetcher, InterruptSupport } from "./interrupt"
import { normalizeProjectDirectory } from "./slug"
import { isAbsolute } from "node:path"

export interface SessionProjectDesktop {
  fetcher: HttpFetcher
  support: InterruptSupport
}

export async function associateFirstMateSession(exec: ExecRunner, registration: Registration, desktop: SessionProjectDesktop): Promise<void> {
  try {
    await associateSessionProject(exec, {
      sessionId: registration.coordinatorSessionId,
      directory: registration.homeDirectory,
      projectDirectory: registration.projectDirectory,
    })
  } catch (error) {
    if (error instanceof MissingCliError) throw error
    try {
      if (!(error instanceof UnsupportedSessionProjectError)) throw error
      await associateThroughMetadata(desktop, registration)
    } catch (failure) {
      throw new Error(`first mate ${registration.coordinatorSessionId} is saved, but its sidebar project association failed: ${failure instanceof Error ? failure.message : String(failure)}`)
    }
  }
}

// The desktop can support display ownership even when the separately installed
// CLI does not. Its native metadata route merges this leaf under a per-session
// lock and publishes an update. Never send a read/modified metadata replacement.
async function associateThroughMetadata(desktop: SessionProjectDesktop, registration: Registration): Promise<void> {
  if (desktop.support.kind === "unsupported") return
  const sessionId = registration.coordinatorSessionId
  const directory = registration.homeDirectory
  if (sessionId.trim() === "" || !isAbsolute(directory) || !isAbsolute(registration.projectDirectory)) throw new Error("sidebar association requires an exact session and absolute home and project directories")
  const sessionPath = `/api/openchamber/sessions/${encodeURIComponent(sessionId)}/metadata`
  let readStatus: number | undefined
  const observation = await callDesktopProxy({
    ...desktop, method: "GET", path: `${sessionPath}?directory=${encodeURIComponent(directory)}`, label: "sidebar metadata",
    fetcher: async (url, init) => {
      const response = await desktop.fetcher(url, init)
      readStatus = response.status
      return response
    },
  })
  // Older hosts may not expose this route. Authentication that discovery cannot
  // satisfy is likewise unavailable; transport/5xx/malformed success is not.
  if (readStatus === 404 || readStatus === 405 || observation.kind === "unsupported") return
  if (observation.kind === "failed") throw new Error(observation.message)
  const existing = readProjectDirectory(observation.text)
  if (existing !== undefined) {
    if (normalizeProjectDirectory(existing) !== normalizeProjectDirectory(registration.projectDirectory)) throw new Error("the first mate already belongs to a different sidebar project")
  }

  // Metadata GET can return {} for a missing session or a legacy record keyed
  // only by ID. Check the actual session's directory before adding ownership.
  const session = await callDesktopProxy({ ...desktop, method: "GET", path: `/api/session/${encodeURIComponent(sessionId)}?directory=${encodeURIComponent(directory)}`, label: "sidebar session ownership" })
  if (session.kind !== "ok") throw new Error(session.kind === "failed" ? session.message : session.reason)
  const parsed: unknown = JSON.parse(session.text ?? "null")
  const record = isRecord(parsed) && parsed.id === undefined ? parsed.data : parsed
  if (!isRecord(record) || record.id !== sessionId) throw new Error("the host did not identify the first mate for sidebar association")
  const actualDirectory = isRecord(record.location) ? record.location.directory : record.directory
  if (typeof actualDirectory !== "string" || actualDirectory.trim() === "" || normalizeProjectDirectory(actualDirectory) !== normalizeProjectDirectory(directory)
    || (record.directory !== undefined && record.directory !== actualDirectory)) throw new Error("the first mate is not rooted in its registered home")
  if (existing !== undefined) return

  const outcome = await callDesktopProxy({
    ...desktop, method: "POST", path: sessionPath, label: "sidebar project association",
    body: JSON.stringify({ directory, patch: { openchamber: { projectDirectory: registration.projectDirectory } } }),
  })
  if (outcome.kind !== "ok") throw new Error(outcome.kind === "failed" ? outcome.message : outcome.reason)
  if (readProjectDirectory(outcome.text) !== registration.projectDirectory) throw new Error("the host did not confirm the first mate's sidebar project association")
}

function readProjectDirectory(text: string | undefined): string | undefined {
  const parsed: unknown = JSON.parse(text ?? "null")
  if (!isRecord(parsed) || !isRecord(parsed.metadata)) throw new Error("the host did not return sidebar session metadata")
  const openchamber = parsed.metadata.openchamber
  if (openchamber === undefined) return undefined
  if (!isRecord(openchamber)) throw new Error("the host returned malformed sidebar session metadata")
  const directory = openchamber.projectDirectory
  if (directory !== undefined && (typeof directory !== "string" || !isAbsolute(directory))) throw new Error("the host returned a malformed sidebar project directory")
  return directory as string | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Repair existing registrations once when the service starts. One failure leaves the other projects usable. */
export async function restoreSessionProjects(input: SessionProjectDesktop & { filesystem: FileSystemPort; exec: ExecRunner; homeRoot: string }): Promise<string[]> {
  const registrations = await loadRegistry(input.filesystem, input.homeRoot)
  const failures: string[] = []
  for (const registration of Object.values(registrations)) {
    try {
      await associateFirstMateSession(input.exec, registration, input)
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error))
    }
  }
  return failures
}
