import type { FileSystemPort } from "./file-system"

export interface Suggestion {
  label: string
  text: string
}

export function suggestionsPath(homeRoot: string, slug: string): string {
  return `${homeRoot}/projects/${slug}/suggestions.md`
}

// The coordinator keeps suggestions.md up to date: one suggestion per line,
// `- <label> :: <what to send>`. Prose, headings, and blank lines around the
// entries are ignored; a bullet without the `::` separator is not a
// suggestion line and is left alone.
const suggestionLine = /^-\s+(.+?)\s*::\s*(.+)$/

export function normalizeSuggestionText(text: string): string {
  return text.trim().replace(/\s+/g, " ")
}

export function parseSuggestions(markdown: string, dismissed: ReadonlySet<string> = new Set()): Suggestion[] {
  const suggestions: Suggestion[] = []
  for (const line of markdown.split("\n")) {
    const suggestion = parseSuggestionLine(line)
    if (suggestion !== undefined && !dismissed.has(normalizeSuggestionText(suggestion.text))) suggestions.push(suggestion)
  }
  return suggestions
}

function parseSuggestionLine(line: string): Suggestion | undefined {
  const match = suggestionLine.exec(line.trim())
  return match === null ? undefined : { label: match[1], text: match[2] }
}

export async function loadSuggestions(filesystem: FileSystemPort, filePath: string): Promise<Suggestion[]> {
  if (!(await filesystem.exists(filePath))) return []
  const dismissedPath = suggestionDismissalsPath(filePath)
  const dismissed = await filesystem.exists(dismissedPath)
    ? parseDismissedSuggestions(await filesystem.readFile(dismissedPath))
    : new Set<string>()
  return parseSuggestions(await filesystem.readFile(filePath), dismissed)
}

function suggestionDismissalsPath(filePath: string): string {
  return `${filePath.slice(0, filePath.lastIndexOf("/") + 1)}suggestions-dismissed.md`
}

const dismissalHistoryLimit = 50

interface DismissalLine {
  lineIndex: number
  text: string
}

// Each managed Markdown bullet is a JSON record with label, text, and
// dismissedAt. Encoding keeps newlines/separators inside text unambiguous.
// Malformed bullets and human prose are never treated as managed records.
function parseDismissalLines(markdown: string): DismissalLine[] {
  const entries: DismissalLine[] = []
  const lines = markdown.split("\n")
  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const match = /^-\s+(\{.*\})$/.exec(lines[lineIndex].trim())
    if (match === null) continue
    try {
      const value: unknown = JSON.parse(match[1])
      if (typeof value !== "object" || value === null) continue
      const record = value as Record<string, unknown>
      if (
        typeof record.label !== "string" ||
        typeof record.text !== "string" ||
        typeof record.dismissedAt !== "string" ||
        !Number.isFinite(new Date(record.dismissedAt).getTime())
      ) {
        continue
      }
      const text = normalizeSuggestionText(record.text)
      if (text !== "") entries.push({ lineIndex, text })
    } catch {
      // A torn record stays on disk for inspection; other records still load.
    }
  }
  return entries
}

// Callers passing a dismissal set to parseSuggestions use these normalized
// text keys, not labels. Retention follows append order, not supplied dates.
export function parseDismissedSuggestions(markdown: string): Set<string> {
  return new Set(parseDismissalLines(markdown).slice(-dismissalHistoryLimit).map((entry) => entry.text))
}

export async function dismissSuggestion(
  filesystem: FileSystemPort,
  filePath: string,
  suggestion: Suggestion,
  now: Date = new Date(),
): Promise<void> {
  const text = normalizeSuggestionText(suggestion.text)
  if (text === "") throw new Error("cannot dismiss an empty suggestion")
  const record = `- ${JSON.stringify({ label: suggestion.label, text: suggestion.text, dismissedAt: now.toISOString() })}`
  const dismissedPath = suggestionDismissalsPath(filePath)
  // A failed read must propagate: replacing unreadable history with an empty
  // one could resurrect old prompts. Parent actions are serialized per project.
  // Commit history first: even if removal fails, a fresh load hides this text.
  await updateFileChecked(filesystem, dismissedPath, (current) => {
    const markdown = current ?? ""
    const lineEnding = markdown.includes("\r\n") ? "\r\n" : "\n"
    const appended = `${markdown}${markdown === "" || markdown.endsWith("\n") ? "" : lineEnding}${record}${lineEnding}`
    const entries = parseDismissalLines(appended)
    const expiredLines = new Set(entries.slice(0, Math.max(0, entries.length - dismissalHistoryLimit)).map((entry) => entry.lineIndex))
    return appended.split("\n").filter((_, lineIndex) => !expiredLines.has(lineIndex)).join("\n")
  })
  await removeMatchingSuggestions(filesystem, filePath, (entry) =>
    entry.label === suggestion.label && normalizeSuggestionText(entry.text) === text,
  )
}

// Label-only removal remains available for callers explicitly requesting it.
// Sends match exact label/text; dismissals record and match normalized text.
// Everything else — the coordinator's prose — stays byte-for-byte.
export async function removeSuggestion(filesystem: FileSystemPort, filePath: string, label: string): Promise<void> {
  await removeMatchingSuggestions(filesystem, filePath, (suggestion) => suggestion.label === label)
}

async function removeMatchingSuggestions(
  filesystem: FileSystemPort,
  filePath: string,
  matches: (suggestion: Suggestion) => boolean,
): Promise<void> {
  await updateFileChecked(filesystem, filePath, (markdown) => {
    if (markdown === undefined) return undefined
    return markdown.split("\n").filter((line) => {
      const suggestion = parseSuggestionLine(line)
      return suggestion === undefined || !matches(suggestion)
    }).join("\n")
  })
}

async function updateFileChecked(
  filesystem: FileSystemPort,
  filePath: string,
  update: (markdown: string | undefined) => string | undefined,
): Promise<void> {
  const readCurrent = async () => await filesystem.exists(filePath) ? await filesystem.readFile(filePath) : undefined
  const tempPath = `${filePath}.${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const markdown = await readCurrent()
    const updated = update(markdown)
    if (updated === undefined || updated === markdown) return
    await filesystem.writeFile(tempPath, updated)
    if (await readCurrent() !== markdown) continue
    // Best-effort edit detection, not CAS: a writer can still race this check
    // and rename. The port has no remove operation; reuse one staging path.
    await filesystem.rename(tempPath, filePath)
    return
  }
  throw new Error(`could not update ${filePath} after 3 conflicting edits`)
}

export interface SuggestionSendOutcome {
  sent: true
  warning?: string
}

// The send-then-remove composition behind POST /suggestion/send, with the
// filesystem and the send injected so tests can fail either side. A rejected
// send propagates unchanged — the line stays on disk, ready to press again —
// while a failed removal after a successful send is downgraded to a warning:
// the coordinator already has the message, so the captain must not be told to
// press it a second time.
export async function sendSuggestion(
  filesystem: FileSystemPort,
  filePath: string,
  suggestion: Suggestion,
  send: (text: string) => Promise<void>,
): Promise<SuggestionSendOutcome> {
  const { label, text } = suggestion
  await send(text)
  try {
    await removeMatchingSuggestions(filesystem, filePath, (entry) => entry.label === label && entry.text === text)
  } catch {
    return { sent: true, warning: `the suggestion was sent to the coordinator, but its line could not be removed from ${filePath}` }
  }
  return { sent: true }
}
