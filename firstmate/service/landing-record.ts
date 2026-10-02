import type { FileSystemPort } from "./file-system"

export type LandingAuthorization = "captain's word" | "+yolo"

export interface LandingRecord {
  task: string
  commit: string
  ci: string
  mode: string
  authorization: LandingAuthorization
  landedAt: string
}

export interface LandingParseError {
  line: number
  message: string
}

export interface LandingLog {
  records: LandingRecord[]
  errors: LandingParseError[]
}

export function landingRecordPath(homeRoot: string, slug: string): string {
  return `${homeRoot}/projects/${slug}/reports/landings.md`
}

const landingsHeader = `# Landings

One landing per entry: a \`- \` bullet with the task title, then indented \`key: value\` lines — commit, ci, mode, authorization, landed (ISO 8601).

`

// Formats one entry in the canonical form the charter tells the first mate to
// record; parseLandingRecords of an appendLandingRecord log round-trips the
// record.
export function formatLandingRecord(record: LandingRecord): string {
  return [
    `- ${record.task}`,
    `  commit: ${record.commit}`,
    `  ci: ${record.ci}`,
    `  mode: ${record.mode}`,
    `  authorization: ${record.authorization}`,
    `  landed: ${record.landedAt}`,
  ].join("\n")
}

export async function appendLandingRecord(
  filesystem: FileSystemPort,
  homeRoot: string,
  slug: string,
  record: LandingRecord,
): Promise<void> {
  await filesystem.createDirectory(`${homeRoot}/projects/${slug}/reports`)
  const filePath = landingRecordPath(homeRoot, slug)
  const prefix = (await filesystem.exists(filePath)) ? "" : landingsHeader
  await filesystem.appendFile(filePath, `${prefix}${formatLandingRecord(record)}\n`)
}

const fieldKeys = ["commit", "ci", "mode", "authorization", "landed"] as const

type LandingField = (typeof fieldKeys)[number]

const authorizations: readonly LandingAuthorization[] = ["captain's word", "+yolo"]

interface LandingDraft {
  titleLine: number
  title: string
  fields: Partial<Record<LandingField, string>>
  problem?: LandingParseError
}

// Parses the log the writer produces, with the backlog's key: value
// discipline: a `- ` bullet title then indented fields. A malformed entry is
// collected as an error (with its line) and excluded, while every
// well-formed entry is kept.
export function parseLandingRecords(markdown: string): LandingLog {
  const records: LandingRecord[] = []
  const errors: LandingParseError[] = []
  let entry: LandingDraft | undefined

  const closeEntry = (): void => {
    if (entry === undefined) return
    const draft = entry
    entry = undefined
    if (draft.problem !== undefined) {
      errors.push(draft.problem)
      return
    }
    const missing = fieldKeys.find((key) => draft.fields[key] === undefined)
    if (missing !== undefined) {
      errors.push({ line: draft.titleLine, message: `the entry "${draft.title}" has no ${missing} line` })
      return
    }
    // `landed` is the on-disk key spelling; the record carries it as landedAt.
    const fields = draft.fields as Record<LandingField, string>
    records.push({
      task: draft.title,
      commit: fields.commit,
      ci: fields.ci,
      mode: fields.mode,
      authorization: fields.authorization as LandingAuthorization,
      landedAt: fields.landed,
    })
  }

  markdown.split("\n").forEach((line, index) => {
    const lineNumber = index + 1
    const trimmed = line.trim()
    const bullet = /^[-*]\s+(.+)$/.exec(trimmed)
    if (bullet !== null) {
      closeEntry()
      entry = { titleLine: lineNumber, title: bullet[1].trim(), fields: {} }
      return
    }
    if (trimmed === "") return
    if (trimmed.startsWith("#")) {
      closeEntry()
      return
    }
    const field = /^([A-Za-z][A-Za-z-]*):\s*(.*)$/.exec(trimmed)
    if (!line.startsWith(" ") && !line.startsWith("\t")) {
      // Unindented prose between entries.
      closeEntry()
      return
    }
    if (entry === undefined) return
    applyField(entry, field, lineNumber)
  })
  closeEntry()

  return { records, errors }
}

function applyField(entry: LandingDraft, field: RegExpExecArray | null, lineNumber: number): void {
  if (entry.problem !== undefined) return
  if (field === null) {
    entry.problem = {
      line: lineNumber,
      message: `the entry "${entry.title}" has a line that is not a \`key: value\` field`,
    }
    return
  }
  const key = field[1]
  const value = field[2].trim()
  if (!(fieldKeys as readonly string[]).includes(key)) {
    entry.problem = { line: lineNumber, message: `the entry "${entry.title}" has an unknown field "${key}"` }
    return
  }
  const landingKey = key as LandingField
  if (entry.fields[landingKey] !== undefined) {
    entry.problem = { line: lineNumber, message: `the entry "${entry.title}" repeats the "${key}" field` }
    return
  }
  if (value === "") {
    entry.problem = { line: lineNumber, message: `the entry "${entry.title}" has an empty "${key}" field` }
    return
  }
  if (landingKey === "authorization" && !(authorizations as readonly string[]).includes(value)) {
    entry.problem = {
      line: lineNumber,
      message: `the entry "${entry.title}" has an unknown authorization "${value}"`,
    }
    return
  }
  if (landingKey === "landed" && Number.isNaN(Date.parse(value))) {
    entry.problem = { line: lineNumber, message: `the entry "${entry.title}" has a "landed" that is not a timestamp` }
    return
  }
  entry.fields[landingKey] = value
}

export async function loadLandingRecords(filesystem: FileSystemPort, homeRoot: string, slug: string): Promise<LandingLog> {
  const filePath = landingRecordPath(homeRoot, slug)
  if (!(await filesystem.exists(filePath))) return { records: [], errors: [] }
  return parseLandingRecords(await filesystem.readFile(filePath))
}
