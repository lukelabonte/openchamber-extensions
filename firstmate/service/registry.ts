import type { FileSystemPort } from "./file-system"
import { normalizeProjectDirectory } from "./slug"

export interface Registration {
  slug: string
  projectDirectory: string
  homeDirectory: string
  coordinatorSessionId: string
  createdAt: string
}

export class RegistryCorruptError extends Error {
  constructor(filePath: string, cause: string) {
    super(`FirstMate registry file ${filePath} is unreadable (${cause}). Fix or delete it, then relaunch.`)
    this.name = "RegistryCorruptError"
  }
}

export function registryPath(homeRoot: string): string {
  return `${homeRoot}/registry.json`
}

export async function loadRegistry(filesystem: FileSystemPort, homeRoot: string): Promise<Record<string, Registration>> {
  const filePath = registryPath(homeRoot)
  if (!(await filesystem.exists(filePath))) {
    return {}
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(await filesystem.readFile(filePath))
  } catch (error) {
    throw new RegistryCorruptError(filePath, error instanceof Error ? error.message : "not valid JSON")
  }
  if (!isPlainObject(parsed)) {
    throw new RegistryCorruptError(filePath, "not a JSON object")
  }
  for (const [slug, registration] of Object.entries(parsed)) {
    if (!isRegistration(registration)) {
      throw new RegistryCorruptError(filePath, `the entry for slug ${slug} is not a registration`)
    }
  }
  return parsed as Record<string, Registration>
}

// Atomic on the host filesystem: write a unique temp file in the same directory,
// then rename over the registry. A crash mid-write leaves the old file intact.
export async function saveRegistry(
  filesystem: FileSystemPort,
  homeRoot: string,
  registrations: Record<string, Registration>,
): Promise<void> {
  const filePath = registryPath(homeRoot)
  const tempPath = `${filePath}.${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`
  await filesystem.writeFile(tempPath, `${JSON.stringify(registrations, null, 2)}\n`)
  await filesystem.rename(tempPath, filePath)
}

export function findRegistration(
  registrations: Record<string, Registration>,
  projectDirectory: string,
): Registration | undefined {
  const normalizedDirectory = normalizeProjectDirectory(projectDirectory)
  return Object.values(registrations).find((registration) => registration.projectDirectory === normalizedDirectory)
}

function isRegistration(value: unknown): value is Registration {
  if (!isPlainObject(value)) return false
  return (
    typeof value.slug === "string" &&
    typeof value.projectDirectory === "string" &&
    typeof value.homeDirectory === "string" &&
    typeof value.coordinatorSessionId === "string" &&
    typeof value.createdAt === "string"
  )
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}
