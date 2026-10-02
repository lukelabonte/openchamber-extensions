// Crontab-style schedule parsing for watch scripts. A watch declares its
// schedule as a `# schedule:` comment near the top of the script; times are
// evaluated in the Mac's local time.

export class ScheduleParseError extends Error {
  constructor(expression: string, reason: string) {
    super(`invalid watch schedule "${expression}": ${reason}`)
    this.name = "ScheduleParseError"
  }
}

export interface CronSchedule {
  minutes: ReadonlySet<number>
  hours: ReadonlySet<number>
  daysOfMonth: ReadonlySet<number>
  months: ReadonlySet<number>
  /** 0 is Sunday; a 7 is normalized to 0. */
  daysOfWeek: ReadonlySet<number>
  anyDayOfMonth: boolean
  anyDayOfWeek: boolean
}

// Five fields: minute, hour, day-of-month, month, day-of-week. Supported per
// field: `*`, `*/n`, lists (`a,b`), ranges (`a-b`), and plain numbers, with an
// optional `/n` step on any of them. When both day fields are restricted, a
// day matches either one (standard crontab OR semantics).
export function parseCronExpression(expression: string): CronSchedule {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) {
    throw new ScheduleParseError(expression, "expected 5 fields (minute hour day-of-month month day-of-week)")
  }
  const minutes = parseField(fields[0], 0, 59, expression)
  const hours = parseField(fields[1], 0, 23, expression)
  const daysOfMonth = parseField(fields[2], 1, 31, expression)
  const months = parseField(fields[3], 1, 12, expression)
  const daysOfWeek = parseField(fields[4], 0, 7, expression)
  if (daysOfWeek.has(7)) {
    daysOfWeek.delete(7)
    daysOfWeek.add(0)
  }
  // A day-of-month that no restricted month contains (dom 30 with only Feb,
  // dom 31 with only 30-day months) can never fire: reject it at parse time
  // instead of letting the search run forever. February counts as 29 days
  // (leap years), so dom 29 + Feb stays possible.
  if (fields[2] !== "*") {
    const shortestDayOfMonth = Math.min(...daysOfMonth)
    const longestRestrictedMonth = Math.max(...[...months].map((month) => daysInMonth[month - 1]))
    if (shortestDayOfMonth > longestRestrictedMonth) {
      throw new ScheduleParseError(expression, `no restricted month has a day ${shortestDayOfMonth}`)
    }
  }
  return {
    minutes,
    hours,
    daysOfMonth,
    months,
    daysOfWeek,
    anyDayOfMonth: fields[2] === "*",
    anyDayOfWeek: fields[4] === "*",
  }
}

// Index by month number − 1; February counts leap years (29 days).
const daysInMonth: readonly number[] = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31]

function parseField(field: string, min: number, max: number, expression: string): Set<number> {
  const values = new Set<number>()
  for (const part of field.split(",")) {
    const pieces = part.split("/")
    if (pieces.length > 2) throw new ScheduleParseError(expression, `"${part}" has too many steps`)
    const [base, stepPart] = pieces
    const step = stepPart === undefined ? 1 : Number(stepPart)
    if (!Number.isInteger(step) || step < 1) {
      throw new ScheduleParseError(expression, `"${part}" has an invalid step`)
    }
    let low: number
    let high: number
    if (base === "*") {
      low = min
      high = max
    } else if (base.includes("-")) {
      const [from, to] = base.split("-")
      if (from === "" || to === "") {
        throw new ScheduleParseError(expression, `"${part}" has an empty range end`)
      }
      low = Number(from)
      high = Number(to)
    } else {
      low = Number(base)
      high = stepPart === undefined ? low : max
    }
    if (!Number.isInteger(low) || !Number.isInteger(high)) {
      throw new ScheduleParseError(expression, `"${part}" is not a number, a range, or *`)
    }
    if (low < min || high > max || low > high) {
      throw new ScheduleParseError(expression, `"${part}" is out of range ${min}-${max}`)
    }
    for (let value = low; value <= high; value += step) values.add(value)
  }
  return values
}

// An impossible-but-parseable schedule must never spin the search forever
// (belt and braces on top of parse-time validation): the scan is bounded to
// roughly four years — the longest gap any expressible schedule can have (a
// Feb-29-only watch from just after a leap day) — and answers null, never due.
const searchBoundMs = 4 * 366 * 24 * 60 * 60_000

// The first matching minute strictly after `from`, or null when no minute
// matches within the search bound. Jumping a whole month, day, or hour when a
// field cannot match keeps even a Feb-29-only schedule cheap.
export function computeNextRun(schedule: CronSchedule, from: Date): Date | null {
  const candidate = new Date(from.getTime())
  candidate.setSeconds(0, 0)
  candidate.setMinutes(candidate.getMinutes() + 1)
  const deadlineMs = from.getTime() + searchBoundMs
  while (candidate.getTime() <= deadlineMs) {
    if (!schedule.months.has(candidate.getMonth() + 1)) {
      candidate.setMonth(candidate.getMonth() + 1, 1)
      candidate.setHours(0, 0, 0, 0)
      continue
    }
    if (!dayMatches(schedule, candidate)) {
      candidate.setDate(candidate.getDate() + 1)
      candidate.setHours(0, 0, 0, 0)
      continue
    }
    if (!schedule.hours.has(candidate.getHours())) {
      candidate.setHours(candidate.getHours() + 1, 0, 0, 0)
      continue
    }
    if (!schedule.minutes.has(candidate.getMinutes())) {
      candidate.setMinutes(candidate.getMinutes() + 1)
      continue
    }
    return candidate
  }
  return null
}

function dayMatches(schedule: CronSchedule, date: Date): boolean {
  if (schedule.anyDayOfMonth && schedule.anyDayOfWeek) return true
  const domMatch = schedule.daysOfMonth.has(date.getDate())
  const dowMatch = schedule.daysOfWeek.has(date.getDay())
  if (schedule.anyDayOfMonth) return dowMatch
  if (schedule.anyDayOfWeek) return domMatch
  return domMatch || dowMatch
}

// The schedule comment must appear in the first 20 lines; a script without
// one is not a watch. Returns the raw expression for parseCronExpression.
export function extractScheduleComment(scriptText: string): string | undefined {
  for (const line of scriptText.split("\n", 20)) {
    const match = /^#\s*schedule:\s*(.+?)\s*$/.exec(line)
    if (match !== null) return match[1]
  }
  return undefined
}
