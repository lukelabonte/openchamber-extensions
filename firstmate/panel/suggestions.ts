// Wire types and pure display mapping for the suggestions the service serves
// at GET /suggestions?slug=… . suggestions.md is the coordinator's file; the
// panel only renders its rows as buttons and never edits anything itself.

export interface SuggestionRow {
  label: string
  text: string
}

// Panel-side shape guard for the /suggestions payload: a malformed entry is
// skipped instead of poisoning the card or throwing inside the reducer.
export function parseSuggestions(value: unknown): SuggestionRow[] {
  if (!Array.isArray(value)) return []
  const suggestions: SuggestionRow[] = []
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue
    const record = entry as Record<string, unknown>
    const { label, text } = record
    if (typeof label !== "string" || label === "" || typeof text !== "string" || text === "") continue
    suggestions.push({ label, text })
  }
  return suggestions
}
