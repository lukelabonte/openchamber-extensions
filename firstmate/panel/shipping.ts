// Wire types and pure display mapping for the shipping badge and the recent
// landings list the service serves at GET /shipping?slug=… . projects.md is
// the record; the panel only displays the mode and offers no editing.

// The optional cleanup claim the service joins onto a landing from the
// backlog record: the recorded absolute worktree directory and its on-disk
// state as of one stat. FirstMate itself never deletes anything.
export type LandingCleanupState = "pending" | "removed" | "unknown"

export interface LandingCleanup {
  worktree: string
  state: LandingCleanupState
}

export interface LandingRow {
  task: string
  commit: string
  ci: string
  mode: string
  authorization: string
  landedAt: string
  pr?: string
  cleanup?: LandingCleanup
}

export interface ShippingInfo {
  mode: string | null
  yolo: boolean
  landings: LandingRow[]
  landingErrors: string[]
  /** Present when the service could not establish worktree cleanup state at all (e.g. the backlog could not be read). */
  cleanupError?: string
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
    // The guard above leaves mode as string | null; narrow it explicitly so
    // the unknown-typed wire value cannot leak into the ShippingInfo.
    mode: typeof mode === "string" ? mode : null,
    yolo,
    landings: parseLandingRows(record.landings),
    landingErrors: parseStringList(record.landingErrors),
    ...(typeof record.cleanupError === "string" ? { cleanupError: record.cleanupError } : {}),
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
// pr rides along only when it is a string. An invalid cleanup claim drops the
// cleanup field alone — the landing itself stays visible.
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
  const cleanup = toLandingCleanup(record.cleanup)
  if (cleanup !== undefined) row.cleanup = cleanup
  return row
}

function toLandingCleanup(value: unknown): LandingCleanup | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  if (typeof record.worktree !== "string" || record.worktree === "") return undefined
  if (record.state !== "pending" && record.state !== "removed" && record.state !== "unknown") return undefined
  return { worktree: record.worktree, state: record.state }
}

function parseStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === "string")
}

export function shippingBadgeLabel(shipping: ShippingInfo): string {
  if (shipping.mode === null) return "mode unset"
  return shipping.yolo ? `${shipping.mode}+yolo` : shipping.mode
}
