import { createHash, randomUUID } from "node:crypto"
import type { FileSystemPort } from "./file-system"

export interface TemplateUpgradeState {
  edited: boolean
  outdated: boolean
  comparisonPath?: string
}

interface TemplateInput {
  filesystem: FileSystemPort
  filePath: string
  contents: string
}

interface Provenance {
  version: 1
  /** SHA256 of the full UTF-8 upstream bytes, never of the captain's edits. */
  baselineHash: string
  acknowledgedHash?: string
}

interface Snapshot {
  fileContents: string | undefined
  provenanceContents: string | undefined
  provenance: Provenance | undefined
}

const fingerprintPath = (filePath: string): string => `${filePath}.template.json`
const fingerprint = (contents: string): string => createHash("sha256").update(contents, "utf8").digest("hex")

/** Read/parse failures throw, rather than granting permission to replace a file. */
async function readOptional(filesystem: FileSystemPort, filePath: string): Promise<string | undefined> {
  if (!(await filesystem.exists(filePath))) return undefined
  return filesystem.readFile(filePath)
}

async function snapshot(input: TemplateInput): Promise<Snapshot> {
  const fileContents = await readOptional(input.filesystem, input.filePath)
  const provenanceContents = await readOptional(input.filesystem, fingerprintPath(input.filePath))
  let provenance: Provenance | undefined
  if (provenanceContents !== undefined) {
    let parsed: unknown
    try { parsed = JSON.parse(provenanceContents) }
    catch { throw new Error(`Invalid template provenance: ${fingerprintPath(input.filePath)}`) }
    if (typeof parsed !== "object" || parsed === null || !("version" in parsed) || parsed.version !== 1 || !("baselineHash" in parsed) || !validHash(parsed.baselineHash) || ("acknowledgedHash" in parsed && !validHash(parsed.acknowledgedHash))) {
      throw new Error(`Invalid template provenance: ${fingerprintPath(input.filePath)}`)
    }
    provenance = parsed as Provenance
  }
  return { fileContents, provenanceContents, provenance }
}

function validHash(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value)
}

async function unchanged(input: TemplateInput, before: Snapshot): Promise<boolean> {
  const fileContents = await readOptional(input.filesystem, input.filePath)
  const provenanceContents = await readOptional(input.filesystem, fingerprintPath(input.filePath))
  return fileContents === before.fileContents && provenanceContents === before.provenanceContents
}

async function stage(filesystem: FileSystemPort, filePath: string, contents: string): Promise<string> {
  const temporaryPath = `${filePath}.tmp-${randomUUID()}`
  await filesystem.writeFile(temporaryPath, contents)
  return temporaryPath
}

async function saveProvenance(input: TemplateInput, before: Snapshot, provenance: Provenance): Promise<void> {
  const contents = `${JSON.stringify(provenance, null, 2)}\n`
  if (before.provenanceContents === contents) return
  const filePath = fingerprintPath(input.filePath)
  const temporaryPath = await stage(input.filesystem, filePath, contents)
  if (!(await unchanged(input, before))) throw new Error(`Template changed during update: ${input.filePath}`)
  await input.filesystem.rename(temporaryPath, filePath)
}

async function offerComparison(input: TemplateInput, before: Snapshot): Promise<void> {
  const filePath = `${input.filePath}.new`
  const comparisonContents = await readOptional(input.filesystem, filePath)
  if (comparisonContents !== input.contents) {
    const temporaryPath = await stage(input.filesystem, filePath, input.contents)
    if (!(await unchanged(input, before)) || await readOptional(input.filesystem, filePath) !== comparisonContents) {
      throw new Error(`Template changed during update: ${input.filePath}`)
    }
    await input.filesystem.rename(temporaryPath, filePath)
  }
  if (before.provenance === undefined) {
    await saveProvenance(input, before, { version: 1, baselineHash: fingerprint(input.contents) })
  }
}

/**
 * Installs or upgrades only a current/previous default. Unknown copies are
 * captain-owned. Staging plus a second read narrows (but cannot eliminate)
 * the editor race: FileSystemPort has no compare-and-swap or unlink operation.
 */
export async function syncTemplateCopy(input: TemplateInput & { legacyHashes?: readonly string[] }): Promise<TemplateUpgradeState> {
  const before = await snapshot(input)
  const currentHash = fingerprint(input.contents)
  const installedHash = before.fileContents === undefined ? undefined : fingerprint(before.fileContents)
  if (installedHash === currentHash) {
    await saveProvenance(input, before, { version: 1, baselineHash: currentHash, acknowledgedHash: currentHash })
  } else if (installedHash === undefined || installedHash === before.provenance?.baselineHash || input.legacyHashes?.includes(installedHash)) {
    const temporaryPath = await stage(input.filesystem, input.filePath, input.contents)
    if (await unchanged(input, before)) {
      await input.filesystem.rename(temporaryPath, input.filePath)
      await saveProvenance(input, { ...before, fileContents: input.contents }, { version: 1, baselineHash: currentHash, acknowledgedHash: currentHash })
    } else {
      const changed = await snapshot(input)
      if (changed.fileContents === undefined) throw new Error(`Template changed during update: ${input.filePath}`)
      await offerComparison(input, changed)
    }
  } else {
    await offerComparison(input, before)
  }
  return readTemplateUpgrade(input)
}

/** Read-only. Acknowledgement silences only the matching upstream version. */
export async function readTemplateUpgrade(input: TemplateInput): Promise<TemplateUpgradeState> {
  const saved = await snapshot(input)
  if (saved.fileContents === undefined) return { edited: false, outdated: true }
  const installedHash = fingerprint(saved.fileContents)
  const currentHash = fingerprint(input.contents)
  const edited = installedHash !== currentHash && installedHash !== saved.provenance?.baselineHash
  const outdated = installedHash !== currentHash && saved.provenance?.acknowledgedHash !== currentHash
  const comparisonPath = `${input.filePath}.new`
  const comparison = edited ? await readOptional(input.filesystem, comparisonPath) : undefined
  return { edited, outdated, ...(comparison === input.contents ? { comparisonPath } : {}) }
}

/** Records the upstream baseline the captain reviewed, preserving their words. */
export async function acknowledgeTemplateUpgrade(input: TemplateInput): Promise<void> {
  const before = await snapshot(input)
  if (before.fileContents === undefined) throw new Error(`Cannot acknowledge a missing template: ${input.filePath}`)
  const currentHash = fingerprint(input.contents)
  await saveProvenance(input, before, { version: 1, baselineHash: currentHash, acknowledgedHash: currentHash })
}
