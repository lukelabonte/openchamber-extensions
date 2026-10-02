import path from "node:path"

const HASH_HEX_LENGTH = 8

export function normalizeProjectDirectory(projectDirectory: string): string {
  return path.resolve(projectDirectory.trim())
}

export function deriveSlug(projectDirectory: string, existingProjectDirectories: readonly string[] = []): string {
  const trimmedDirectory = projectDirectory.trim()
  const baseSlug = slugifyBase(path.basename(trimmedDirectory))
  const candidateSlug = baseSlug === "" ? `project-${pathHash(trimmedDirectory)}` : baseSlug
  const isTaken = existingProjectDirectories.some(
    (existingDirectory) =>
      normalizeDirectory(existingDirectory) !== normalizeDirectory(trimmedDirectory) &&
      slugifyBase(path.basename(existingDirectory)) === baseSlug,
  )
  return isTaken ? `${candidateSlug}-${pathHash(trimmedDirectory)}` : candidateSlug
}

function slugifyBase(baseName: string): string {
  return baseName
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function normalizeDirectory(directoryPath: string): string {
  return directoryPath.replace(/\/+$/, "")
}

function pathHash(directoryPath: string): string {
  let hash = 0x811c9dc5
  for (let index = 0; index < directoryPath.length; index++) {
    hash ^= directoryPath.charCodeAt(index)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(HASH_HEX_LENGTH, "0")
}
