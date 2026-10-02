export type ShippingMode = "direct-PR" | "reviewed-PR" | "local-only"

export interface ShippingModeInfo {
  mode: ShippingMode | null
  yolo: boolean
}

const shippingModes: readonly ShippingMode[] = ["direct-PR", "reviewed-PR", "local-only"]

function isShippingMode(value: string): value is ShippingMode {
  return (shippingModes as readonly string[]).includes(value)
}

// Parses the `mode:` field line from projects.md content — the format
// templates/projects.md documents. Unset (the template's
// `mode: unset — ask the captain` default), unknown, and malformed values all
// yield the unset result ({ mode: null, yolo: false }): the coordinator must
// ask the captain. The first top-level `mode:` line wins; bullet and prose
// mentions of the field, as in the template's own list, do not count.
export function parseShippingMode(markdown: string): ShippingModeInfo {
  for (const line of markdown.split("\n")) {
    const field = /^mode:\s*(.*)$/.exec(line.trim())
    if (field === null) continue
    return parseModeValue(field[1].trim())
  }
  return { mode: null, yolo: false }
}

function parseModeValue(value: string): ShippingModeInfo {
  const yolo = value.endsWith("+yolo")
  const base = (yolo ? value.slice(0, -"+yolo".length) : value).trim()
  if (!isShippingMode(base)) return { mode: null, yolo: false }
  return { mode: base, yolo }
}
