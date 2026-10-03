// Regression coverage for the panel's refresh control and ready lifecycle.
// Each test drives the real panel entry point (firstmate/panel/main.ts) — not
// a re-creation of its refresh logic — by re-spawning this very file under
// `bun test` as a subprocess probe with FM_PROBE_SCENARIO set. The child
// installs the SDK module mock, the fake DOM/window, and the fake clock, so
// none of that leaks into the rest of the suite, and every scenario gets a
// fresh panel module state. No scenario waits on real time: the fake clock
// fires timers manually and the microtask flush settles the fetch chains.

import { describe, expect, test } from "bun:test"
import { join } from "node:path"
import type { ScenarioObservations } from "./helpers/panel-refresh-probe"

const scenarioEnvironmentKey = "FM_PROBE_SCENARIO"
const probeScenario = process.env[scenarioEnvironmentKey]

if (probeScenario !== undefined) {
  // Probe mode: the suite below spawned this file; run the named scenario and
  // print its observations as a tagged JSON line on stdout.
  test(`probe: ${probeScenario}`, async () => {
    const { runProbeScenario } = await import("./helpers/panel-refresh-probe")
    console.log(`__FM_PROBE__${JSON.stringify(await runProbeScenario(probeScenario))}`)
  })
} else {
  type Label = { text: string | null; disabled: boolean }
  type Counts = { lookup: number; board: number; watches: number; shipping: number; suggestions: number }

  async function runScenario(name: string): Promise<ScenarioObservations> {
    const child = Bun.spawn({
      cmd: [process.execPath, "test", "tests/panel-refresh.test.ts"],
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
    const marker = stdout.split("\n").find((line) => line.includes("__FM_PROBE__"))
    if (marker === undefined) {
      throw new Error(`probe "${name}" produced no observations (exit code ${exitCode}):\n${stderr}`)
    }
    return JSON.parse(marker.split("__FM_PROBE__")[1]!) as ScenarioObservations
  }

  function label(observations: ScenarioObservations, key = "label"): Label {
    const value = observations[key] as Label | null
    expect(value).not.toBeNull()
    return value as Label
  }

  function counts(observations: ScenarioObservations, key = "counts"): Counts {
    return observations[key] as Counts
  }

  describe("FirstMate panel refresh", () => {
    // Lock: a naive equality guard on the ready directory (null === null)
    // would swallow the very first ready and leave the panel stuck loading.
    test("the first ready with a null directory initializes the panel, and a later ready starts the flow", async () => {
      const observations = await runScenario("first-ready-null-initializes")
      const afterNullReady = observations["afterNullReady"] as { label: Label | null; lookupCalls: number; rootText: string }
      expect(afterNullReady.rootText).toContain("Open a project to launch its first mate.")
      expect(afterNullReady.lookupCalls).toBe(0)
      expect(afterNullReady.label).toBeNull()
      expect(label(observations).text).toBe("Refreshed just now")
      expect(counts(observations).lookup).toBe(1)
    })

    // Lock: the initial refresh marks the age; the subscription-driven board
    // refetch and the periodic cycle never re-pin it, so the label ages into
    // minutes (60s boundary inclusive).
    test("the label ages into minutes and background fetches never re-pin it", async () => {
      const observations = await runScenario("label-ages-and-background-fetches-never-repin")
      const afterInitial = observations["afterInitial"] as Label & Counts
      expect(afterInitial.text).toBe("Refreshed just now")
      expect(afterInitial.lookup).toBe(1)
      expect(afterInitial.board).toBe(1)
      expect(afterInitial.watches).toBe(1)
      expect(afterInitial.shipping).toBe(1)
      expect(afterInitial.suggestions).toBe(1)
      const afterSubscription = observations["afterSubscription"] as Label & Counts
      expect(afterSubscription.board).toBe(2)
      expect(afterSubscription.watches).toBe(1)
      expect(afterSubscription.text).toBe("Refreshed just now")
      const afterFirstTick = observations["afterFirstTick"] as Label & Counts
      expect(afterFirstTick.board).toBe(3)
      expect(afterFirstTick.text).toBe("Refreshed just now")
      const afterSixtySeconds = observations["afterSixtySeconds"] as Label & Counts
      expect(afterSixtySeconds.board).toBe(4)
      expect(afterSixtySeconds.text).toBe("Refreshed 1m ago")
      expect(label(observations).text).toBe("Refreshed 2m ago")
      expect(counts(observations).board).toBe(7)
    })

    // Bug: the host replays the ready event with the same directory (it
    // re-posts ready on iframe loads and payload changes). The replay must
    // reapply the theme but keep the board flow, the age, and open drafts.
    test("a same-directory ready replay preserves the flow, the age, and the watch draft", async () => {
      const observations = await runScenario("same-directory-ready-replay-preserves-flow")
      const beforeReplay = observations["beforeReplay"] as Label & Counts & { themeApplications: number; watchNameDraft: string | null }
      expect(beforeReplay.text).toBe("Refreshed 1m ago")
      expect(beforeReplay.watchNameDraft).toBe("nightly")
      const afterReplay = observations["afterReplay"] as Label & Counts & { themeApplications: number; watchNameDraft: string | null }
      expect(afterReplay.themeApplications).toBe(2)
      expect(afterReplay.lookup).toBe(beforeReplay.lookup)
      expect(afterReplay.board).toBe(beforeReplay.board)
      expect(afterReplay.watches).toBe(beforeReplay.watches)
      expect(afterReplay.shipping).toBe(beforeReplay.shipping)
      expect(afterReplay.suggestions).toBe(beforeReplay.suggestions)
      expect(afterReplay.text).toBe("Refreshed 1m ago")
      expect(afterReplay.watchNameDraft).toBe("nightly")
      expect(observations["boardCallsAfterLaterTick"]).toBe(beforeReplay.board + 1)
    })

    // Bug: a first cycle whose fetches all fail still marks the age as fresh.
    // The control must read exactly "Refresh failed" and recover afterwards.
    test("a failed first refresh cycle reads Refresh failed, not a fake age", async () => {
      const observations = await runScenario("failed-initial-refresh-shows-refresh-failed")
      const afterFailedInitial = observations["afterFailedInitial"] as Label & { rootText: string }
      expect(afterFailedInitial.text).toBe("Refresh failed")
      expect(afterFailedInitial.rootText).toContain("Reading the board failed: the service is unreachable.")
      expect(label(observations).text).toBe("Refreshed just now")
    })

    // Bug: one failing fetch of four still marks the age as fresh.
    test("a partially failed first refresh cycle reads Refresh failed too", async () => {
      const observations = await runScenario("partial-initial-refresh-failure-is-not-fresh")
      const afterPartialFailure = observations["afterPartialFailure"] as Label & { rootText: string }
      expect(afterPartialFailure.text).toBe("Refresh failed")
      expect(afterPartialFailure.rootText).toContain("Reading the watches failed (status 500).")
      expect(label(observations).text).toBe("Refreshed just now")
    })

    // Bug: a failed manual refresh re-pins the age to now. The label must keep
    // the last successful age AND name the failure, stay retryable, and the
    // next successful press must recover the fresh age.
    test("a failed manual refresh keeps the prior age, shows the failure, and recovers", async () => {
      const observations = await runScenario("failed-manual-refresh-keeps-prior-age-and-shows-failure")
      expect(label(observations, "beforeFailedManual").text).toBe("Refreshed 2m ago")
      const afterFailedManual = label(observations, "afterFailedManual")
      expect(afterFailedManual.text).toContain("Refresh failed")
      expect(afterFailedManual.text).toContain("2m ago")
      expect(afterFailedManual.disabled).toBe(false)
      expect(label(observations).text).toBe("Refreshed just now")
      expect(label(observations).disabled).toBe(false)
    })

    // Lock: while the panel's first fetch cycle is in flight the control reads
    // "Refreshing…" and success marks the age.
    test("the first in-flight refresh cycle shows Refreshing", async () => {
      const observations = await runScenario("first-inflight-shows-refreshing")
      const whilePending = observations["whilePending"] as Label & Counts
      expect(whilePending.text).toBe("Refreshing…")
      expect(whilePending.lookup).toBe(1)
      expect(label(observations).text).toBe("Refreshed just now")
    })

    // Lock: a manual press issues each of the four fetches exactly once,
    // disables the control, ignores a duplicate press, and recovers.
    test("a manual refresh issues the four fetches once and guards a duplicate press", async () => {
      const observations = await runScenario("manual-refresh-issues-four-requests-once-and-guards-duplicate")
      const baseline = counts(observations, "baseline")
      const whileInFlight = observations["whileInFlight"] as { label: Label; counts: Counts }
      expect(whileInFlight.counts.board).toBe(baseline.board + 1)
      expect(whileInFlight.counts.watches).toBe(baseline.watches + 1)
      expect(whileInFlight.counts.shipping).toBe(baseline.shipping + 1)
      expect(whileInFlight.counts.suggestions).toBe(baseline.suggestions + 1)
      expect(whileInFlight.counts.lookup).toBe(baseline.lookup)
      expect(whileInFlight.label.text).toBe("Refreshing…")
      expect(whileInFlight.label.disabled).toBe(true)
      expect(counts(observations, "afterDuplicatePress")).toEqual(whileInFlight.counts)
      expect(label(observations).text).toBe("Refreshed just now")
      expect(label(observations).disabled).toBe(false)
    })

    // Lock: a genuine directory switch restarts the flow for the new
    // registration and drops drafts; a switch to an unregistered directory
    // shows the welcome card without a refresh control.
    test("a genuine directory switch resets the flow", async () => {
      const observations = await runScenario("directory-switch-resets-flow")
      const afterSwitch = observations["afterSwitch"] as { label: Label; lookupCalls: number; watchNameDraft: string | null }
      expect(afterSwitch.lookupCalls).toBe(2)
      expect(afterSwitch.label.text).toBe("Refreshing…")
      expect(afterSwitch.watchNameDraft).toBeNull()
      const heldForB = observations["heldForB"] as { board: number; suggestions: number }
      expect(heldForB.board).toBe(1)
      expect(heldForB.suggestions).toBe(1)
      expect(label(observations, "afterBSuccess").text).toBe("Refreshed just now")
      expect(observations.label).toBeNull()
      expect(observations.rootText).toContain("Launch first mate")
      expect(observations.counts.lookup).toBe(3)
    })

    // Bug: the old directory's initial refresh settles after the switch; its
    // completion must not mark the new flow's timestamp or failure state.
    test("a stale initial refresh completion does not pollute the new flow", async () => {
      const observations = await runScenario("stale-initial-refresh-completion-does-not-pollute-new-flow")
      expect(label(observations, "whileBPending").text).toBe("Refreshing…")
      expect(label(observations, "afterStaleFailure").text).toBe("Refreshing…")
      expect(label(observations, "afterBOwnInitialSuccess").text).toBe("Refreshed just now")
      expect(observations.counts.lookup).toBe(2)
    })

    // Bug: the old directory's manual refresh settles after the switch; its
    // completion must not re-pin the new flow's age either.
    test("a stale manual refresh completion does not pollute the new flow", async () => {
      const observations = await runScenario("stale-manual-refresh-completion-does-not-pollute-new-flow")
      const whileManualPending = label(observations, "whileManualPending")
      expect(whileManualPending.text).toBe("Refreshing…")
      expect(whileManualPending.disabled).toBe(true)
      expect(label(observations, "whileBPending").text).toBe("Refreshing…")
      expect(label(observations, "afterStaleFailure").text).toBe("Refreshing…")
      expect(label(observations, "afterBOwnInitialSuccess").text).toBe("Refreshed just now")
      expect(label(observations).disabled).toBe(false)
    })
  })
}
