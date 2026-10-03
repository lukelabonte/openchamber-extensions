// Regression coverage for panel reliability behaviors: the supervision
// health display, the landing cleanup display, the advisory stall note, and
// the run-now lifecycle. Each test drives the real panel entry point
// (firstmate/panel/main.ts) — not a re-creation of its logic — by re-spawning
// this very file under `bun test` as a subprocess probe with
// FM_RELIABILITY_PROBE set (unique to this suite, so the sibling refresh
// suite's FM_PROBE_SCENARIO child and this one can never trigger each
// other). The child installs the SDK module mock and the shared fake
// DOM/window/clock harness, so none of that leaks into the rest of the
// suite. Every wait is a held promise or a fake-clock tick settled by
// microtask flushes — no real sleeps. The fake DOM is behavioral only:
// nothing here (or in the probe) can vouch for CSS layout, wrapping widths,
// or paint.
//
// Parser and reducer shape rules live in panel-board.test.ts,
// panel-watches.test.ts, and panel-shipping.test.ts; this file covers the
// rendered behavior end to end through main.ts.

import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import type { ReliabilityObservations } from "./helpers/panel-reliability-probe"

const scenarioEnvironmentKey = "FM_RELIABILITY_PROBE"
const probeScenario = process.env[scenarioEnvironmentKey]

if (probeScenario !== undefined) {
  // Probe mode: the suite below spawned this file; run the named scenario and
  // print its observations as a tagged JSON line on stdout.
  test(`probe: ${probeScenario}`, async () => {
    const { runReliabilityScenario } = await import("./helpers/panel-reliability-probe")
    console.log(`__FM_RELIABILITY_PROBE__${JSON.stringify(await runReliabilityScenario(probeScenario))}`)
  })
} else {
  async function runScenario(name: string): Promise<ReliabilityObservations> {
    const child = Bun.spawn({
      cmd: [process.execPath, "test", "tests/panel-reliability.test.ts"],
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, [scenarioEnvironmentKey]: name },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ])
    const marker = stdout.split("\n").find((line) => line.includes("__FM_RELIABILITY_PROBE__"))
    if (marker === undefined) {
      throw new Error(`probe "${name}" produced no observations (exit code ${exitCode}):\n${stderr}`)
    }
    return JSON.parse(marker.split("__FM_RELIABILITY_PROBE__")[1]!) as ReliabilityObservations
  }

  describe("FirstMate panel reliability", () => {
    // Lock: the two observation channels are separate labeled rows, each
    // with its own state word and reason, the last clean poll reads as an
    // age, and no text ever claims the board is "Live".
    test("supervision rows render the two channels separately with reasons and the last clean poll", async () => {
      const observations = await runScenario("supervision-renders-separate-cautious-health")
      expect(observations.blocked).toBe("Degraded — worker transcript unreadable")
      expect(observations.failure).toBe("Unavailable — host bridge closed")
      expect(observations.poll).toBe("just now")
      expect(observations.rootText).toContain("When observation is degraded or unavailable")
      expect(observations.rootText).toContain("failures may be unobserved")
      expect(observations.rootText).not.toContain("Live")
    })

    // Lock: a missing or malformed supervision record reads "Unknown" for
    // both channels and "Not polled yet" for the poll — never "Available".
    test("a missing or malformed supervision record reads Unknown, never Available", async () => {
      const observations = await runScenario("missing-and-malformed-supervision-read-unknown")
      const missing = observations.missing as { blocked: string | null; failure: string | null; poll: string | null; rootText: string }
      expect(missing.blocked).toBe("Unknown")
      expect(missing.failure).toBe("Unknown")
      expect(missing.poll).toBe("Not polled yet")
      expect(missing.rootText).not.toContain("Available")
      const malformed = observations.malformed as { blocked: string | null; failure: string | null; rootText: string }
      expect(malformed.blocked).toBe("Unknown")
      expect(malformed.failure).toBe("Unknown")
      expect(malformed.rootText).not.toContain("Available")
    })

    // Lock: a poll older than a minute is marked "(stale)", a timestamp
    // ahead of the local clock says so explicitly with the absolute time on
    // hover, and neither ever reads as "Live".
    test("a stale poll age is marked stale and a future timestamp says the clock is ahead — never Live", async () => {
      const observations = await runScenario("stale-and-future-poll-ages")
      const stale = observations.stale as { poll: string | null; pollTitle: string; rootText: string }
      expect(stale.poll).toBe("1m ago (stale)")
      expect(stale.pollTitle).not.toBe("")
      expect(stale.rootText).not.toContain("Live")
      const future = observations.future as { poll: string | null; pollTitle: string; rootText: string }
      expect(future.poll).toBe("timestamp ahead of local clock")
      expect(future.pollTitle).not.toBe("")
    })

    // Lock: the stall flag is advisory — the note shows on an unfinished
    // card while the state badge and actions stay untouched; an
    // unparseable baseline and a finished card render no note.
    test("the stall flag is advisory: the note shows, the state badge and actions are untouched", async () => {
      const observations = await runScenario("stall-note-is-advisory-with-actions")
      const stalled = observations.stalled as {
        notes: string[]
        badges: Array<string | null>
        interruptDisabled: boolean | null
        hasOpenSession: boolean
        hasEnd: boolean
      }
      expect(stalled.notes).toEqual([
        "Possibly stalled — no observed message progress for 30 minutes. Open the session or Interrupt; nothing stops automatically.",
      ])
      expect(stalled.badges).toEqual(["Working"])
      expect(stalled.interruptDisabled).toBe(false)
      expect(stalled.hasOpenSession).toBe(true)
      expect(stalled.hasEnd).toBe(true)
      const invalidDate = observations.invalidDate as { notes: string[]; badges: Array<string | null> }
      expect(invalidDate.notes).toEqual([])
      expect(invalidDate.badges).toEqual(["Working"])
      const done = observations.done as { notes: string[]; badges: Array<string | null> }
      expect(done.notes).toEqual([])
      expect(done.badges).toEqual(["Done"])
    })

    // Lock: pending cleanup shows the badge plus the recorded path, removed
    // and unknown say so, the top-level cleanupError renders, an invalid
    // cleanup claim drops only the metadata, and no cleanup block ever
    // offers a mutation control.
    test("cleanup rendering: pending shows the recorded path, removed and unknown say so, no mutation control", async () => {
      const observations = await runScenario("cleanup-rendering")
      const rootText = observations.rootText as string
      expect(rootText).toContain("FirstMate does not delete worktrees or branches; cleanup after a landing is yours.")
      expect(rootText).toContain("Awaiting captain cleanup")
      expect(rootText).toContain("/repos/a/.worktrees/pending")
      expect(rootText).toContain("Worktree removed.")
      expect(rootText).toContain("Cleanup status unknown.")
      expect(rootText).toContain("the backlog record could not be read")
      expect(rootText).not.toContain("/repos/a/.worktrees/quiet")
      expect(rootText).toContain("Broken landing")
      expect(observations.awaitingCleanupBadges).toBe(1)
      expect(observations.cleanupButtons).toBe(0)
    })

    // Lock: Run now posts exactly {slug, name, source} as the JSON body; a
    // switched-off schedule still allows a manual run while an unparseable
    // cron leaves the button disabled with the reason on hover.
    test("Run now sends exactly {slug, name, source} as the JSON body; schedule gating on the buttons", async () => {
      const observations = await runScenario("run-now-contract-and-schedule-gating")
      expect(observations.sentBody).toBe('{"slug":"proj-a","name":"pr-watch","source":"shared"}')
      expect(JSON.parse(observations.sentBody as string)).toEqual({ slug: "proj-a", name: "pr-watch", source: "shared" })
      expect(observations.feedback).toBe("Ran.")
      expect(observations.nightlyDisabled).toBe(false)
      expect(observations.brokenDisabled).toBe(true)
      expect(observations.brokenTitle).toContain("does not parse")
    })

    // Lock: the in-flight marker lives outside the DOM — a background
    // re-render rebuilds the button still disabled, a duplicate click sends
    // no extra POST, and the settle re-enables the button and refetches the
    // watches.
    test("the in-flight run marker survives a background re-render and a duplicate click sends no extra POST", async () => {
      const observations = await runScenario("inflight-run-survives-background-render-and-duplicate-click")
      const afterClick = observations.afterClick as { disabled: boolean | null; runPosts: number }
      expect(afterClick.disabled).toBe(true)
      expect(afterClick.runPosts).toBe(1)
      const afterBackgroundRender = observations.afterBackgroundRender as { disabled: boolean | null; runPosts: number; boardGets: number }
      expect(afterBackgroundRender.disabled).toBe(true)
      expect(afterBackgroundRender.runPosts).toBe(1)
      expect(afterBackgroundRender.boardGets).toBe(2)
      const afterDuplicateClick = observations.afterDuplicateClick as { runPosts: number }
      expect(afterDuplicateClick.runPosts).toBe(1)
      const afterSettle = observations.afterSettle as { feedback: string | null; disabled: boolean | null; watchesGets: number }
      expect(afterSettle.feedback).toBe("Ran.")
      expect(afterSettle.disabled).toBe(false)
      expect(afterSettle.watchesGets).toBe(2)
    })

    // Lock: settled runs report honest outcomes — a failed script names the
    // failure, a 409 surfaces the service's own error text, a delivery
    // failure says so; the refetch carries the refreshed rows and the
    // top-level summary yields to a per-row badge.
    test("settled runs report honest outcomes and the refetch carries the refreshed rows", async () => {
      const observations = await runScenario("run-now-honest-outcomes-and-refreshed-watches")
      const afterFailed = observations.afterFailed as { feedback: string | null; outcome: string | null; rootText: string }
      expect(afterFailed.feedback).toBe("Watch failed: exit code 3")
      expect(afterFailed.outcome).toBe("failed")
      expect(afterFailed.rootText).toContain("run failed: exit code 3")
      const afterConflict = observations.afterConflict as { feedback: string | null }
      expect(afterConflict.feedback).toBe("watch script disappeared")
      const afterDeliveryError = observations.afterDeliveryError as { feedback: string | null }
      expect(afterDeliveryError.feedback).toBe("Ran; coordinator delivery failed: coordinator session closed")
      const withRowBadge = observations.withRowBadge as { rootText: string }
      expect(withRowBadge.rootText).toContain("coordinator delivery failed: coordinator unreachable")
      expect(withRowBadge.rootText).not.toContain("one notification could not be delivered")
      const withSummaryOnly = observations.withSummaryOnly as { rootText: string }
      expect(withSummaryOnly.rootText).toContain("one notification could not be delivered")
    })

    // Lock: the watches refetch a run triggers is a background fetch — it
    // never resets the manual-refresh age.
    test("the watches refetch a run triggers never resets the manual-refresh age", async () => {
      const observations = await runScenario("run-now-reload-does-not-reset-refresh-age")
      expect(observations.labelBefore).toBe("Refreshed 2m ago")
      expect(observations.labelAfter).toBe("Refreshed 2m ago")
      expect(observations.watchesGetsAfter).toBe((observations.watchesGetsBefore as number) + 1)
      expect(observations.rootText).toContain("Ran.")
    })

    // Lock: a directory change — including the optional null field — resets
    // the flow: drafts close, in-flight markers clear, and a stale run
    // settle from the previous registration lands nowhere.
    test("a directory change resets the flow: drafts close, in-flight markers clear, stale settles land nowhere", async () => {
      const observations = await runScenario("directory-reset-clears-module-state")
      const afterNullDirectory = observations.afterNullDirectory as { rootText: string }
      expect(afterNullDirectory.rootText).toContain("Open a project to launch its first mate.")
      const afterReReady = observations.afterReReady as { formOpen: boolean; runDisabled: boolean | null; lookupGets: number }
      expect(afterReReady.formOpen).toBe(false)
      expect(afterReReady.runDisabled).toBe(false)
      expect(afterReReady.lookupGets).toBe(2)
      const afterStaleSettle = observations.afterStaleSettle as { runPosts: number; rootText: string }
      expect(afterStaleSettle.runPosts).toBe(1)
      expect(afterStaleSettle.rootText).not.toContain("Ran.")
    })
  })
}
