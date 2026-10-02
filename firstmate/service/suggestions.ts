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

export function parseSuggestions(markdown: string): Suggestion[] {
  const suggestions: Suggestion[] = []
  for (const line of markdown.split("\n")) {
    const match = suggestionLine.exec(line.trim())
    if (match !== null) suggestions.push({ label: match[1], text: match[2] })
  }
  return suggestions
}

export async function loadSuggestions(filesystem: FileSystemPort, filePath: string): Promise<Suggestion[]> {
  if (!(await filesystem.exists(filePath))) return []
  return parseSuggestions(await filesystem.readFile(filePath))
}

// Service-side edit: the captain sent or dismissed the suggestion, so every
// line parsing to that label leaves the file while everything else — the
// coordinator's prose — stays byte-for-byte.
export async function removeSuggestion(filesystem: FileSystemPort, filePath: string, label: string): Promise<void> {
  if (!(await filesystem.exists(filePath))) return
  const markdown = await filesystem.readFile(filePath)
  const kept = markdown.split("\n").filter((line) => {
    const match = suggestionLine.exec(line.trim())
    return match === null || match[1] !== label
  })
  await filesystem.writeFile(filePath, kept.join("\n"))
}
