import { createSession, sessionList, sessionStatus, type ExecRunner } from "./control-client"
import type { FileSystemPort } from "./file-system"
import {
  assertProjectAssociation,
  resolveProjectHomeDirectory,
  readOpening,
  readProjectHomeSettings,
  recomposeExistingHome,
  recordCoordinatorSessionId,
  rememberedCoordinatorSessionId,
  withProjectLifecycle,
} from "./launch"
import { loadRegistry, saveRegistry, type Registration } from "./registry"
import { loadProjectSettings } from "./settings"
import { normalizeProjectDirectory } from "./slug"

export interface FirstMateLifecycleInput {
  filesystem: FileSystemPort
  exec: ExecRunner
  homeRoot: string
  slug: string
}

export interface AdoptFirstMateInput extends FirstMateLifecycleInput {
  sessionId: string
}

interface ProjectLifecycleContext {
  registrations: Record<string, Registration>
  registration: Registration
  previousSessionId?: string
}

export async function adoptFirstMate(input: AdoptFirstMateInput): Promise<{ registration: Registration; adopted: true; previousSessionId?: string }> {
  return withProjectLifecycle(input.homeRoot, async () => {
    if (typeof input.sessionId !== "string" || input.sessionId.trim() === "") throw new Error("a coordinator session id is required")
    const context = await resolveProject(input)
    await requireIdleCoordinator(input, context)
    // Status --dir echoes the requested context, not the session's ownership.
    // Only membership in the directory-filtered list establishes candidacy.
    const candidates = await sessionList(input.exec, { directory: context.registration.homeDirectory, all: true })
    const candidate = candidates.find((session) => session.sessionId === input.sessionId)
    if (candidate === undefined || candidate.archived === true || (candidate.directory !== undefined && normalizeProjectDirectory(candidate.directory) !== context.registration.homeDirectory)) {
      throw new Error("the candidate must be an unarchived session listed in this project's home")
    }
    if (candidate.status.activity !== "idle") throw new Error("the candidate coordinator must be idle before adoption")
    const status = await sessionStatus(input.exec, { sessionId: input.sessionId, directory: context.registration.homeDirectory })
    if (status.activity !== "idle") throw new Error("the candidate coordinator must be idle before adoption")
    const registration = { ...context.registration, coordinatorSessionId: input.sessionId }
    await recomposeExistingHome(input.filesystem, input.homeRoot, registration)
    await persistCoordinator(input, context, registration)
    return { registration, adopted: true, previousSessionId: context.previousSessionId }
  })
}

export async function releaseFirstMate(input: FirstMateLifecycleInput): Promise<{ released: true; slug: string; projectDirectory: string; homeDirectory: string; previousSessionId?: string }> {
  return withProjectLifecycle(input.homeRoot, async () => {
    const context = await resolveProject(input)
    await requireIdleCoordinator(input, context)
    // Persist forget intent first. A failed registry write must never resurrect
    // the released ID through launch's registry-loss recovery.
    await recordCoordinatorSessionId(input.filesystem, context.registration.homeDirectory, undefined)
    const registrations = { ...context.registrations }
    delete registrations[input.slug]
    await saveRegistry(input.filesystem, input.homeRoot, registrations)
    return {
      released: true,
      slug: input.slug,
      projectDirectory: context.registration.projectDirectory,
      homeDirectory: context.registration.homeDirectory,
      previousSessionId: context.previousSessionId,
    }
  })
}

// Restart is explicitly a fresh coordinator session in the SAME home. The old
// session, backlog, workers and worktrees are not archived, deleted or reset.
export async function restartFirstMate(input: FirstMateLifecycleInput): Promise<{ registration: Registration; previousSessionId?: string }> {
  return withProjectLifecycle(input.homeRoot, async () => {
    const context = await resolveProject(input)
    await requireIdleCoordinator(input, context)
    const settings = await loadProjectSettings(input.filesystem, context.registration.homeDirectory)
    const opening = await readOpening(input.filesystem, context.registration.homeDirectory)
    const prompt = [opening, "Restart in fresh session. Read AGENTS.md and captain.md, then read backlog.md and reconcile existing workers and reports with the backlog. Preserve existing work and the previous coordinator session. Do not merge, and do not start new tasks automatically. Report the reconciled state and wait for the captain."].filter((part) => part !== undefined).join("\n\n")
    await recomposeExistingHome(input.filesystem, input.homeRoot, context.registration)
    const coordinatorSessionId = await createSession(input.exec, {
      directory: context.registration.homeDirectory,
      title: `FirstMate — ${input.slug}`,
      prompt,
      ...(settings.coordinatorModel !== "" ? { model: settings.coordinatorModel } : {}),
      ...(settings.coordinatorVariant !== "" ? { variant: settings.coordinatorVariant } : {}),
    })
    const registration = { ...context.registration, coordinatorSessionId }
    await persistCoordinator(input, context, registration)
    return { registration, previousSessionId: context.previousSessionId }
  })
}

async function resolveProject(input: FirstMateLifecycleInput): Promise<ProjectLifecycleContext> {
  const homeDirectory = resolveProjectHomeDirectory(input.homeRoot, input.slug)
  const registrations = await loadRegistry(input.filesystem, input.homeRoot)
  const existing = Object.hasOwn(registrations, input.slug) ? registrations[input.slug] : undefined
  if (existing !== undefined && (existing.slug !== input.slug || normalizeProjectDirectory(existing.homeDirectory) !== homeDirectory)) {
    throw new Error("FirstMate registration does not match this project's home")
  }
  if (!(await input.filesystem.exists(homeDirectory))) throw new Error("an existing FirstMate project home is required")
  const settings = await readProjectHomeSettings(input.filesystem, homeDirectory)
  const projectDirectory = existing?.projectDirectory ?? settings.projectDirectory
  if (typeof projectDirectory !== "string" || projectDirectory.trim() === "") throw new Error("FirstMate home settings have no projectDirectory")
  assertProjectAssociation(settings, projectDirectory)
  const normalizedDirectory = normalizeProjectDirectory(projectDirectory)
  if (normalizedDirectory === normalizeProjectDirectory(input.homeRoot) || normalizedDirectory.startsWith(`${normalizeProjectDirectory(input.homeRoot)}/projects/`)) {
    throw new Error("FirstMate project home must be associated with a repository, not another home")
  }
  if (Object.values(registrations).some((registration) => registration.slug !== input.slug && normalizeProjectDirectory(registration.projectDirectory) === normalizedDirectory)) {
    throw new Error("the project is registered under a different FirstMate home")
  }
  const previousSessionId = settings.coordinatorReleased === true ? undefined : rememberedCoordinatorSessionId(settings) ?? existing?.coordinatorSessionId
  const registration: Registration = {
    slug: input.slug,
    projectDirectory: normalizedDirectory,
    homeDirectory,
    coordinatorSessionId: previousSessionId ?? "",
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  }
  return { registrations, registration, previousSessionId }
}

async function requireIdleCoordinator(input: FirstMateLifecycleInput, context: ProjectLifecycleContext): Promise<void> {
  if (context.previousSessionId === undefined) return
  const status = await sessionStatus(input.exec, { sessionId: context.previousSessionId, directory: context.registration.homeDirectory })
  if (status.activity !== "idle") throw new Error("the existing coordinator must be idle before changing its lifecycle")
}

async function persistCoordinator(input: FirstMateLifecycleInput, context: ProjectLifecycleContext, registration: Registration): Promise<void> {
  await recordCoordinatorSessionId(input.filesystem, registration.homeDirectory, registration.coordinatorSessionId)
  await saveRegistry(input.filesystem, input.homeRoot, { ...context.registrations, [input.slug]: registration })
}
