// Runs ONE named panel-reliability scenario against the real panel entry
// point (firstmate/panel/main.ts) and prints the observations as a tagged
// JSON line. It is never executed directly: tests/panel-reliability.test.ts
// re-spawns its own file under `bun test` with FM_RELIABILITY_PROBE set (a
// key unique to this suite, so the refresh suite's FM_PROBE_SCENARIO child
// can never trigger this probe, and vice versa). The child owns the SDK
// module mock, the shared fake DOM/window/clock harness, and a fresh panel
// module state, so nothing leaks into the rest of the suite. Every wait is a
// held promise or a fake-clock tick settled by microtask flushes — the
// barrier is promises, never real sleeps.

import { mock } from "bun:test"
import { join } from "node:path"
import {
  collectText,
  fakeTimeOrigin,
  findByAriaLabel,
  findByText,
  installFakeEnvironment,
  type FakeElement,
} from "./panel-harness"

export type ReliabilityObservations = Record<string, unknown>

type RunNowResponse = { status: number; body: string }

// The one registration the fake service hands out. Each /lookup returns a
// fresh object, mirroring the real service's JSON answer: main.ts's
// stale-settle guards compare registration identity, and a parsed answer is
// never the same object twice.
const registration = {
  slug: "proj-a",
  projectDirectory: "/repos/a",
  homeDirectory: "/home/a",
  coordinatorSessionId: "ses-a",
  createdAt: "2026-01-01T00:00:00.000Z",
}

// Timestamps are anchored to the harness's fixed clock origin, so relative
// labels ("just now", "(stale)", "ahead of local clock") are deterministic.
const iso = (offsetMs: number): string => new Date(fakeTimeOrigin + offsetMs).toISOString()

type Controller = {
  ready: (directory: string | null) => void
  directoryChanged: (directory: string | null) => void
  fireSessions: () => void
  clickRefresh: () => void
  clickRunNow: (watchName: string) => void
  flush: () => Promise<void>
  advanceMs: (ms: number) => Promise<void>
  holdRunNow: () => void
  releaseRunNow: (response: RunNowResponse) => void
  setBoard: (board: unknown) => void
  setWatches: (watches: unknown, deliveryError?: string) => void
  setShipping: (shipping: unknown) => void
  setSuggestions: (suggestions: unknown) => void
  gets: (path: string) => number
  posts: (path: string) => string[]
  metaValue: (label: string) => string | null
  metaTitle: (label: string) => string
  runNowState: (watchName: string) => { disabled: boolean; title: string } | null
  feedback: (watchName: string) => string | null
  cardBadgeTexts: () => Array<string | null>
  blockedNoteTexts: () => string[]
  awaitingCleanupBadges: () => number
  cleanupButtonCount: () => number
  hasButton: (text: string) => boolean
  buttonDisabled: (text: string) => boolean | null
  refreshLabel: () => { text: string | null; disabled: boolean } | null
  openWatchCreateForm: () => void
  watchNameDraft: () => string | null
  rootText: () => string
}

const scenarios: Record<string, (controller: Controller) => Promise<Record<string, unknown>>> = {
  // The two observation channels render as separate labeled meta pieces with
  // their own reasons, the last clean poll reads "just now" against the
  // fixed clock, and nothing anywhere claims the view is "Live".
  async "supervision-renders-separate-cautious-health"(controller) {
    controller.setBoard({
      workers: [],
      supervision: {
        blockedObservation: "degraded",
        blockedObservationReason: "worker transcript unreadable",
        failureObservation: "unavailable",
        failureObservationReason: "host bridge closed",
        lastSuccessfulPollAt: iso(0),
      },
    })
    controller.ready("/repos/a")
    await controller.flush()
    return {
      blocked: controller.metaValue("blocked observation"),
      failure: controller.metaValue("failure observation"),
      poll: controller.metaValue("last successful poll"),
      rootText: controller.rootText(),
    }
  },

  // A missing or malformed supervision record renders "Unknown" for both
  // channels and "Not polled yet" for the poll — never a healthy
  // "Available" claim.
  async "missing-and-malformed-supervision-read-unknown"(controller) {
    controller.setBoard({ workers: [] })
    controller.ready("/repos/a")
    await controller.flush()
    const missing = {
      blocked: controller.metaValue("blocked observation"),
      failure: controller.metaValue("failure observation"),
      poll: controller.metaValue("last successful poll"),
      rootText: controller.rootText(),
    }
    controller.setBoard({ workers: [], supervision: { blockedObservation: "excellent", failureObservation: "working" } })
    await controller.advanceMs(30_000)
    const malformed = {
      blocked: controller.metaValue("blocked observation"),
      failure: controller.metaValue("failure observation"),
      rootText: controller.rootText(),
    }
    return { missing, malformed }
  },

  // A poll older than a minute is marked "(stale)" and a timestamp ahead of
  // the local clock says so explicitly, with the absolute time on hover;
  // neither ever reads as "Live".
  async "stale-and-future-poll-ages"(controller) {
    controller.setBoard({
      workers: [],
      supervision: { blockedObservation: "working", failureObservation: "working", lastSuccessfulPollAt: iso(-61_000) },
    })
    controller.ready("/repos/a")
    await controller.flush()
    const stale = {
      poll: controller.metaValue("last successful poll"),
      pollTitle: controller.metaTitle("last successful poll"),
      rootText: controller.rootText(),
    }
    controller.setBoard({
      workers: [],
      supervision: { blockedObservation: "working", failureObservation: "working", lastSuccessfulPollAt: iso(120_000) },
    })
    await controller.advanceMs(30_000)
    const future = {
      poll: controller.metaValue("last successful poll"),
      pollTitle: controller.metaTitle("last successful poll"),
      rootText: controller.rootText(),
    }
    return { stale, future }
  },

  // The stall flag is advisory: the note shows on an unfinished card while
  // the state badge and the actions stay untouched, an unparseable baseline
  // renders no note, and a finished card renders none either.
  async "stall-note-is-advisory-with-actions"(controller) {
    const worker = { title: "Ship login", state: "Working", sessionId: "ses_w1", possiblyStalledSince: iso(-40 * 60_000) }
    controller.setBoard({ workers: [worker] })
    controller.ready("/repos/a")
    await controller.flush()
    const stalled = {
      notes: controller.blockedNoteTexts(),
      badges: controller.cardBadgeTexts(),
      interruptDisabled: controller.buttonDisabled("Interrupt"),
      hasOpenSession: controller.hasButton("Open session"),
      hasEnd: controller.hasButton("End"),
    }
    controller.setBoard({ workers: [{ ...worker, possiblyStalledSince: "not a date" }] })
    await controller.advanceMs(30_000)
    const invalidDate = { notes: controller.blockedNoteTexts(), badges: controller.cardBadgeTexts() }
    controller.setBoard({ workers: [{ ...worker, state: "Done" }] })
    await controller.advanceMs(30_000)
    const done = { notes: controller.blockedNoteTexts(), badges: controller.cardBadgeTexts() }
    return { stalled, invalidDate, done }
  },

  // Landing cleanup display: pending shows the badge plus the recorded path,
  // removed and unknown say so, the top-level cleanupError renders, an
  // invalid cleanup claim drops only the metadata (the landing stays
  // visible), and no cleanup block ever offers a mutation control.
  async "cleanup-rendering"(controller) {
    controller.setShipping({
      mode: "direct-PR",
      yolo: false,
      cleanupError: "the backlog record could not be read",
      landings: [
        { task: "Pending landing", commit: "1a2b3c4d", ci: "green", mode: "direct-PR", authorization: "+yolo", landedAt: iso(0), cleanup: { worktree: "/repos/a/.worktrees/pending", state: "pending" } },
        { task: "Removed landing", commit: "2b3c4d5e", ci: "green", mode: "direct-PR", authorization: "+yolo", landedAt: iso(0), cleanup: { worktree: "/repos/a/.worktrees/removed", state: "removed" } },
        { task: "Unknown landing", commit: "3c4d5e6f", ci: "green", mode: "direct-PR", authorization: "+yolo", landedAt: iso(0), cleanup: { worktree: "/repos/a/.worktrees/quiet", state: "unknown" } },
        { task: "Broken landing", commit: "4d5e6f7a", ci: "green", mode: "direct-PR", authorization: "+yolo", landedAt: iso(0), cleanup: { worktree: "", state: "pending" } },
      ],
      landingErrors: [],
    })
    controller.ready("/repos/a")
    await controller.flush()
    return {
      rootText: controller.rootText(),
      awaitingCleanupBadges: controller.awaitingCleanupBadges(),
      cleanupButtons: controller.cleanupButtonCount(),
    }
  },

  // Run now sends exactly {slug, name, source} as the JSON POST body; a
  // switched-off schedule still allows a manual run while an unparseable
  // cron leaves the button disabled with the reason on hover.
  async "run-now-contract-and-schedule-gating"(controller) {
    controller.setWatches([
      { name: "pr-watch", source: "shared", schedule: "*/5 * * * *", enabled: true, path: "/home/a/watches/pr.sh" },
      { name: "nightly", source: "project", schedule: "0 9 * * 1-5", enabled: false },
      { name: "broken", source: "shared", schedule: "nonsense", enabled: true, error: "invalid watch schedule" },
    ])
    controller.ready("/repos/a")
    await controller.flush()
    const nightly = controller.runNowState("nightly")
    const broken = controller.runNowState("broken")
    controller.clickRunNow("pr-watch")
    await controller.flush()
    return {
      sentBody: controller.posts("/watch/run")[0] ?? null,
      feedback: controller.feedback("pr-watch"),
      nightlyDisabled: nightly === null ? null : nightly.disabled,
      brokenDisabled: broken === null ? null : broken.disabled,
      brokenTitle: broken === null ? null : broken.title,
    }
  },

  // The in-flight marker lives outside the DOM: a sessions-triggered board
  // refetch re-renders the row and the rebuilt Run now button stays
  // disabled, a duplicate click sends no extra POST, and the settle
  // re-enables the button and triggers the watches refetch.
  async "inflight-run-survives-background-render-and-duplicate-click"(controller) {
    controller.setWatches([{ name: "pr-watch", source: "shared", schedule: "*/5 * * * *", enabled: true }])
    controller.ready("/repos/a")
    await controller.flush()
    controller.holdRunNow()
    controller.clickRunNow("pr-watch")
    await controller.flush()
    const afterClick = { disabled: controller.runNowState("pr-watch")?.disabled ?? null, runPosts: controller.posts("/watch/run").length }
    controller.fireSessions()
    await controller.advanceMs(1_000)
    const afterBackgroundRender = {
      disabled: controller.runNowState("pr-watch")?.disabled ?? null,
      runPosts: controller.posts("/watch/run").length,
      boardGets: controller.gets("/board"),
    }
    controller.clickRunNow("pr-watch")
    await controller.flush()
    const afterDuplicateClick = { runPosts: controller.posts("/watch/run").length }
    controller.releaseRunNow({ status: 200, body: JSON.stringify({ lastOutcome: "ok" }) })
    await controller.flush()
    const afterSettle = {
      feedback: controller.feedback("pr-watch"),
      disabled: controller.runNowState("pr-watch")?.disabled ?? null,
      watchesGets: controller.gets("/watches"),
    }
    return { afterClick, afterBackgroundRender, afterDuplicateClick, afterSettle }
  },

  // Settled runs report honest outcomes: a failed script names the failure,
  // a 409 surfaces the service's own error text, a delivery failure says
  // so; the post-run refetch carries the refreshed rows, and the top-level
  // delivery summary yields to a per-row badge.
  async "run-now-honest-outcomes-and-refreshed-watches"(controller) {
    controller.setWatches([{ name: "pr-watch", source: "shared", schedule: "*/5 * * * *", enabled: true }])
    controller.ready("/repos/a")
    await controller.flush()
    controller.holdRunNow()
    controller.clickRunNow("pr-watch")
    controller.setWatches([
      { name: "pr-watch", source: "shared", schedule: "*/5 * * * *", enabled: true, lastRunAt: iso(0), lastOutcome: "failed", lastError: "exit code 3" },
    ])
    controller.releaseRunNow({ status: 200, body: JSON.stringify({ lastOutcome: "failed", lastError: "exit code 3" }) })
    await controller.flush()
    const afterFailed = {
      feedback: controller.feedback("pr-watch"),
      outcome: controller.metaValue("outcome"),
      rootText: controller.rootText(),
    }
    controller.holdRunNow()
    controller.clickRunNow("pr-watch")
    controller.releaseRunNow({ status: 409, body: JSON.stringify({ error: "watch script disappeared" }) })
    await controller.flush()
    const afterConflict = { feedback: controller.feedback("pr-watch") }
    controller.holdRunNow()
    controller.clickRunNow("pr-watch")
    controller.releaseRunNow({ status: 200, body: JSON.stringify({ lastOutcome: "ok", deliveryError: "coordinator session closed" }) })
    await controller.flush()
    const afterDeliveryError = { feedback: controller.feedback("pr-watch") }
    controller.setWatches(
      [{ name: "pr-watch", source: "shared", schedule: "*/5 * * * *", enabled: true, deliveryError: "coordinator unreachable" }],
      "one notification could not be delivered",
    )
    await controller.advanceMs(30_000)
    const withRowBadge = { rootText: controller.rootText() }
    controller.setWatches(
      [{ name: "pr-watch", source: "shared", schedule: "*/5 * * * *", enabled: true }],
      "one notification could not be delivered",
    )
    await controller.advanceMs(30_000)
    const withSummaryOnly = { rootText: controller.rootText() }
    return { afterFailed, afterConflict, afterDeliveryError, withRowBadge, withSummaryOnly }
  },

  // The watches refetch a run triggers is a background fetch: it never
  // resets the manual-refresh age.
  async "run-now-reload-does-not-reset-refresh-age"(controller) {
    controller.setWatches([{ name: "pr-watch", source: "shared", schedule: "*/5 * * * *", enabled: true }])
    controller.ready("/repos/a")
    await controller.flush()
    await controller.advanceMs(120_000)
    const labelBefore = controller.refreshLabel()?.text ?? null
    const watchesGetsBefore = controller.gets("/watches")
    controller.clickRunNow("pr-watch")
    await controller.flush()
    return {
      labelBefore,
      labelAfter: controller.refreshLabel()?.text ?? null,
      watchesGetsBefore,
      watchesGetsAfter: controller.gets("/watches"),
      rootText: controller.rootText(),
    }
  },

  // A directory change — including the optional null field — resets the
  // flow: open drafts close, in-flight run markers clear, and a stale run
  // settle from the previous registration lands nowhere.
  async "directory-reset-clears-module-state"(controller) {
    controller.setWatches([{ name: "pr-watch", source: "shared", schedule: "*/5 * * * *", enabled: true }])
    controller.ready("/repos/a")
    await controller.flush()
    controller.holdRunNow()
    controller.clickRunNow("pr-watch")
    await controller.flush()
    controller.openWatchCreateForm()
    controller.directoryChanged(null)
    await controller.flush()
    const afterNullDirectory = { rootText: controller.rootText() }
    controller.ready("/repos/a")
    await controller.flush()
    const afterReReady = {
      formOpen: controller.watchNameDraft() !== null,
      runDisabled: controller.runNowState("pr-watch")?.disabled ?? null,
      lookupGets: controller.gets("/lookup"),
    }
    controller.releaseRunNow({ status: 200, body: JSON.stringify({ lastOutcome: "ok" }) })
    await controller.flush()
    const afterStaleSettle = { runPosts: controller.posts("/watch/run").length, rootText: controller.rootText() }
    return { afterNullDirectory, afterReReady, afterStaleSettle }
  },
}

export async function runReliabilityScenario(name: string): Promise<ReliabilityObservations> {
  const fake = installFakeEnvironment()
  const requestLog: Array<{ method: string; path: string; body: string | undefined }> = []
  let boardFixture: unknown = { workers: [] }
  let watchesFixture: unknown = { watches: [] }
  // The known fully-valid canonical shipping body: the badge parses and the
  // lists default empty.
  let shippingFixture: unknown = { mode: null, yolo: false, landings: [], landingErrors: [] }
  let suggestionsFixture: unknown = { suggestions: [] }
  let holdRunNowRequests = false
  let releaseRunNow: ((response: RunNowResponse) => void) | null = null
  let onReadyHandler: ((context: { directory: string | null }) => void) | null = null
  let onDirectoryHandler: ((directory: string | null) => void) | null = null
  let sessionsListener: ((snapshot: unknown) => void) | null = null

  const fakeHost = {
    onReady: (callback: (context: { directory: string | null }) => void): (() => void) => {
      onReadyHandler = callback
      return () => {}
    },
    onDirectory: (callback: (directory: string | null) => void): (() => void) => {
      onDirectoryHandler = callback
      return () => {}
    },
    listProjects: async (): Promise<{ projects: Array<{ id: string; directory: string }> }> => ({
      projects: [{ id: "p-a", directory: "/repos/a" }],
    }),
    onSessions: async (projectId: string, listener: (snapshot: unknown) => void): Promise<() => void> => {
      sessionsListener = listener
      return () => {}
    },
    openSession: async (): Promise<void> => {},
    openUrl: async (): Promise<void> => {},
    serviceRequest: async (request: { method: string; path: string; query?: Record<string, string>; body?: string }) => {
      requestLog.push({ method: request.method, path: request.path, body: request.body })
      if (request.method === "GET" && request.path === "/lookup") {
        const found = request.query?.directory === "/repos/a" ? { ...registration } : null
        return { status: 200, body: JSON.stringify({ registration: found }) }
      }
      if (request.method === "GET" && request.path === "/board") return { status: 200, body: JSON.stringify(boardFixture) }
      if (request.method === "GET" && request.path === "/watches") return { status: 200, body: JSON.stringify(watchesFixture) }
      if (request.method === "GET" && request.path === "/shipping") return { status: 200, body: JSON.stringify(shippingFixture) }
      if (request.method === "GET" && request.path === "/suggestions") return { status: 200, body: JSON.stringify(suggestionsFixture) }
      if (request.method === "POST" && request.path === "/watch/run") {
        if (!holdRunNowRequests) return { status: 200, body: "{}" }
        return await new Promise<RunNowResponse>((resolve) => {
          releaseRunNow = resolve
        })
      }
      return { status: 404, body: "" }
    },
  }

  mock.module("@openchamber/sdk", () => ({ connectHost: () => fakeHost }))
  mock.module("@openchamber/sdk/ui", () => ({
    applyHostReady: () => {},
    // Badge labels become the element's text so render assertions can read them.
    mountBadge: (element: { textContent: string | null }, options: { label: string }) => {
      element.textContent = options.label
    },
  }))

  await import(join(import.meta.dir, "..", "..", "panel", "main.ts"))

  const findAll = (node: FakeElement, predicate: (element: FakeElement) => boolean): FakeElement[] => {
    const found: FakeElement[] = []
    if (predicate(node)) found.push(node)
    for (const child of node.children) found.push(...findAll(child, predicate))
    return found
  }

  // The labeled meta pieces the panel builds (supervision rows, watch
  // summary): label child first, value element second.
  const metaPieceFor = (label: string): FakeElement | null => {
    for (const piece of findAll(fake.root, (element) => element.className === "fm-meta")) {
      const labelElement = piece.children.find((child) => child.className === "fm-meta-label")
      if (labelElement !== undefined && labelElement.textContent === label) return piece
    }
    return null
  }

  const runNowButtonFor = (watchName: string): FakeElement | null =>
    findByAriaLabel(fake.root, `Run watch ${watchName} now`)

  const controller: Controller = {
    ready(directory) {
      if (onReadyHandler === null) throw new Error("the panel has not registered onReady")
      onReadyHandler({ directory })
    },
    directoryChanged(directory) {
      if (onDirectoryHandler === null) throw new Error("the panel has not registered onDirectory")
      onDirectoryHandler(directory)
    },
    fireSessions() {
      if (sessionsListener === null) throw new Error("the sessions subscription is not attached")
      sessionsListener({ state: "ready", sessions: [] })
    },
    clickRefresh() {
      const button = fake.querySelector("button.fm-refresh")
      if (button === null) throw new Error("the refresh button is not rendered")
      button.click()
    },
    clickRunNow(watchName) {
      const button = runNowButtonFor(watchName)
      if (button === null) throw new Error(`the Run now button for "${watchName}" is not rendered`)
      button.click()
    },
    flush: () => fake.flushMicrotasks(),
    async advanceMs(ms) {
      fake.advanceClock(ms)
      await fake.flushMicrotasks()
    },
    holdRunNow() {
      holdRunNowRequests = true
    },
    releaseRunNow(response) {
      if (releaseRunNow === null) throw new Error("no run-now request is held")
      holdRunNowRequests = false
      const resolve = releaseRunNow
      releaseRunNow = null
      resolve(response)
    },
    setBoard(board) {
      boardFixture = board
    },
    setWatches(watches, deliveryError) {
      watchesFixture = deliveryError === undefined ? { watches } : { watches, deliveryError }
    },
    setShipping(shipping) {
      shippingFixture = shipping
    },
    setSuggestions(suggestions) {
      suggestionsFixture = suggestions
    },
    gets(path) {
      return requestLog.filter((entry) => entry.method === "GET" && entry.path === path).length
    },
    posts(path) {
      return requestLog.filter((entry) => entry.method === "POST" && entry.path === path).map((entry) => entry.body ?? "")
    },
    metaValue(label) {
      return metaPieceFor(label)?.children[1]?.textContent ?? null
    },
    metaTitle(label) {
      return metaPieceFor(label)?.children[1]?.title ?? ""
    },
    runNowState(watchName) {
      const button = runNowButtonFor(watchName)
      return button === null ? null : { disabled: button.disabled, title: button.title }
    },
    feedback(watchName) {
      const row = runNowButtonFor(watchName)?.parent
      return row?.children.find((child) => child.className === "fm-feedback")?.textContent ?? null
    },
    // Board cards and watch rows are both article.fm-card; child 1 is the
    // state (or source) badge.
    cardBadgeTexts() {
      return findAll(fake.root, (element) => element.className === "fm-card").map((card) => card.children[1]?.textContent ?? null)
    },
    blockedNoteTexts() {
      return findAll(fake.root, (element) => element.className === "fm-blocked-note").map((element) => element.textContent ?? "")
    },
    awaitingCleanupBadges() {
      return findAll(fake.root, (element) => element.textContent === "Awaiting captain cleanup").length
    },
    cleanupButtonCount() {
      return findAll(fake.root, (element) => element.className === "fm-cleanup").reduce(
        (count, block) => count + findAll(block, (element) => element.tagName === "button").length,
        0,
      )
    },
    hasButton(text) {
      return findByText(fake.root, "button", text) !== null
    },
    buttonDisabled(text) {
      return findByText(fake.root, "button", text)?.disabled ?? null
    },
    refreshLabel() {
      const button = fake.querySelector("button.fm-refresh")
      return button === null ? null : { text: button.textContent, disabled: button.disabled }
    },
    openWatchCreateForm() {
      const button = findByText(fake.root, "button", "New watch")
      if (button === null) throw new Error("the New watch button is not rendered")
      button.click()
    },
    watchNameDraft() {
      return findByAriaLabel(fake.root, "Watch name")?.value ?? null
    },
    rootText: () => collectText(fake.root),
  }

  const scenario = scenarios[name]
  if (scenario === undefined) throw new Error(`unknown scenario "${name}"`)
  return { ...(await scenario(controller)) }
}
