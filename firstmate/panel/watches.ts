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
  /** Absolute path of the watch script, when the service reports it. */
  path?: string
  lastRunAt?: string
  lastOutcome?: WatchOutcome
  lastOutput?: string
  /** Epoch ms of the next scheduled run; null when disabled; absent when unreported. */
  nextRun?: number | null
  /** Present when the schedule expression does not parse; such a watch never runs. */
  error?: string
  /** Why the last execution failed, when it did; independent of delivery state. */
  lastError?: string
  /** Why the last run's coordinator notification could not be delivered; independent of execution state. */
  deliveryError?: string
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
  const { name, source, schedule, enabled, path, lastRunAt, lastOutcome, lastOutput, nextRun, error, lastError, deliveryError } = record
  if (typeof name !== "string" || name === "") return undefined
  if (source !== "shared" && source !== "project") return undefined
  if (typeof schedule !== "string" || schedule === "") return undefined
  if (typeof enabled !== "boolean") return undefined
  if (
    !isOptionalString(path) ||
    !isOptionalString(lastRunAt) ||
    !isOptionalString(lastOutput) ||
    !isOptionalNumberOrNull(nextRun) ||
    !isOptionalString(error) ||
    !isOptionalString(lastError) ||
    !isOptionalString(deliveryError)
  ) {
    return undefined
  }
  if (lastOutcome !== undefined && !isWatchOutcome(lastOutcome)) {
    return undefined
  }
  return {
    name,
    source,
    schedule,
    enabled,
    ...(path !== undefined ? { path } : {}),
    ...(lastRunAt !== undefined ? { lastRunAt } : {}),
    ...(isWatchOutcome(lastOutcome) ? { lastOutcome } : {}),
    ...(lastOutput !== undefined ? { lastOutput } : {}),
    ...(nextRun !== undefined ? { nextRun } : {}),
    ...(error !== undefined ? { error } : {}),
    ...(lastError !== undefined ? { lastError } : {}),
    ...(deliveryError !== undefined ? { deliveryError } : {}),
  }
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string"
}

function isWatchOutcome(value: unknown): value is WatchOutcome {
  return value === "ok" || value === "empty" || value === "failed"
}

function isOptionalNumberOrNull(value: unknown): value is number | null | undefined {
  return value === undefined || value === null || typeof value === "number"
}

const pad2 = (value: number): string => String(value).padStart(2, "0")

// Locale-independent local-time stamp; an absent or unparseable time means
// the watch has not run in this service's lifetime.
export function formatLastRun(lastRunAt: string | undefined): string {
  if (lastRunAt === undefined) return "never run"
  const date = new Date(lastRunAt)
  if (Number.isNaN(date.getTime())) return "never run"
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

// The next scheduled run, relative while near ("next in 4m") and a short
// absolute time once it is further out ("next at 3:05 PM"); a disabled watch
// or an unreported run reads "paused". `now` is epoch ms, passed in so the
// mapping stays pure and testable — the panel re-renders every refresh
// cycle, which keeps the label roughly current.
export function nextRunLabel(nextRun: number | null | undefined, now: number): string {
  if (typeof nextRun !== "number") return "paused"
  const date = new Date(nextRun)
  if (Number.isNaN(date.getTime())) return "paused"
  const minutes = Math.ceil((nextRun - now) / 60_000)
  if (minutes < 90) return minutes < 1 ? "next in <1m" : `next in ${minutes}m`
  return `next at ${twelveHourTime(date.getHours(), String(date.getMinutes()))}`
}

// Full absolute timestamp for the hover title; undefined when there is
// nothing to show.
export function nextRunTitle(nextRun: number | null | undefined): string | undefined {
  if (typeof nextRun !== "number") return undefined
  const date = new Date(nextRun)
  if (Number.isNaN(date.getTime())) return undefined
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())} ${pad2(date.getHours())}:${pad2(date.getMinutes())}`
}

export function watchOutcomeLabel(watch: WatchRow): string {
  if (watch.error !== undefined) return "invalid schedule"
  return watch.lastOutcome ?? "no run yet"
}

const weekdayNames = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"]

// Human-readable summary of the five-field cron expression for the watches
// card. Only the shapes the panel can state without guessing are translated;
// anything else stays the raw string so the source is never paraphrased into
// a lie.
export function formatSchedule(cron: string): string {
  const fields = cron.trim().split(/\s+/)
  if (fields.length !== 5) return cron
  const [minute, hour, dayOfMonth, , dayOfWeek] = fields
  if (dayOfMonth !== "*") return cron
  const stepped = /^\*\/(\d+)$/.exec(minute)
  if (stepped !== null && hour === "*" && dayOfWeek === "*") return `Every ${stepped[1]} minutes`
  if (!isCronNumber(minute, 59)) return cron
  if (hour === "*" && dayOfWeek === "*") {
    return minute === "0" ? "Every hour" : `Every hour at :${minute.padStart(2, "0")}`
  }
  if (isCronNumber(hour, 23) && dayOfWeek === "*") {
    return `Daily at ${twelveHourTime(Number(hour), minute)}`
  }
  if (isCronNumber(hour, 23) && isCronNumber(dayOfWeek, 7)) {
    return `Weekly on ${weekdayNames[Number(dayOfWeek) % 7]} at ${twelveHourTime(Number(hour), minute)}`
  }
  return cron
}

function isCronNumber(field: string, max: number): boolean {
  return /^\d+$/.test(field) && Number(field) <= max
}

function twelveHourTime(hour: number, minute: string): string {
  const period = hour < 12 ? "AM" : "PM"
  const normalized = hour % 12 === 0 ? 12 : hour % 12
  return `${normalized}:${minute.padStart(2, "0")} ${period}`
}
