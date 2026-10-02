// Wire types and pure display mapping for the watches card the service
// serves at GET /watches?slug=… . The service is the authority on watch
// state; the panel only reshapes the payload for display and never execs
// anything.

export type WatchSource = "shared" | "project"

export type WatchOutcome = "ok" | "empty" | "failed"

export interface WatchRow {
  name: string
  source: WatchSource
  schedule: string
  enabled: boolean
  lastRunAt?: string
  lastOutcome?: WatchOutcome
  lastOutput?: string
  /** Present when the schedule expression does not parse; such a watch never runs. */
  error?: string
}

// Panel-side shape guard for the /watches payload: a malformed watch entry is
// skipped instead of poisoning the card or throwing inside the reducer.
export function parseWatches(value: unknown): WatchRow[] {
  if (!Array.isArray(value)) return []
  const watches: WatchRow[] = []
  for (const entry of value) {
    const watch = parseWatch(entry)
    if (watch !== undefined) watches.push(watch)
  }
  return watches
}

function parseWatch(value: unknown): WatchRow | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  const { name, source, schedule, enabled, lastRunAt, lastOutcome, lastOutput, error } = record
  if (typeof name !== "string" || name === "") return undefined
  if (source !== "shared" && source !== "project") return undefined
  if (typeof schedule !== "string" || schedule === "") return undefined
  if (typeof enabled !== "boolean") return undefined
  if (!isOptionalString(lastRunAt) || !isOptionalString(lastOutput) || !isOptionalString(error)) return undefined
  if (lastOutcome !== undefined && lastOutcome !== "ok" && lastOutcome !== "empty" && lastOutcome !== "failed") {
    return undefined
  }
  return {
    name,
    source,
    schedule,
    enabled,
    ...(lastRunAt !== undefined ? { lastRunAt } : {}),
    ...(lastOutcome !== undefined ? { lastOutcome } : {}),
    ...(lastOutput !== undefined ? { lastOutput } : {}),
    ...(error !== undefined ? { error } : {}),
  }
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string"
}

// Locale-independent local-time stamp; an absent or unparseable time means
// the watch has not run in this service's lifetime.
export function formatLastRun(lastRunAt: string | undefined): string {
  if (lastRunAt === undefined) return "never run"
  const date = new Date(lastRunAt)
  if (Number.isNaN(date.getTime())) return "never run"
  const pad = (value: number): string => String(value).padStart(2, "0")
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`
}

export function watchOutcomeLabel(watch: WatchRow): string {
  if (watch.error !== undefined) return "invalid schedule"
  return watch.lastOutcome ?? "no run yet"
}
