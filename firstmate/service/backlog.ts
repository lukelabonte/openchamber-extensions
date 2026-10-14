import type { FileSystemPort } from "./file-system"

export type BacklogState = "Queued" | "Working" | "Blocked" | "Parked" | "Done" | "Failed" | "Idle"

export type BacklogTaskKind = "ship" | "scout" | "captain"

export interface BacklogTaskAction {
  label: string
  text: string
}

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
  id?: string
  kind?: BacklogTaskKind
  blockedBy?: string
  hold?: string
  reviewHead?: string
  actions?: BacklogTaskAction[]
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
  id: "id",
  kind: "kind",
  "blocked-by": "blockedBy",
  hold: "hold",
  "review-head": "reviewHead",
  actions: "actions",
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
  fields: Partial<Omit<BacklogTask, "title">>
  idLine?: number
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
  const taskIds = new Set<string>()
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
    if (optionalFields.id !== undefined) {
      if (taskIds.has(optionalFields.id)) {
        errors.push({ line: draft.idLine ?? draft.titleLine, message: `the entry "${draft.title}" repeats the task id "${optionalFields.id}"` })
        return
      }
      taskIds.add(optionalFields.id)
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
  if (fieldName === "actions") {
    const actions = parseTaskActions(value)
    if (actions === undefined) {
      entry.problem = { line: lineNumber, message: `the entry "${entry.title}" has an invalid "actions" field; use up to four unique nonempty labels and prompts separated by "=>" and "|", escaping pipes and backslashes` }
    } else {
      entry.fields.actions = actions
    }
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
  if (fieldName === "kind") {
    if (!isTaskKind(value)) {
      entry.problem = { line: lineNumber, message: `the entry "${entry.title}" has an unknown "kind" value "${value}"` }
    } else {
      entry.fields.kind = value
    }
    return
  }
  if ((fieldName === "id" || fieldName === "blockedBy") && !isTaskId(value)) {
    entry.problem = { line: lineNumber, message: `the entry "${entry.title}" has a "${key}" that is not a path-safe task id (1–64 lowercase letters, digits or hyphens, starting with a letter or digit)` }
    return
  }
  if (fieldName === "reviewHead" && !isReviewHead(value)) {
    entry.problem = { line: lineNumber, message: `the entry "${entry.title}" has a "${key}" that is not a hex SHA (7–64 characters)` }
    return
  }
  entry.fields[fieldName] = value
  if (fieldName === "id") entry.idLine = lineNumber
}

function isBacklogState(value: string): value is BacklogState {
  return (backlogStates as readonly string[]).includes(value)
}

// Shared guards keep markdown records and the panel's wire contract aligned.
export function isTaskId(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value)
}

export function isTaskKind(value: unknown): value is BacklogTaskKind {
  return value === "ship" || value === "scout" || value === "captain"
}

export function isReviewHead(value: unknown): value is string {
  return typeof value === "string" && value.trim() === value && /^[0-9a-f]{7,64}$/i.test(value)
}

export function isTaskActions(value: unknown): value is BacklogTaskAction[] {
  if (!Array.isArray(value) || value.length > 4) return false
  const labels = new Set<string>()
  for (const action of value) {
    if (typeof action !== "object" || action === null || Array.isArray(action)) return false
    if (typeof action.label !== "string" || typeof action.text !== "string") return false
    const label = action.label.trim()
    if (label === "" || action.text.trim() === "" || labels.has(label)) return false
    labels.add(label)
  }
  return true
}

function parseTaskActions(value: string): BacklogTaskAction[] | undefined {
  if (value === "") return []
  const segments: string[] = []
  let segment = ""
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index]
    if (character === "\\") {
      const escaped = value[index + 1]
      if (escaped !== "\\" && escaped !== "|") return undefined
      segment += escaped
      index += 1
    } else if (character === "|") {
      segments.push(segment)
      segment = ""
    } else {
      segment += character
    }
  }
  segments.push(segment)
  if (segments.length > 4) return undefined
  const actions: BacklogTaskAction[] = []
  for (const entry of segments) {
    const separator = entry.indexOf("=>")
    if (separator === -1) return undefined
    actions.push({ label: entry.slice(0, separator).trim(), text: entry.slice(separator + 2).trim() })
  }
  return isTaskActions(actions) ? actions : undefined
}

function escapeActionText(text: string): string {
  return text.replace(/\\/g, "\\\\").replace(/\|/g, "\\|")
}

// Renders one entry in the canonical form the charter tells the first mate to
// write; parseBacklog(formatBacklogEntry(task)) round-trips the task.
export function formatBacklogEntry(task: BacklogTask): string {
  const lines = [`- ${task.title}`, `  state: ${task.state}`]
  if (task.id !== undefined) lines.push(`  id: ${task.id}`)
  if (task.kind !== undefined) lines.push(`  kind: ${task.kind}`)
  if (task.blockedBy !== undefined) lines.push(`  blocked-by: ${task.blockedBy}`)
  if (task.hold !== undefined) lines.push(`  hold: ${task.hold}`)
  if (task.reviewHead !== undefined) lines.push(`  review-head: ${task.reviewHead}`)
  if (task.actions !== undefined) {
    lines.push(`  actions: ${task.actions.map((action) => `${escapeActionText(action.label)} => ${escapeActionText(action.text)}`).join(" | ")}`)
  }
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
