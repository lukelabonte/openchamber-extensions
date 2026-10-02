import type { FileSystemPort } from "./file-system"

export type BacklogState = "Queued" | "Working" | "Blocked" | "Parked" | "Done" | "Failed" | "Idle"

const backlogStates: readonly BacklogState[] = [
  "Queued",
  "Working",
  "Blocked",
  "Parked",
  "Done",
  "Failed",
  "Idle",
]

export interface BacklogTask {
  title: string
  state: BacklogState
  sessionId?: string
  worktreeDirectory?: string
  branch?: string
  startRef?: string
  prUrl?: string
  createdAt?: string
  updatedAt?: string
}

export interface BacklogParseError {
  line: number
  message: string
}

export interface Backlog {
  tasks: BacklogTask[]
  errors: BacklogParseError[]
}

type OptionalFieldName = Exclude<keyof BacklogTask, "title" | "state">

// The markdown spellings of each optional field; `state` is handled separately
// because it is the one required field.
const fieldKeys: Record<string, OptionalFieldName> = {
  session: "sessionId",
  worktree: "worktreeDirectory",
  branch: "branch",
  "start-ref": "startRef",
  pr: "prUrl",
  created: "createdAt",
  updated: "updatedAt",
}

const allFieldKeys = new Set(["state", ...Object.keys(fieldKeys)])

const timestampFields: readonly OptionalFieldName[] = ["createdAt", "updatedAt"]

interface EntryDraft {
  titleLine: number
  title: string
  fields: { state?: BacklogState } & Partial<Record<OptionalFieldName, string>>
  problem?: BacklogParseError
}

// Parses the backlog entry format documented in templates/backlog.md. Entries
// are a `- ` bullet with the task title followed by indented `key: value`
// lines. Prose, headings, and fenced code blocks around the entries are
// ignored; a malformed entry is collected as an error (with its line) and
// excluded, while every well-formed entry is kept.
export function parseBacklog(markdown: string): Backlog {
  const tasks: BacklogTask[] = []
  const errors: BacklogParseError[] = []
  let entry: EntryDraft | undefined
  let inCodeFence = false

  const closeEntry = (): void => {
    if (entry === undefined) return
    const draft = entry
    entry = undefined
    if (draft.problem !== undefined) {
      errors.push(draft.problem)
      return
    }
    const { state, ...optionalFields } = draft.fields
    if (state === undefined) {
      errors.push({ line: draft.titleLine, message: `the entry "${draft.title}" has no state line` })
      return
    }
    tasks.push({ title: draft.title, ...optionalFields, state })
  }

  markdown.split("\n").forEach((line, index) => {
    const lineNumber = index + 1
    const trimmed = line.trim()
    if (trimmed.startsWith("```")) {
      inCodeFence = !inCodeFence
      return
    }
    if (inCodeFence || trimmed === "") return

    const bullet = /^[-*]\s+(.+)$/.exec(trimmed)
    if (bullet !== null) {
      closeEntry()
      entry = { titleLine: lineNumber, title: bullet[1].trim(), fields: {} }
      return
    }
    if (trimmed.startsWith("#")) {
      closeEntry()
      return
    }

    const field = /^([A-Za-z][A-Za-z-]*):\s*(.*)$/.exec(trimmed)
    const indented = line.startsWith(" ") || line.startsWith("\t")
    if (!indented) {
      // Unindented prose between entries.
      closeEntry()
      return
    }
    if (entry === undefined) {
      if (field !== null && allFieldKeys.has(field[1])) {
        errors.push({ line: lineNumber, message: `the field "${field[1]}" has no entry above it` })
      }
      return
    }
    applyField(entry, field, lineNumber)
  })
  closeEntry()

  return { tasks, errors }
}

function applyField(entry: EntryDraft, field: RegExpExecArray | null, lineNumber: number): void {
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
  if (key === "state") {
    if (!isBacklogState(value)) {
      entry.problem = { line: lineNumber, message: `the entry "${entry.title}" has an unknown state "${value}"` }
    } else if (entry.fields.state !== undefined) {
      entry.problem = { line: lineNumber, message: `the entry "${entry.title}" repeats the "state" field` }
    } else {
      entry.fields.state = value
    }
    return
  }
  const fieldName = fieldKeys[key]
  if (fieldName === undefined) {
    entry.problem = { line: lineNumber, message: `the entry "${entry.title}" has an unknown field "${key}"` }
    return
  }
  if (entry.fields[fieldName] !== undefined) {
    entry.problem = { line: lineNumber, message: `the entry "${entry.title}" repeats the "${key}" field` }
    return
  }
  if (value === "") {
    entry.problem = { line: lineNumber, message: `the entry "${entry.title}" has an empty "${key}" field` }
    return
  }
  if (timestampFields.includes(fieldName) && Number.isNaN(Date.parse(value))) {
    entry.problem = { line: lineNumber, message: `the entry "${entry.title}" has a "${key}" that is not a timestamp` }
    return
  }
  entry.fields[fieldName] = value
}

function isBacklogState(value: string): value is BacklogState {
  return (backlogStates as readonly string[]).includes(value)
}

// Renders one entry in the canonical form the charter tells the first mate to
// write; parseBacklog(formatBacklogEntry(task)) round-trips the task.
export function formatBacklogEntry(task: BacklogTask): string {
  const lines = [`- ${task.title}`, `  state: ${task.state}`]
  if (task.sessionId !== undefined) lines.push(`  session: ${task.sessionId}`)
  if (task.worktreeDirectory !== undefined) lines.push(`  worktree: ${task.worktreeDirectory}`)
  if (task.branch !== undefined) lines.push(`  branch: ${task.branch}`)
  if (task.startRef !== undefined) lines.push(`  start-ref: ${task.startRef}`)
  if (task.prUrl !== undefined) lines.push(`  pr: ${task.prUrl}`)
  if (task.createdAt !== undefined) lines.push(`  created: ${task.createdAt}`)
  if (task.updatedAt !== undefined) lines.push(`  updated: ${task.updatedAt}`)
  return lines.join("\n")
}

export async function loadBacklog(filesystem: FileSystemPort, backlogPath: string): Promise<Backlog> {
  return parseBacklog(await filesystem.readFile(backlogPath))
}
