import { describe, expect, test } from "bun:test"
import { initialPanelState, reducePanelState, type PanelEvent, type RegistrationInfo } from "../panel/state"
import { formatLastRun, formatSchedule, nextRunLabel, nextRunTitle, parseWatches, watchOutcomeLabel } from "../panel/watches"

const registration: RegistrationInfo = {
  slug: "sunrise",
  projectDirectory: "/repos/sunrise",
  homeDirectory: "/home/firstmate/projects/sunrise",
  coordinatorSessionId: "ses_coord_1",
  createdAt: "2026-01-01T00:00:00.000Z",
}

describe("parseWatches", () => {
  test("parses a well-formed payload, shared and project sources alike", () => {
    const watches = parseWatches([
      {
        name: "pr-watch",
        source: "shared",
        schedule: "*/5 * * * *",
        enabled: true,
        lastRunAt: "2026-10-01T09:05:00.000Z",
        lastOutcome: "ok",
        lastOutput: "QUOTED — pull request #11 …",
      },
      { name: "nightly", source: "project", schedule: "0 9 * * 1-5", enabled: false },
    ])
    expect(watches).toEqual([
      {
        name: "pr-watch",
        source: "shared",
        schedule: "*/5 * * * *",
        enabled: true,
        lastRunAt: "2026-10-01T09:05:00.000Z",
        lastOutcome: "ok",
        lastOutput: "QUOTED — pull request #11 …",
      },
      { name: "nightly", source: "project", schedule: "0 9 * * 1-5", enabled: false },
    ])
  })

  test("nextRun parses as epoch ms, null when disabled, absent when unreported", () => {
    const [scheduled, disabled, unreported] = parseWatches([
      { name: "a", source: "shared", schedule: "*", enabled: true, nextRun: 1_792_000_000_000 },
      { name: "b", source: "project", schedule: "*", enabled: false, nextRun: null },
      { name: "c", source: "shared", schedule: "*", enabled: true },
    ])
    expect(scheduled.nextRun).toBe(1_792_000_000_000)
    expect(disabled.nextRun).toBeNull()
    expect(unreported.nextRun).toBeUndefined()
  })

  test("skips malformed entries instead of throwing", () => {
    expect(
      parseWatches([
        null,
        "nope",
        { name: "", source: "shared", schedule: "*", enabled: true }, // empty name
        { name: "w", source: "everywhere", schedule: "*", enabled: true }, // bad source
        { name: "w", source: "shared", schedule: "", enabled: true }, // empty schedule
        { name: "w", source: "shared", schedule: "*" }, // missing enabled
        { name: "w", source: "shared", schedule: "*", enabled: "yes" }, // non-boolean enabled
        { name: "w", source: "shared", schedule: "*", enabled: true, lastOutcome: "exploded" }, // bad outcome
        { name: "w", source: "shared", schedule: "*", enabled: true, lastRunAt: 7 }, // non-string lastRunAt
        { name: "w", source: "shared", schedule: "*", enabled: true, nextRun: "soon" }, // non-number nextRun
      ]),
    ).toEqual([])
  })

  test("a non-array payload yields no watches", () => {
    expect(parseWatches(undefined)).toEqual([])
    expect(parseWatches({ watches: [] })).toEqual([])
  })
})

describe("watch row display mapping", () => {
  test("last run formats in local time, or says it never ran", () => {
    expect(formatLastRun(undefined)).toBe("never run")
    expect(formatLastRun("not a date")).toBe("never run")
    // No timezone suffix → parsed as local time → deterministic rendering.
    expect(formatLastRun("2026-10-01T09:05:00")).toBe("2026-10-01 09:05")
  })

  test("the outcome label prefers the schedule error and names the unrun state", () => {
    expect(watchOutcomeLabel({ name: "w", source: "shared", schedule: "*", enabled: true, error: "invalid watch schedule" })).toBe("invalid schedule")
    expect(watchOutcomeLabel({ name: "w", source: "shared", schedule: "*", enabled: true })).toBe("no run yet")
    for (const lastOutcome of ["ok", "empty", "failed"] as const) {
      expect(watchOutcomeLabel({ name: "w", source: "shared", schedule: "*", enabled: true, lastOutcome })).toBe(lastOutcome)
    }
  })
})

describe("nextRun display mapping", () => {
  const now = Date.parse("2026-10-01T15:00:00")

  test("relative while near, short absolute once further out, paused without a run", () => {
    expect(nextRunLabel(null, now)).toBe("paused")
    expect(nextRunLabel(undefined, now)).toBe("paused")
    expect(nextRunLabel(Date.parse("2026-10-01T15:04:00"), now)).toBe("next in 4m")
    expect(nextRunLabel(Date.parse("2026-10-01T16:29:00"), now)).toBe("next in 89m")
    expect(nextRunLabel(Date.parse("2026-10-01T16:30:00"), now)).toBe("next at 4:30 PM")
  })

  test("an overdue or imminent run never reads as negative minutes", () => {
    expect(nextRunLabel(Date.parse("2026-10-01T14:59:30"), now)).toBe("next in <1m")
  })

  test("the title is the locale-independent stamp, or absent", () => {
    expect(nextRunTitle(undefined)).toBeUndefined()
    expect(nextRunTitle(null)).toBeUndefined()
    expect(nextRunTitle(Date.parse("2026-10-01T15:04:00"))).toBe("2026-10-01 15:04")
  })
})

describe("formatSchedule", () => {
  test("reads the known cron shapes as plain language", () => {
    expect(formatSchedule("*/5 * * * *")).toBe("Every 5 minutes")
    expect(formatSchedule("*/15 * * * *")).toBe("Every 15 minutes")
    expect(formatSchedule("0 * * * *")).toBe("Every hour")
    expect(formatSchedule("30 * * * *")).toBe("Every hour at :30")
    expect(formatSchedule("0 9 * * *")).toBe("Daily at 9:00 AM")
    expect(formatSchedule("5 13 * * *")).toBe("Daily at 1:05 PM")
    expect(formatSchedule("30 9 * * 1")).toBe("Weekly on Monday at 9:30 AM")
    expect(formatSchedule("0 12 * * 0")).toBe("Weekly on Sunday at 12:00 PM")
  })

  test("normalizes day-of-week 7 to Sunday", () => {
    expect(formatSchedule("0 8 * * 7")).toBe("Weekly on Sunday at 8:00 AM")
  })

  test("leaves expressions outside the known shapes raw", () => {
    expect(formatSchedule("* * * * *")).toBe("* * * * *")
    expect(formatSchedule("0 9 * * 1-5")).toBe("0 9 * * 1-5")
    expect(formatSchedule("0,30 6 * * 1,3,5")).toBe("0,30 6 * * 1,3,5")
    expect(formatSchedule("*/15 * * * 1")).toBe("*/15 * * * 1")
    expect(formatSchedule("0 9 1 * *")).toBe("0 9 1 * *")
    expect(formatSchedule("nonsense")).toBe("nonsense")
  })
})

describe("panel watches state", () => {
  function registeredState() {
    return reducePanelState(
      reducePanelState(initialPanelState(), { type: "directory-context", directory: "/repos/sunrise" }),
      { type: "lookup-succeeded", registration },
    )
  }

  test("loaded watches are stored and clear a previous error", () => {
    const state = reducePanelState(
      reducePanelState(registeredState(), { type: "watches-failed", message: "the service is unreachable." }),
      { type: "watches-loaded", watches: [{ name: "pr-watch", source: "shared", schedule: "*/5 * * * *", enabled: true }] },
    )
    expect(state).toEqual({
      kind: "registered",
      registration,
      board: { kind: "loading" },
      watches: [{ name: "pr-watch", source: "shared", schedule: "*/5 * * * *", enabled: true }],
    })
  })

  test("a failed watches fetch keeps the last read rows and records the error", () => {
    const state = reducePanelState(
      reducePanelState(registeredState(), {
        type: "watches-loaded",
        watches: [{ name: "pr-watch", source: "shared", schedule: "*/5 * * * *", enabled: true }],
      }),
      { type: "watches-failed", message: "Reading the watches failed (status 500)." },
    )
    expect(state).toEqual({
      kind: "registered",
      registration,
      board: { kind: "loading" },
      watches: [{ name: "pr-watch", source: "shared", schedule: "*/5 * * * *", enabled: true }],
      watchesError: "Reading the watches failed (status 500).",
    })
  })

  test("watch events are ignored while the project is not registered", () => {
    const state = reducePanelState(
      reducePanelState(initialPanelState(), { type: "directory-context", directory: "/repos/sunrise" }),
      { type: "lookup-succeeded", registration: null },
    )
    const after = reducePanelState(state, {
      type: "watches-loaded",
      watches: [{ name: "pr-watch", source: "shared", schedule: "*", enabled: true }],
    } as PanelEvent)
    expect(after).toEqual({ kind: "unregistered" })
  })
})
