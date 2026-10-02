// Wire types and pure display mapping for the shipping badge and the recent
// landings list the service serves at GET /shipping?slug=… . projects.md is
// the record; the panel only displays the mode and offers no editing.

export interface LandingRow {
  task: string
  commit: string
  ci: string
  mode: string
  authorization: string
  landedAt: string
  pr?: string
}

export interface ShippingInfo {
  mode: string | null
  yolo: boolean
  landings: LandingRow[]
  landingErrors: string[]
}

// Panel-side shape guard for the /shipping payload: a malformed answer means
// "no badge" rather than a wrong claim about the mode. The landing lists
// default to empty for payloads from services predating them, and malformed
// rows and non-string errors are dropped rather than displayed as lies.
export function parseShipping(value: unknown): ShippingInfo | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  const { mode, yolo } = record
  if (mode !== null && typeof mode !== "string") return undefined
  if (typeof yolo !== "boolean") return undefined
  return {
    mode,
    yolo,
    landings: parseLandingRows(record.landings),
    landingErrors: parseStringList(record.landingErrors),
  }
}

function parseLandingRows(value: unknown): LandingRow[] {
  if (!Array.isArray(value)) return []
  const rows: LandingRow[] = []
  for (const candidate of value) {
    const row = toLandingRow(candidate)
    if (row !== undefined) rows.push(row)
  }
  return rows
}

// Only a row with all six canonical fields as strings is shown; the optional
// pr rides along only when it is a string.
function toLandingRow(value: unknown): LandingRow | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  const { task, commit, ci, mode, authorization, landedAt } = record
  if (
    typeof task !== "string" ||
    typeof commit !== "string" ||
    typeof ci !== "string" ||
    typeof mode !== "string" ||
    typeof authorization !== "string" ||
    typeof landedAt !== "string"
  ) {
    return undefined
  }
  const row: LandingRow = { task, commit, ci, mode, authorization, landedAt }
  if (typeof record.pr === "string") row.pr = record.pr
  return row
}

function parseStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === "string")
}

export function shippingBadgeLabel(shipping: ShippingInfo): string {
  if (shipping.mode === null) return "mode unset"
  return shipping.yolo ? `${shipping.mode}+yolo` : shipping.mode
}
