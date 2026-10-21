import { createSession, type ExecRunner, MissingCliError } from "./control-client"
import { composeInstructions } from "./compose"
import type { FileSystemPort } from "./file-system"
import type { HttpFetcher, InterruptSupport } from "./interrupt"
import { setSessionPermissionAuto } from "./permissions"
import { provisionProject } from "./provision"
import { findRegistration, loadRegistry, saveRegistry, type Registration } from "./registry"
import { loadProjectSettings } from "./settings"
import { normalizeProjectDirectory } from "./slug"
import { associateFirstMateSession } from "./session-projects"

export interface LaunchFirstMateInput {
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
const lifecycleInFlight = new Map<string, Promise<unknown>>()

// Lock the whole home root: aliases of a project share the lock, and writes of
// the shared registry for different projects cannot overwrite one another.
export async function withProjectLifecycle<Result>(directory: string, operation: () => Promise<Result>): Promise<Result> {
  const key = normalizeProjectDirectory(directory)
  const previous = lifecycleInFlight.get(key) ?? Promise.resolve()
  const current = previous.catch(() => undefined).then(operation)
  lifecycleInFlight.set(key, current)
  try {
    return await current
  } finally {
    if (lifecycleInFlight.get(key) === current) {
      lifecycleInFlight.delete(key)
    }
  }
}

export async function launchFirstMate(input: LaunchFirstMateInput): Promise<LaunchFirstMateResult> {
  return withProjectLifecycle(input.homeRoot, async () => {
    const result = await launchOnce(input)
    await associateFirstMateSession(input.exec, result.registration)
    return result
  })
}

async function launchOnce(input: LaunchFirstMateInput): Promise<LaunchFirstMateResult> {
  const { filesystem, exec, templateReader, homeRoot } = input
  let normalizedDirectory = normalizeProjectDirectory(input.projectDirectory)

  const registrations = await loadRegistry(filesystem, homeRoot)
  const existing = findRegistration(registrations, normalizedDirectory)
  if (existing !== undefined) {
    const expectedHome = resolveProjectHomeDirectory(homeRoot, existing.slug)
    if (normalizeProjectDirectory(existing.homeDirectory) !== expectedHome) throw new Error("FirstMate registration is outside its project home")
    const settings = await readProjectHomeSettings(filesystem, existing.homeDirectory)
    assertProjectAssociation(settings, existing.projectDirectory)
    if (settings.coordinatorReleased !== true) {
      const rememberedSessionId = rememberedCoordinatorSessionId(settings)
      const registration = rememberedSessionId !== undefined ? { ...existing, coordinatorSessionId: rememberedSessionId } : existing
      await recomposeExistingHome(filesystem, homeRoot, registration)
      if (registration.coordinatorSessionId !== existing.coordinatorSessionId) {
        await saveRegistry(filesystem, homeRoot, { ...registrations, [registration.slug]: registration })
      }
      await autoAcceptCoordinator(input, registration.coordinatorSessionId, registration.homeDirectory)
      return { registration, adopted: true }
    }
    normalizedDirectory = normalizeProjectDirectory(existing.projectDirectory)
  } else {
    // A released home still resolves to its repository even without a registry.
    const projectsRoot = `${normalizeProjectDirectory(homeRoot)}/projects/`
    if (normalizedDirectory.startsWith(projectsRoot)) {
      const slug = normalizedDirectory.slice(projectsRoot.length)
      if (resolveProjectHomeDirectory(homeRoot, slug) !== normalizedDirectory) throw new Error("FirstMate launch requires an associated project home")
      const settings = await readProjectHomeSettings(filesystem, normalizedDirectory)
      if (typeof settings.projectDirectory !== "string" || settings.projectDirectory.trim() === "") throw new Error("FirstMate home settings have no projectDirectory")
      normalizedDirectory = normalizeProjectDirectory(settings.projectDirectory)
      if (normalizedDirectory.startsWith(projectsRoot)) throw new Error("FirstMate home cannot be associated with another home")
    }
  }

  const { slug, projectHomeDirectory } = await provisionProject({
    filesystem,
    templateReader,
    homeRoot,
    projectDirectory: normalizedDirectory,
  })
  await composeInstructions({ filesystem, homeRoot, slug })

  const settings = await readProjectHomeSettings(filesystem, projectHomeDirectory)
  assertProjectAssociation(settings, normalizedDirectory)
  const priorSessionId = rememberedCoordinatorSessionId(settings)
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
    const modelSettings = await loadProjectSettings(filesystem, projectHomeDirectory)
    const opening = await readOpening(filesystem, projectHomeDirectory)
    coordinatorSessionId = await createSession(exec, {
      directory: projectHomeDirectory,
      title: `FirstMate — ${slug}`,
      ...(opening !== undefined ? { prompt: opening } : {}),
      ...(modelSettings.coordinatorModel !== "" ? { model: modelSettings.coordinatorModel } : {}),
      ...(modelSettings.coordinatorVariant !== "" ? { variant: modelSettings.coordinatorVariant } : {}),
    })
  } catch (error) {
    if (error instanceof MissingCliError) throw error
    throw new Error(`could not create the coordinator session: ${error instanceof Error ? error.message : String(error)}`)
  }
  await recordCoordinatorSessionId(filesystem, projectHomeDirectory, coordinatorSessionId)
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

export function resolveProjectHomeDirectory(homeRoot: string, slug: string): string {
  if (typeof slug !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(slug)) throw new Error("invalid FirstMate project slug")
  return `${normalizeProjectDirectory(homeRoot)}/projects/${slug}`
}

export async function readProjectHomeSettings(filesystem: FileSystemPort, homeDirectory: string): Promise<Record<string, unknown>> {
  const settingsPath = `${homeDirectory}/settings.json`
  if (!(await filesystem.exists(settingsPath))) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(await filesystem.readFile(settingsPath))
  } catch (error) {
    throw new Error(`FirstMate settings ${settingsPath} are unreadable: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("FirstMate settings must be a JSON object")
  const settings = parsed as Record<string, unknown>
  if (settings.coordinatorReleased !== undefined && typeof settings.coordinatorReleased !== "boolean") throw new Error("FirstMate settings coordinatorReleased must be a boolean")
  if (settings.coordinatorSessionId !== undefined && (typeof settings.coordinatorSessionId !== "string" || settings.coordinatorSessionId.trim() === "")) throw new Error("FirstMate settings coordinatorSessionId must be a nonempty string")
  return settings
}

export function rememberedCoordinatorSessionId(settings: Record<string, unknown>): string | undefined {
  if (settings.coordinatorReleased === true) return undefined
  return typeof settings.coordinatorSessionId === "string" ? settings.coordinatorSessionId : undefined
}

export function assertProjectAssociation(settings: Record<string, unknown>, projectDirectory: string): void {
  if (settings.projectDirectory !== undefined && (typeof settings.projectDirectory !== "string" || settings.projectDirectory.trim() === "" || normalizeProjectDirectory(settings.projectDirectory) !== normalizeProjectDirectory(projectDirectory))) {
    throw new Error("FirstMate home settings projectDirectory does not match its registration")
  }
}

export async function readOpening(filesystem: FileSystemPort, homeDirectory: string): Promise<string | undefined> {
  const filePath = `${homeDirectory}/opening.md`
  if (!(await filesystem.exists(filePath))) return undefined
  const opening = await filesystem.readFile(filePath)
  return opening.trim() !== "" ? opening : undefined
}

export async function recomposeExistingHome(filesystem: FileSystemPort, homeRoot: string, registration: Registration): Promise<void> {
  if (normalizeProjectDirectory(registration.homeDirectory) !== resolveProjectHomeDirectory(homeRoot, registration.slug)) return
  if (!(await filesystem.exists(registration.homeDirectory))) return
  const layers = [`${homeRoot}/shared/charter.md`, `${homeRoot}/shared/captain.md`, `${registration.homeDirectory}/charter.md`, `${registration.homeDirectory}/captain.md`, `${registration.homeDirectory}/learnings.md`]
  if (!(await Promise.all(layers.map((filePath) => filesystem.exists(filePath)))).some(Boolean)) return
  await composeInstructions({ filesystem, homeRoot, slug: registration.slug })
}

export async function recordCoordinatorSessionId(
  filesystem: FileSystemPort,
  homeDirectory: string,
  coordinatorSessionId: string | undefined,
): Promise<void> {
  const settingsPath = `${homeDirectory}/settings.json`
  const settings = await readProjectHomeSettings(filesystem, homeDirectory)
  if (coordinatorSessionId === undefined) {
    delete settings.coordinatorSessionId
    settings.coordinatorReleased = true
  } else {
    settings.coordinatorSessionId = coordinatorSessionId
    delete settings.coordinatorReleased
  }
  const temporaryPath = `${settingsPath}.${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`
  await filesystem.writeFile(temporaryPath, `${JSON.stringify(settings, null, 2)}\n`)
  await filesystem.rename(temporaryPath, settingsPath)
}
