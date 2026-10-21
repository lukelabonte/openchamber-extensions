import { describe, expect, test } from "bun:test"
import { join } from "node:path"

const scenarioEnvironmentKey = "FM_PORT_PROBE"
const probeScenario = process.env[scenarioEnvironmentKey]

if (probeScenario !== undefined) {
  test(`probe: ${probeScenario}`, async () => {
    const { runPortScenario } = await import("./helpers/panel-port-probe")
    console.log(`__FM_PORT_PROBE__${JSON.stringify(await runPortScenario(probeScenario))}`)
  })
} else {
  async function runScenario(name: string): Promise<any> {
    const child = Bun.spawn({
      cmd: [process.execPath, "test", "tests/panel-port.test.ts"],
      cwd: join(import.meta.dir, ".."),
      env: { ...process.env, [scenarioEnvironmentKey]: name },
      stdout: "pipe",
      stderr: "pipe",
    })
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ])
    const marker = stdout.split("\n").find((line) => line.startsWith("__FM_PORT_PROBE__"))
    if (exitCode !== 0 || marker === undefined) throw new Error(`probe ${name} failed (${exitCode}):\n${stderr}`)
    return JSON.parse(marker.slice("__FM_PORT_PROBE__".length))
  }

  describe("FirstMate panel parity port", () => {
    test("the worker picker counts unique unfinished sessions and opens a row from coordinator or worker context", async () => {
      const result = await runScenario("worker-list")
      expect(result.count).toBe("4 active workers")
      expect(result.initialExpanded).toBe("false")
      expect(result.expanded).toBe("true")
      expect(result.rowCount).toBe(7)
      expect(result.listText).toContain("<script>Worker A</script>")
      expect(result.listText).not.toContain("Previously done")
      for (const state of ["Queued", "Working", "Blocked", "Idle", "Parked", "Done", "Failed"]) expect(result.listText).toContain(state)
      expect(result.opened).toEqual(["ses-worker-a", "ses-worker-b"])
      expect(result.current).toBe("true")
      expect(result.workerExpanded).toBe("true")
      expect(result.collapsed).toBe("false")
      expect(result.innerHtmlWrites).toBe(0)
    })

    test("the worker picker distinguishes loading, unavailable, stale and empty data, and resets on project changes", async () => {
      const result = await runScenario("worker-list-refresh")
      expect(result.loading).toBe("Workers loading…")
      expect(result.loadingDisabled).toBe(true)
      expect(result.unavailable).toBe("Workers unavailable")
      expect(result.stale).toBe("2 active workers (stale)")
      expect(result.staleRows).toBe(2)
      expect(result.updated).toBe("1 active worker")
      expect(result.updatedRows).toBe(1)
      expect(result.updatedExpanded).toBe("true")
      expect(result.newProjectExpanded).toBe("false")
      expect(result.empty).toBe("0 active workers")
      expect(result.emptyText).toContain("No worker sessions yet.")
    })

    test("failed worker navigation is visible without an unhandled rejection and clears on project changes", async () => {
      const result = await runScenario("worker-list-error")
      expect(result.failureText).toContain("Could not open the worker session. Try again.")
      expect(result.afterRefreshText).toContain("Could not open the worker session. Try again.")
      expect(result.newProjectText).not.toContain("Could not open the worker session")
    })

    test.each(["shell-view", "shell-removal"])("worker commands are scoped and released on project change or card removal: %s", async (scenario) => {
      const result = await runScenario(scenario)
      expect(result.shellScopes).toEqual([{ kind: "session", sessionId: "ses-worker-a" }])
      expect(result.shellReads).toEqual([{ id: "shell-own", options: { tailBytes: 16384 } }])
      expect(result.workerText).toContain("bun test <literal>")
      expect(result.workerText).toContain("<script>literal output</script>")
      expect(result.workerText).toContain("Earlier output skipped")
      expect(result.workerText).not.toContain("private unrelated command")
      expect(result.shellUnsubscribes).toBe(1)
      expect(result.settingsInputPreserved).toBe(true)
      expect(result.text).not.toContain("stale private command")
      expect(result.innerHtmlWrites).toBe(0)
    })

    test("closing reports are labeled as worker testimony and rendered as literal text", async () => {
      const result = await runScenario("worker-report")
      expect(result.workerText).toContain("Worker reported done: <script>worker testimony</script>")
      expect(result.workerText).not.toContain("A long preamble")
      expect(result.workerText).toContain("Idle")
      expect(result.hasReportedPr).toBe(true)
      expect(result.innerHtmlWrites).toBe(0)
    })

    test("an empty closing report explicitly says details weren't supplied", async () => {
      expect((await runScenario("worker-report-empty")).workerText).toContain("Worker reported done: No details supplied.")
    })

    test("failed later board reads keep stale cards and their controls, then recover", async () => {
      const result = await runScenario("board-last-good")
      expect(result.staleText).toContain("Worker A")
      expect(result.staleText).toContain("Board is stale")
      expect(result.staleText).toContain("Reading the board failed (status 500)")
      expect(result.staleRefresh).toContain("Refresh failed")
      expect(result.interruptDisabled).toBe(false)
      expect(result.workerText).toContain("Board is stale")
      expect(result.workerText).toContain("Worker A")
      expect(result.text).not.toContain("Board is stale")
    })

    test.each(["success", "failure", "reject", "malformed"])("an older board %s cannot overwrite a newer board result or freshness verdict", async (outcome) => {
      const result = await runScenario(`board-old-${outcome}`)
      expect(result.text).toContain("Newest worker")
      expect(result.text).not.toContain("Old worker")
      expect(result.text).not.toContain("Board is stale")
      expect(result.refresh).toBe(result.labelBeforeOld)
      expect(result.refresh).toBe("Refreshed 1m ago")
    })

    test("a newer board failure cannot be hidden by an older successful refresh", async () => {
      const result = await runScenario("board-new-failure")
      expect(result.text).toContain("Worker A")
      expect(result.text).toContain("Board is stale")
      expect(result.text).not.toContain("Old worker")
      expect(result.refresh).toContain("Refresh failed")
      expect(result.refresh).toContain("1m ago")
    })

    test("a superseded initial read never claims freshness or stays stuck refreshing after settlement", async () => {
      const result = await runScenario("board-initial-superseded")
      expect(result.supersededText).toContain("Newest worker")
      expect(result.supersededText).not.toContain("Old worker")
      expect(result.supersededRefresh).toBe("Not refreshed yet")
      expect(result.refresh).toBe("Refreshed just now")
    })

    test("a delayed aggregate verdict cannot mark an earlier board read fresh after a newer failure", async () => {
      const result = await runScenario("board-delayed-verdict")
      expect(result.text).toContain("Worker A")
      expect(result.text).toContain("Board is stale")
      expect(result.refresh).toContain("Refresh failed")
      expect(result.refresh).toContain("1m ago")
    })

    test.each(["bearings", "bearings-file", "ahoy"])("%s commands synchronously guard repeated and competing captain sends across renders", async (command) => {
      const result = await runScenario(`command-pending-${command}`)
      expect(result.whilePendingPosts).toHaveLength(1)
      expect(result.whilePendingPosts[0]).toEqual({ path: "/command", body: { slug: "proj-a", command } })
      expect(result.pendingDisabled).toEqual([true, true, true, true])
      expect(result.noteDisabled).toBe(true)
      expect(result.decisionDraft).toBe("Keep the decision draft")
      expect(result.noteDraft).toBe("Keep the note draft")
      expect(result.retryEnabled).toBe(true)
      expect(result.posts).toHaveLength(2)
    })

    test.each(["http", "malformed", "unsent", "throw", "reject"])("command %s failures are visible, survive refresh, and release the send gate", async (failure) => {
      const result = await runScenario(`command-failure-${failure}`)
      expect(result.failureText).toContain(failure === "http" ? "coordinator unavailable" : failure === "throw" || failure === "reject" ? "bridge failed" : "malformed delivery answer")
      expect(result.failureText).not.toContain("Requested")
      expect(result.retryEnabled).toBe(true)
      expect(result.posts).toHaveLength(2)
    })

    test.each(["suggestion", "decision", "note"])("a pending %s also guards report commands without losing drafts", async (source) => {
      const result = await runScenario(`captain-gate-${source}`)
      expect(result.pendingPosts).toHaveLength(1)
      expect(result.reportDisabled).toBe(true)
      expect(result.posts).toHaveLength(2)
      expect(result.posts[1].path).toBe("/command")
    })

    test("a stale command response cannot publish feedback or unlock the next project's send", async () => {
      const result = await runScenario("command-stale")
      expect(result.afterStaleText).not.toContain("old command error")
      expect(result.afterStaleDisabled).toBe(true)
      expect(result.posts.map((post: any) => post.body.slug)).toEqual(["proj-a", "proj-b"])
      expect(result.retryEnabled).toBe(true)
    })

    test("suggestion sends remain guarded and independent by registration when an old send settles", async () => {
      const result = await runScenario("suggestion-stale-gate")
      expect(result.pendingPosts.map((post: any) => post.body.slug)).toEqual(["proj-a", "proj-b"])
      expect(result.afterOldDisabled).toBe(true)
      expect(result.readsAfterOld).toBe(result.readsBeforeOld)
      expect(result.retryEnabled).toBe(true)
      expect(result.text).not.toContain("old suggestion error")
    })

    test("copies the precise worker message target without pretending the SDK can open it", async () => {
      const result = await runScenario("message-link")
      expect(result.copied).toEqual(["openchamber://session/ses-worker-a?message=msg_report"])
      expect(result.opened).toEqual([])
      expect(result.text).toContain("Message link copied")
      expect(result.innerHtmlWrites).toBe(0)
    })

    test("legacy workers without observed message IDs don't get fabricated message targets", async () => {
      expect((await runScenario("message-legacy")).hasMessageLink).toBe(false)
    })

    test("variant defaults have readable labels without changing provider-specific wire values", async () => {
      const result = await runScenario("variant-labels")
      expect(result.workerDefault).toBe("Leave it to the first mate")
      expect(result.coordinatorDefault).toBe("OpenChamber default")
      expect(result.text).toContain("Blank worker fields require the first mate to choose an explicit model and effort variant")
      expect(result.text).toContain("before creating or resuming a worker")
      expect(result.text).not.toContain("Blank models use OpenChamber defaults")
      expect(result.posts[0].body.settings.workerVariant).toBe("")
      expect(result.posts[0].body.settings.coordinatorVariant).toBe("")
      expect(result.posts[1].body.settings.workerVariant).toBe("provider:adaptive/extended")
      expect(result.posts[1].body.settings.coordinatorVariant).toBe("thinking/extended:custom")
    })

    test("parent and directory changes refresh the backlog-owned board even when activity is unchanged", async () => {
      const result = await runScenario("parent-refresh")
      expect(result.afterIncomplete).toBe(result.baseline)
      expect(result.counts).toEqual([result.baseline + 1, result.baseline + 2, result.baseline + 3])
      expect(result.afterRemoval).toBe(result.baseline + 4)
      expect(result.text).toContain("Worker A")
      expect(result.text).toContain("Worker B")
      expect(result.posts).toEqual([])
    })

    test("steer and relaunch drafts survive board and auxiliary renders and clear on project switch", async () => {
      const result = await runScenario("worker-action-drafts")
      expect(result.afterBoard).toEqual({ steer: "Keep this steer", relaunch: "Keep this relaunch" })
      expect(result.afterAuxiliary).toEqual({ steer: "Keep this steer", relaunch: "Keep this relaunch" })
      expect(result.afterProjectSwitch).toEqual({ steer: "", relaunch: "" })
      expect(result.posts).toEqual([])
    })

    test.each(["steer", "relaunch", "interrupt", "end"])("pending %s requests stay disabled across renders and cannot be sent twice", async (action) => {
      const result = await runScenario(`worker-${action}-pending`)
      expect(result.pendingDisabled).toBe(true)
      expect(result.requestsBeforeRelease).toBe(1)
      expect(result.feedbackAfterRefresh).toContain(result.successMessage)
      if (action === "steer" || action === "relaunch") {
        expect(result.draftWhilePending).toBe("Keep this message")
        expect(result.inputDisabled).toBe(true)
        expect(result.draftAfterSuccess).toBe("")
      }
    })

    test("End confirmation survives background renders but never follows a project switch", async () => {
      const result = await runScenario("worker-end-confirmation")
      expect(result.confirmationAfterRefresh).toBe(true)
      expect(result.requestsBeforeConfirmation).toBe(0)
      expect(result.posts).toEqual([{ path: "/end", body: { slug: "proj-a", sessionId: "ses-worker-a" } }])
      expect(result.confirmationAfterProjectSwitch).toBe(false)
    })

    test.each(["steer", "relaunch"])("failed %s preserves its draft and feedback until a confirmed successful retry", async (action) => {
      const result = await runScenario(`worker-${action}-failure`)
      expect(result.draftAfterFailure).toBe("Keep this failed message")
      expect(result.feedbackAfterFailure).toContain("The worker could not accept this request.")
      expect(result.retryEnabled).toBe(true)
      expect(result.draftAfterRetry).toBe("")
      expect(result.feedbackAfterRetry).toContain("Sent, but coordinator delivery failed.")
      expect(result.posts).toHaveLength(2)
    })

    test.each(["steer", "relaunch"])("a stale %s failure cannot restore a draft or feedback after switching projects", async (action) => {
      const result = await runScenario(`worker-${action}-stale`)
      expect(result.draftAfterSwitch).toBe("")
      expect(result.inputDisabledAfterSwitch).toBe(false)
      expect(result.feedbackAfterStale).not.toContain("old worker action failed")
      expect(result.boardCallsAfterStale).toBe(result.boardCallsBeforeStale)
      expect(result.posts.map((request: { body: { slug: string } }) => request.body.slug)).toEqual(["proj-a", "proj-b"])
    })

    test("captain decisions relay the exact task ID and selected label, without a worker session", async () => {
      const result = await runScenario("decision")
      expect(result.posts).toEqual([
        { path: "/decision", body: { slug: "proj-a", taskId: "decision-1", label: "Proceed", expectedText: "Approve the smaller change" } },
        { path: "/decision", body: { slug: "proj-a", taskId: "decision-1", text: "Use the smaller change" } },
      ])
      expect(result.text).toContain("Hold: captain approval")
      expect(result.text).not.toContain("Merged directly")
      expect(result.text).not.toContain("Merged.")
    })

    test("decision drafts and in-flight guards survive refreshes, but not a project switch", async () => {
      const result = await runScenario("stale-decision")
      expect(result.draftBeforeSwitch).toBe("keep this answer")
      expect(result.posts).toHaveLength(1)
      expect(result.answerAfterSwitch).toBe("")
      expect(result.text).not.toContain("old project error")
    })

    test("a changed-action rejection preserves the answer and captain hold without claiming success", async () => {
      const result = await runScenario("rejected-decision")
      expect(result.text).toContain("action changed; refresh before choosing")
      expect(result.text).toContain("Hold: captain approval")
      expect(result.answer).toBe("keep this answer")
      expect(result.text).not.toContain("Sent to first mate;")
    })

    test("suggestions expose expandable, selectable full text and optional host clipboard copy", async () => {
      const result = await runScenario("suggestion")
      expect(result.fullText).toBe(result.suggestionText)
      expect(result.copied).toEqual([result.suggestionText])
      expect(result.openAfterRefresh).toBe(true)
      expect(result.innerHtmlWrites).toBe(0)
    })

    test("column reorder persists while hiding empty columns and preserving folds", async () => {
      const result = await runScenario("columns")
      expect(result.columns).toEqual(["Blocked", "Working"])
      expect(result.persisted.slice(0, 3)).toEqual(["Queued", "Blocked", "Working"])
      expect(result.folded).toBe(true)
    })

    test("settings save full provider/model IDs and variants and reschedule refreshes", async () => {
      const result = await runScenario("settings")
      expect(result.beforeTick).toBe(result.baseline)
      expect(result.afterTick).toBe(result.baseline + 1)
      expect(result.saved).toEqual({
        slug: "proj-a", settings: {
          coordinatorModel: "openai/gpt-example", coordinatorVariant: "high",
          workerModel: "anthropic/claude-example", workerVariant: "fast", refreshSeconds: 5,
        },
      })
      expect(result.draftAfterRefresh).toBe("openai/gpt-example")
      expect(result.text).toContain("provider/model")
    })

    test("settings reject fractional/out-of-range refresh intervals before posting", async () => {
      const result = await runScenario("invalid-settings")
      expect(result.posts).toEqual([])
      expect(result.text).toContain("integer from 5 to 3600")
    })

    test("stale settings cannot replace the next project's defaults or timer, including an A/B/A switch", async () => {
      const result = await runScenario("stale-settings")
      expect(result.interval).toBe("30")
      expect(result.boardCalls).toBe(result.baseline)
      expect(result.text).not.toContain("old-model")
    })

    test("switching projects resets an active five-second timer to the next project's thirty-second default", async () => {
      const result = await runScenario("project-timer")
      expect(result.beforeTick).toBe(result.baseline)
      expect(result.afterTick).toBe(result.baseline + 1)
      expect(result.interval).toBe("30")
    })

    test("an A/B/A context switch rejects the earlier lookup even when the directory matches again", async () => {
      const result = await runScenario("stale-lookup")
      expect(result.beforeCurrentLookup).toContain("Reading the project")
      expect(result.boardCallsBeforeCurrent).toBe(0)
      expect(result.text).not.toContain("Old Project")
      expect(result.refresh).toBe("Refreshed just now")
    })

    test("missing optional endpoints preserve the core board refresh verdict", async () => {
      const result = await runScenario("absent-extras")
      expect(result.refresh).toBe("Refreshed just now")
      expect(result.text).toContain("Needs your call")
      expect(result.text).not.toContain("Reading the settings failed")
    })

    test("known optional capabilities surface failures without failing the core refresh", async () => {
      const result = await runScenario("known-extra-error")
      expect(result.refresh).toBe("Refreshed just now")
      expect(result.text).toContain("Reading the settings failed")
      expect(result.text).toContain("Reading the upgrades failed")
      expect(result.text).toContain("Reading the watch notes failed")
    })

    test("upgrade comparison is text-only and acknowledgement never sends replacement contents", async () => {
      const result = await runScenario("upgrades")
      expect(result.comparison).toBe("<script>personal words</script>\nupstream comparison")
      expect(result.posts).toEqual([{ path: "/upgrades/ack", body: { slug: "proj-a", name: "charter" } }])
      expect(result.innerHtmlWrites).toBe(0)
      expect(result.text).toContain("does not overwrite")
    })

    test("an old project's upgrade comparison cannot render or enable acknowledgement in the new project", async () => {
      const result = await runScenario("stale-upgrade")
      expect(result.text).not.toContain("old-project comparison")
      expect(result.acknowledgePresent).toBe(false)
    })

    test("watch history is bounded, expandable, and distinguishes pending delivery from retained notes", async () => {
      const result = await runScenario("watchnotes")
      expect(result.notes).toBe(50)
      expect(result.text).toContain("Pending delivery: 3")
      expect(result.text).toContain("Dropped: 2")
      expect(result.text).toContain("Retained watch notes")
      expect(result.innerHtmlWrites).toBe(0)
    })

    test("restart and release require two clicks and preserve the old session/worktree", async () => {
      const result = await runScenario("lifecycle")
      expect(result.restartFirstClickPosts).toBe(0)
      expect(result.releaseFirstClickPosts).toBe(1)
      expect(result.posts).toEqual([
        { path: "/coordinator/restart", body: { slug: "proj-a" } },
        { path: "/coordinator/release", body: { slug: "proj-a" } },
      ])
      expect(result.restartedSession).toBe("ses-fresh")
      expect(result.confirmation).toContain("old chat is preserved")
      expect(result.confirmation).toContain("backlog and workers continue")
      expect(result.releaseConfirmation).toContain("session and worktree are preserved")
      expect(result.text).toContain("Launch first mate")
      expect(result.text).not.toContain("Compact")
    })

    test("adopt sends the home-bound candidate only on explicit action and resets the registration", async () => {
      const result = await runScenario("adopt")
      expect(result.posts).toEqual([{ path: "/coordinator/adopt", body: { slug: "proj-a", sessionId: "ses-candidate" } }])
      expect(result.session).toBe("ses-candidate")
      expect(result.text).toContain("server verifies")
    })

    test("release from the home chat still launches the project, never a first mate for the home directory", async () => {
      const result = await runScenario("home-release")
      expect(result.launch).toEqual({ projectDirectory: "/repos/a" })
      expect(result.refresh).toBe("Refreshed just now")
    })

    test("worker session context shows its card only and sends a handoff, not a steer or decision", async () => {
      const result = await runScenario("worker")
      expect(result.workerText).toContain("Worker A")
      expect(result.workerText).not.toContain("Worker B")
      expect(result.workerText).not.toContain("Steer")
      expect(result.posts).toEqual([{ path: "/handoff", body: { directory: "/repos/a", sessionId: "ses-worker-a", text: "A note for the first mate" } }])
      expect(result.opened).toEqual(["ses-a"])
      expect(result.afterSessionChange).toContain("Worker B")
      expect(result.afterUnrelatedSession).toContain("Needs your call")
      expect(result.innerHtmlWrites).toBe(0)
    })
  })
}
