// Wire types and pure display mapping for the shipping badge the service
// serves at GET /shipping?slug=… . projects.md is the record; the panel only
// displays the mode and offers no editing.

export interface ShippingInfo {
  mode: string | null
  yolo: boolean
}

// Panel-side shape guard for the /shipping payload: a malformed answer means
// "no badge" rather than a wrong claim about the mode.
export function parseShipping(value: unknown): ShippingInfo | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  const { mode, yolo } = record
  if (mode !== null && typeof mode !== "string") return undefined
  if (typeof yolo !== "boolean") return undefined
  return { mode, yolo }
}

export function shippingBadgeLabel(shipping: ShippingInfo): string {
  if (shipping.mode === null) return "mode unset"
  return shipping.yolo ? `${shipping.mode}+yolo` : shipping.mode
}
