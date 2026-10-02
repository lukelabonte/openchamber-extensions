import { describe, expect, test } from "bun:test"
import { computeNextRun, extractScheduleComment, parseCronExpression, ScheduleParseError, type CronSchedule } from "../service/watch-schedule"

// All dates are built with local-time constructors so the tests pass in any
// time zone — watches run in the Mac's local time.
function local(year: number, month: number, day: number, hour = 0, minute = 0): Date {
  return new Date(year, month - 1, day, hour, minute, 0, 0)
}

function expectParseError(expression: string): void {
  expect(() => parseCronExpression(expression)).toThrow(ScheduleParseError)
}

describe("parseCronExpression", () => {
  test("accepts the documented forms", () => {
    const everyMinute = parseCronExpression("* * * * *")
    expect(everyMinute.minutes.size).toBe(60)
    expect(everyMinute.anyDayOfMonth).toBe(true)
    expect(everyMinute.anyDayOfWeek).toBe(true)

    const weekdayMornings = parseCronExpression("0 9 * * 1-5")
    expect([...weekdayMornings.minutes]).toEqual([0])
    expect([...weekdayMornings.hours]).toEqual([9])
    expect([...weekdayMornings.daysOfWeek]).toEqual([1, 2, 3, 4, 5])

    const stepped = parseCronExpression("*/15 * * * *")
    expect([...stepped.minutes]).toEqual([0, 15, 30, 45])

    const list = parseCronExpression("0,30 6 * * 1,3,5")
    expect([...list.minutes]).toEqual([0, 30])

    expect([...list.daysOfWeek]).toEqual([1, 3, 5])

    const dayAndMonth = parseCronExpression("0 0 1 1 *")
    expect([...dayAndMonth.daysOfMonth]).toEqual([1])
    expect([...dayAndMonth.months]).toEqual([1])
  })

  test("normalizes day-of-week 7 to Sunday 0", () => {
    const schedule = parseCronExpression("0 0 * * 0,7")
    expect([...schedule.daysOfWeek]).toEqual([0])
  })

  test("marks restricted day fields for crontab OR semantics", () => {
    const both = parseCronExpression("0 0 1 * 1")
    expect(both.anyDayOfMonth).toBe(false)
    expect(both.anyDayOfWeek).toBe(false)
    const domOnly = parseCronExpression("0 0 1 * *")
    expect(domOnly.anyDayOfMonth).toBe(false)
    expect(domOnly.anyDayOfWeek).toBe(true)
  })

  test("rejects malformed expressions with a named error", () => {
    expectParseError("0 9 * *") // too few fields
    expectParseError("0 9 * * * *") // too many fields
    expectParseError("60 * * * *") // minute out of range
    expectParseError("* 24 * * *") // hour out of range
    expectParseError("* * 0 * *") // day-of-month out of range
    expectParseError("* * * 13 *") // month out of range
    expectParseError("* * * * 8") // day-of-week out of range
    expectParseError("nine * * * *") // not a number
    expectParseError("*/0 * * * *") // invalid step
    expectParseError("*/-2 * * * *") // invalid step
    expectParseError("50-10 * * * *") // reversed range
  })

  test("rejects empty range ends", () => {
    expectParseError("-5 * * * *") // empty from must not parse as 0-5
    expectParseError("1- * * * *") // empty to
    expectParseError("1--5 * * * *") // empty middle
  })

  test("rejects a day-of-month no restricted month can contain", () => {
    expectParseError("0 0 30 2 *") // February never has 30 days
    expectParseError("0 0 30-31 2 *") // nor 30 or 31
    expectParseError("0 0 31 4 *") // nor April 31
    expectParseError("0 0 31 2,4,6,9,11 *") // nor any 30-or-29-day month
  })

  test("keeps possible-but-rare day/month combinations", () => {
    parseCronExpression("0 0 29 2 *") // leap-day watch
    parseCronExpression("0 0 30 2,3 *") // March 30 exists
    parseCronExpression("0 0 31 * *") // some month always has a 31st
  })

  test("an impossible schedule that slips past parsing is never due, not an endless search", () => {
    // Built directly (bypassing the parse-time guard) to pin the sentinel.
    const impossible: CronSchedule = {
      minutes: new Set([0]),
      hours: new Set([0]),
      daysOfMonth: new Set([30]),
      months: new Set([2]),
      daysOfWeek: new Set(),
      anyDayOfMonth: false,
      anyDayOfWeek: true,
    }
    expect(computeNextRun(impossible, local(2026, 10, 1, 8, 0))).toBeNull()
  })
})

describe("computeNextRun", () => {
  test("computes the next matching minute in local time", () => {
    const schedule = parseCronExpression("0 9 * * 1-5")
    expect(computeNextRun(schedule, local(2026, 10, 1, 8, 0))).toEqual(local(2026, 10, 1, 9, 0)) // Thursday
    // 09:00 sharp is the run itself: strictly after it, the next match is the
    // next matching DAY at 09:00, not 09:01.
    expect(computeNextRun(schedule, local(2026, 10, 1, 9, 0))).toEqual(local(2026, 10, 2, 9, 0))
    expect(computeNextRun(schedule, local(2026, 10, 1, 10, 0))).toEqual(local(2026, 10, 2, 9, 0)) // Friday
  })

  test("a minute-field schedule fires on the next minute", () => {
    const minutelyDuringWorkHours = parseCronExpression("* 9 * * 1-5")
    expect(computeNextRun(minutelyDuringWorkHours, local(2026, 10, 1, 9, 0))).toEqual(local(2026, 10, 1, 9, 1))
    expect(computeNextRun(minutelyDuringWorkHours, local(2026, 10, 1, 9, 37))).toEqual(local(2026, 10, 1, 9, 38))
  })

  test("skips the weekend for a weekday schedule", () => {
    const schedule = parseCronExpression("0 9 * * 1-5")
    // Friday 2026-10-02 after the run → Monday 2026-10-05.
    expect(computeNextRun(schedule, local(2026, 10, 2, 9, 1))).toEqual(local(2026, 10, 5, 9, 0))
  })

  test("steps through the day", () => {
    const schedule = parseCronExpression("*/15 * * * *")
    expect(computeNextRun(schedule, local(2026, 10, 1, 9, 7))).toEqual(local(2026, 10, 1, 9, 15))
    expect(computeNextRun(schedule, local(2026, 10, 1, 9, 45))).toEqual(local(2026, 10, 1, 10, 0))
  })

  test("never runs before the given time (strictly after)", () => {
    const schedule = parseCronExpression("0 9 * * *")
    expect(computeNextRun(schedule, local(2026, 10, 1, 9, 0))).toEqual(local(2026, 10, 2, 9, 0))
  })

  test("honors month and day-of-month jumps, including Feb 29", () => {
    const leapDay = parseCronExpression("0 0 29 2 *")
    expect(computeNextRun(leapDay, local(2026, 1, 1, 0, 1))).toEqual(local(2028, 2, 29, 0, 0))
    const newYear = parseCronExpression("0 0 1 1 *")
    expect(computeNextRun(newYear, local(2026, 1, 1, 0, 1))).toEqual(local(2027, 1, 1, 0, 0))
  })

  test("matches either restricted day field (crontab OR semantics)", () => {
    // The 1st of the month, or any Monday.
    const schedule = parseCronExpression("0 0 1 * 1")
    // From Thursday 2026-10-01 08:00 the next match is Monday 2026-10-05
    // 00:00 (the 1st already passed at 00:00; no other 1st or Monday comes
    // sooner).
    expect(computeNextRun(schedule, local(2026, 10, 1, 8, 0))).toEqual(local(2026, 10, 5, 0, 0))
    // From Sunday 2026-11-01 00:01 both day fields match; the next minute wins.
    expect(computeNextRun(schedule, local(2026, 11, 1, 0, 1))).toEqual(local(2026, 11, 2, 0, 0))
  })
})

describe("extractScheduleComment", () => {
  test("finds the schedule line with spacing variants", () => {
    expect(extractScheduleComment("#!/bin/sh\n# schedule: 0 9 * * 1-5\n")).toBe("0 9 * * 1-5")
    expect(extractScheduleComment("#schedule:*/5 * * * *\n")).toBe("*/5 * * * *")
    expect(extractScheduleComment("#  schedule:  0 0 * * *  \n")).toBe("0 0 * * *")
  })

  test("finds the schedule line within the first 20 lines only", () => {
    const nineteenth = Array.from({ length: 18 }, (_, index) => `# line ${index + 1}`).concat("# schedule: 0 9 * * *", "").join("\n")
    expect(extractScheduleComment(nineteenth)).toBe("0 9 * * *")
    const tooLate = Array.from({ length: 20 }, (_, index) => `# line ${index + 1}`).concat("# schedule: 0 9 * * *").join("\n")
    expect(extractScheduleComment(tooLate)).toBeUndefined()
  })

  test("a script without a schedule comment is not a watch", () => {
    expect(extractScheduleComment("#!/bin/sh\necho hello\n")).toBeUndefined()
    expect(extractScheduleComment("")).toBeUndefined()
  })
})
