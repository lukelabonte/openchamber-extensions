import { associateSessionProject, MissingCliError, UnsupportedSessionProjectError, type ExecRunner } from "./control-client"
import type { FileSystemPort } from "./file-system"
import { loadRegistry, type Registration } from "./registry"

export async function associateFirstMateSession(exec: ExecRunner, registration: Registration): Promise<void> {
  try {
    await associateSessionProject(exec, {
      sessionId: registration.coordinatorSessionId,
      directory: registration.homeDirectory,
      projectDirectory: registration.projectDirectory,
    })
  } catch (error) {
    // Display ownership is optional. Older CLIs cannot group a home-rooted
    // chat under its managed project, but the first mate remains usable.
    if (error instanceof UnsupportedSessionProjectError) return
    if (error instanceof MissingCliError) throw error
    throw new Error(`first mate ${registration.coordinatorSessionId} is saved, but its sidebar project association failed: ${error instanceof Error ? error.message : String(error)}`)
  }
}

/** Repair existing registrations once when the service starts. One failure leaves the other projects usable. */
export async function restoreSessionProjects(input: { filesystem: FileSystemPort; exec: ExecRunner; homeRoot: string }): Promise<string[]> {
  const registrations = await loadRegistry(input.filesystem, input.homeRoot)
  const failures: string[] = []
  for (const registration of Object.values(registrations)) {
    try {
      await associateFirstMateSession(input.exec, registration)
    } catch (error) {
      failures.push(error instanceof Error ? error.message : String(error))
    }
  }
  return failures
}
