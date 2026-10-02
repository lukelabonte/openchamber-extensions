import { createSession, type ExecRunner, MissingCliError } from "./control-client"
import { composeInstructions } from "./compose"
import type { FileSystemPort } from "./file-system"
import type { HttpFetcher, InterruptSupport } from "./interrupt"
import { setSessionPermissionAuto } from "./permissions"
import { provisionProject } from "./provision"
import { findRegistration, loadRegistry, saveRegistry, type Registration } from "./registry"
import { normalizeProjectDirectory } from "./slug"

interface LaunchFirstMateInput {
  filesystem: FileSystemPort
  exec: ExecRunner
  templateReader: (templateName: string) => Promise<string>
  homeRoot: string
  projectDirectory: string
  fetcher: HttpFetcher
  support: InterruptSupport
}

interface LaunchFirstMateResult {
  registration: Registration
  adopted: boolean
}

// One first mate per project: overlapping launches for the same directory run
// one after the other, so the loser of the race sees the winner's registration
// and adopts it instead of creating a second coordinator session.
const launchesInFlight = new Map<string, Promise<LaunchFirstMateResult>>()

export async function launchFirstMate(input: LaunchFirstMateInput): Promise<LaunchFirstMateResult> {
  const key = normalizeProjectDirectory(input.projectDirectory)
  const previous = launchesInFlight.get(key) ?? Promise.resolve()
  const launch = previous.catch(() => undefined).then(() => launchOnce(input))
  launchesInFlight.set(key, launch)
  try {
    return await launch
  } finally {
    if (launchesInFlight.get(key) === launch) {
      launchesInFlight.delete(key)
    }
  }
}

async function launchOnce(input: LaunchFirstMateInput): Promise<LaunchFirstMateResult> {
  const { filesystem, exec, templateReader, homeRoot } = input
  const normalizedDirectory = normalizeProjectDirectory(input.projectDirectory)

  const registrations = await loadRegistry(filesystem, homeRoot)
  const existing = findRegistration(registrations, normalizedDirectory)
  if (existing !== undefined) {
    await autoAcceptCoordinator(input, existing.coordinatorSessionId, existing.homeDirectory)
    return { registration: existing, adopted: true }
  }

  const { slug, projectHomeDirectory } = await provisionProject({
    filesystem,
    templateReader,
    homeRoot,
    projectDirectory: normalizedDirectory,
  })
  await composeInstructions({ filesystem, homeRoot, slug })

  const settingsPath = `${projectHomeDirectory}/settings.json`
  const priorSessionId = await readCoordinatorSessionId(filesystem, settingsPath)
  if (priorSessionId !== undefined) {
    // The registry was lost (or not yet written) but the home remembers its
    // coordinator session: adopt it, never create a second session.
    const registration: Registration = {
      slug,
      projectDirectory: normalizedDirectory,
      homeDirectory: projectHomeDirectory,
      coordinatorSessionId: priorSessionId,
      createdAt: new Date().toISOString(),
    }
    await saveRegistry(filesystem, homeRoot, { ...registrations, [slug]: registration })
    await autoAcceptCoordinator(input, priorSessionId, projectHomeDirectory)
    return { registration, adopted: true }
  }

  let coordinatorSessionId: string
  try {
    coordinatorSessionId = await createSession(exec, {
      directory: projectHomeDirectory,
      title: `FirstMate — ${slug}`,
    })
  } catch (error) {
    if (error instanceof MissingCliError) throw error
    throw new Error(`could not create the coordinator session: ${error instanceof Error ? error.message : String(error)}`)
  }
  await recordCoordinatorSessionId(filesystem, settingsPath, coordinatorSessionId)
  await autoAcceptCoordinator(input, coordinatorSessionId, projectHomeDirectory)

  const registration: Registration = {
    slug,
    projectDirectory: normalizedDirectory,
    homeDirectory: projectHomeDirectory,
    coordinatorSessionId,
    createdAt: new Date().toISOString(),
  }
  await saveRegistry(filesystem, homeRoot, { ...registrations, [slug]: registration })
  return { registration, adopted: false }
}

// Best-effort: the coordinator session is set to auto-approve permissions so
// a prompt never blocks it. A host without the surface, or a failed call,
// changes nothing about the launch — setSessionPermissionAuto classifies and
// never throws, and the outcome is deliberately ignored.
async function autoAcceptCoordinator(input: LaunchFirstMateInput, sessionId: string, directory: string): Promise<void> {
  await setSessionPermissionAuto({ fetcher: input.fetcher, support: input.support, sessionId, directory })
}

async function readCoordinatorSessionId(filesystem: FileSystemPort, settingsPath: string): Promise<string | undefined> {
  let parsed: unknown
  try {
    parsed = JSON.parse(await filesystem.readFile(settingsPath))
  } catch {
    return undefined
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return undefined
  const value = (parsed as Record<string, unknown>).coordinatorSessionId
  return typeof value === "string" && value !== "" ? value : undefined
}

async function recordCoordinatorSessionId(
  filesystem: FileSystemPort,
  settingsPath: string,
  coordinatorSessionId: string,
): Promise<void> {
  let settings: Record<string, unknown> = {}
  try {
    const parsed: unknown = JSON.parse(await filesystem.readFile(settingsPath))
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      settings = parsed as Record<string, unknown>
    }
  } catch {
    // A missing or unreadable settings file starts a fresh object; provision
    // normally wrote one already.
  }
  settings.coordinatorSessionId = coordinatorSessionId
  await filesystem.writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`)
}
