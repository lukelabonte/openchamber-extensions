// Runs ONE named refresh scenario against the real panel entry point
// (firstmate/panel/main.ts) and prints the observations as JSON. It is never
// executed directly: tests/panel-refresh.test.ts re-spawns its own file under
// `bun test` with FM_PROBE_SCENARIO set, and that child runs the scenario
// here. The subprocess isolation is what keeps the SDK module mock, the fake
// DOM/window, and the fake clock away from the rest of the suite, and what
// gives every scenario a fresh panel module state.

import { mock } from "bun:test"
import { join } from "node:path"
import { collectText, findByAriaLabel, findByText, installFakeEnvironment } from "./panel-harness"

export type RefreshObservations = {
  label: { text: string | null; disabled: boolean } | null
  counts: Record<string, number>
  rootText: string
  themeApplications: number
  watchNameDraft: string | null
}

export type ScenarioObservations = RefreshObservations & Record<string, unknown>

type DataPath = "board" | "watches" | "shipping" | "suggestions"

const dataPaths: Record<DataPath, string> = {
  board: "/board",
  watches: "/watches",
  shipping: "/shipping",
  suggestions: "/suggestions",
}

const dataBodies: Record<DataPath, string> = {
  board: JSON.stringify({ workers: [] }),
  watches: JSON.stringify({ watches: [] }),
  shipping: JSON.stringify({ mode: null, yolo: false }),
  suggestions: JSON.stringify({ suggestions: [] }),
}

// Canonical scenario keys; the wire route for each is dataPaths[key].
const dataPathKeys = Object.keys(dataPaths) as DataPath[]

const registrationA = {
  slug: "proj-a",
  projectDirectory: "/repos/a",
  homeDirectory: "/home/a",
  coordinatorSessionId: "ses-a",
  createdAt: "2026-01-01T00:00:00.000Z",
}
const registrationB = { ...registrationA, slug: "proj-b", projectDirectory: "/repos/b", homeDirectory: "/home/b", coordinatorSessionId: "ses-b" }
const lookupByDirectory: Record<string, typeof registrationA | null> = {
  "/repos/a": registrationA,
  "/repos/b": registrationB,
}

type HeldRequest = {
  route: string
  slug: string | undefined
  resolve: (result: { status: number; body: string }) => void
  reject: (error: Error) => void
}

type Controller = {
  ready: (directory: string | null) => void
  directoryChanged: (directory: string | null) => void
  holdAll: () => void
  failAllNext: (kind: "reject" | number) => void
  failNext: (path: DataPath, kind: "reject" | number) => void
  clearFailures: () => void
  releaseAll: (options?: { slug?: string; outcome?: "ok" | "fail"; all?: boolean }) => void
  release: (path: DataPath, options?: { slug?: string; outcome?: "ok" | "fail"; all?: boolean }) => void
  fireSessionsReady: () => void
  clickRefresh: () => void
  flush: () => Promise<void>
  advanceMs: (ms: number) => Promise<void>
  calls: (path: string, slug?: string) => number
  counts: () => Record<string, number>
  refreshLabel: () => { text: string | null; disabled: boolean } | null
  rootText: () => string
  themeApplications: () => number
  openWatchCreateForm: () => void
  typeWatchName: (name: string) => void
  watchNameDraft: () => string | null
  observe: () => RefreshObservations
}

const scenarios: Record<string, (controller: Controller) => Promise<Record<string, unknown>>> = {
  // The fixed onReady guard must not swallow the very first ready even when
  // its directory is null: the panel initializes to the no-directory state,
  // and a later genuine ready with a directory starts the flow.
  async "first-ready-null-initializes"(controller) {
    controller.ready(null)
    await controller.flush()
    const afterNullReady = { label: controller.refreshLabel(), lookupCalls: controller.calls("/lookup"), rootText: controller.rootText() }
    controller.ready("/repos/a")
    await controller.flush()
    return { afterNullReady, ...controller.observe() }
  },

  // The initial (deliberate) refresh marks the age; the live subscription
  // refetch (board only) and the periodic cycle must never re-pin it, so the
  // label ages into minutes instead of staying "just now".
  async "label-ages-and-background-fetches-never-repin"(controller) {
    controller.ready("/repos/a")
    await controller.flush()
    const afterInitial = { ...controller.refreshLabel(), ...controller.counts() }
    controller.fireSessionsReady()
    await controller.advanceMs(1_000)
    const afterSubscription = { ...controller.refreshLabel(), ...controller.counts() }
    await controller.advanceMs(29_000)
    const afterFirstTick = { ...controller.refreshLabel(), ...controller.counts() }
    await controller.advanceMs(30_000)
    const afterSixtySeconds = { ...controller.refreshLabel(), ...controller.counts() }
    await controller.advanceMs(90_000)
    return { afterInitial, afterSubscription, afterFirstTick, afterSixtySeconds, ...controller.observe() }
  },

  // Bug: the host replays the ready event with the same directory (it re-posts
  // ready on iframe loads and payload changes). The replay must reapply the
  // theme but keep the board flow: no re-lookup, no refetch, no re-pinned age,
  // and the open watch draft must survive.
  async "same-directory-ready-replay-preserves-flow"(controller) {
    controller.ready("/repos/a")
    await controller.flush()
    await controller.advanceMs(60_000)
    controller.openWatchCreateForm()
    controller.typeWatchName("nightly")
    await controller.advanceMs(30_000)
    const beforeReplay = {
      ...controller.refreshLabel(),
      ...controller.counts(),
      themeApplications: controller.themeApplications(),
      watchNameDraft: controller.watchNameDraft(),
    }
    controller.ready("/repos/a")
    await controller.flush()
    const afterReplay = {
      ...controller.refreshLabel(),
      ...controller.counts(),
      themeApplications: controller.themeApplications(),
      watchNameDraft: controller.watchNameDraft(),
    }
    await controller.advanceMs(30_000)
    return { beforeReplay, afterReplay, boardCallsAfterLaterTick: controller.calls("/board"), ...controller.observe() }
  },

  // Bug: a first cycle whose fetches all fail still marks the age as fresh.
  // The control must read exactly "Refresh failed" (not "Refreshing…" and not
  // a fake age), and a later successful manual refresh must clear the failure.
  async "failed-initial-refresh-shows-refresh-failed"(controller) {
    controller.failAllNext("reject")
    controller.ready("/repos/a")
    await controller.flush()
    const afterFailedInitial = { ...controller.refreshLabel(), rootText: controller.rootText() }
    controller.clearFailures()
    controller.clickRefresh()
    await controller.flush()
    return { afterFailedInitial, ...controller.observe() }
  },

  // Bug: one failing fetch of four (non-200 answer) still marks the age as
  // fresh; a partly failed first cycle must read "Refresh failed" too.
  async "partial-initial-refresh-failure-is-not-fresh"(controller) {
    controller.failNext("watches", 500)
    controller.ready("/repos/a")
    await controller.flush()
    const afterPartialFailure = { ...controller.refreshLabel(), rootText: controller.rootText() }
    controller.clearFailures()
    controller.clickRefresh()
    await controller.flush()
    return { afterPartialFailure, ...controller.observe() }
  },

  // Bug: a failed manual refresh re-pins the age to now. It must keep showing
  // the last successful age AND name the failure (both facts visible in the
  // label), stay retryable, and recover on the next successful press.
  async "failed-manual-refresh-keeps-prior-age-and-shows-failure"(controller) {
    controller.ready("/repos/a")
    await controller.flush()
    await controller.advanceMs(120_000)
    const beforeFailedManual = { ...controller.refreshLabel() }
    controller.failAllNext("reject")
    controller.clickRefresh()
    await controller.flush()
    const afterFailedManual = { ...controller.refreshLabel() }
    controller.clearFailures()
    controller.clickRefresh()
    await controller.flush()
    return { beforeFailedManual, afterFailedManual, ...controller.observe() }
  },

  // While the panel's very first fetch cycle is in flight the control reads
  // "Refreshing…"; success then marks the age.
  async "first-inflight-shows-refreshing"(controller) {
    controller.holdAll()
    controller.ready("/repos/a")
    await controller.flush()
    const whilePending = { ...controller.refreshLabel(), ...controller.counts() }
    controller.releaseAll()
    await controller.flush()
    return { whilePending, ...controller.observe() }
  },

  // A manual press issues each of the four fetches exactly once for the
  // registration, shows "Refreshing…" disabled while in flight, ignores a
  // duplicate press, and recovers the age once the fetches succeed.
  async "manual-refresh-issues-four-requests-once-and-guards-duplicate"(controller) {
    controller.ready("/repos/a")
    await controller.flush()
    const baseline = controller.counts()
    controller.holdAll()
    controller.clickRefresh()
    await controller.flush()
    const whileInFlight = { label: controller.refreshLabel(), counts: controller.counts() }
    controller.clickRefresh()
    await controller.flush()
    const afterDuplicatePress = controller.counts()
    controller.releaseAll()
    await controller.flush()
    return { baseline, whileInFlight, afterDuplicatePress, ...controller.observe() }
  },

  // A genuine directory switch (ready with a new directory, then a
  // directoryChanged event) restarts the flow: re-lookup, a fresh pending
  // refresh for the new registration, and dropped drafts.
  async "directory-switch-resets-flow"(controller) {
    controller.ready("/repos/a")
    await controller.flush()
    controller.openWatchCreateForm()
    controller.typeWatchName("nightly")
    controller.holdAll()
    controller.ready("/repos/b")
    await controller.flush()
    const afterSwitch = { label: controller.refreshLabel(), lookupCalls: controller.calls("/lookup"), watchNameDraft: controller.watchNameDraft() }
    const heldForB = { board: controller.calls("/board", "proj-b"), suggestions: controller.calls("/suggestions", "proj-b") }
    controller.releaseAll({ slug: "proj-b" })
    await controller.flush()
    const afterBSuccess = { ...controller.refreshLabel() }
    controller.directoryChanged("/repos/other")
    await controller.flush()
    return { afterSwitch, heldForB, afterBSuccess, ...controller.observe() }
  },

  // Bug: the old directory's initial refresh settles after the captain
  // switched. Its completion must not mark the new flow's timestamp or failure
  // state — the new flow is still loading and must still read "Refreshing…".
  async "stale-initial-refresh-completion-does-not-pollute-new-flow"(controller) {
    controller.holdAll()
    controller.ready("/repos/a")
    await controller.flush()
    controller.ready("/repos/b")
    await controller.flush()
    const whileBPending = { ...controller.refreshLabel() }
    await controller.advanceMs(120_000)
    controller.releaseAll({ slug: "proj-a", outcome: "fail", all: true })
    await controller.flush()
    const afterStaleFailure = { ...controller.refreshLabel() }
    controller.releaseAll({ slug: "proj-b" })
    await controller.flush()
    const afterBOwnInitialSuccess = { ...controller.refreshLabel() }
    await controller.advanceMs(60_000)
    return { whileBPending, afterStaleFailure, afterBOwnInitialSuccess, ...controller.observe() }
  },

  // Bug: the old directory's manual refresh settles after a switch. Its
  // completion must not re-pin the new flow's age either.
  async "stale-manual-refresh-completion-does-not-pollute-new-flow"(controller) {
    controller.ready("/repos/a")
    await controller.flush()
    controller.holdAll()
    controller.clickRefresh()
    await controller.flush()
    const whileManualPending = { ...controller.refreshLabel() }
    controller.ready("/repos/b")
    await controller.flush()
    const whileBPending = { ...controller.refreshLabel() }
    await controller.advanceMs(60_000)
    controller.releaseAll({ slug: "proj-a", outcome: "fail", all: true })
    await controller.flush()
    const afterStaleFailure = { ...controller.refreshLabel() }
    controller.releaseAll({ slug: "proj-b" })
    await controller.flush()
    const afterBOwnInitialSuccess = { ...controller.refreshLabel() }
    return { whileManualPending, whileBPending, afterStaleFailure, afterBOwnInitialSuccess, ...controller.observe() }
  },
}

export async function runProbeScenario(name: string): Promise<ScenarioObservations> {
  const fake = installFakeEnvironment()
  const serviceCalls: Array<{ method: string; path: string; slug: string | undefined }> = []
  const holdPaths = new Set<string>()
  const failureQueue = new Map<string, Array<"reject" | number>>()
  const heldRequests: HeldRequest[] = []
  let onReadyHandler: ((context: { directory: string | null }) => void) | null = null
  let onDirectoryHandler: ((directory: string | null) => void) | null = null
  let sessionsListener: ((snapshot: unknown) => void) | null = null
  let themeApplicationCount = 0

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
      projects: [
        { id: "p-a", directory: "/repos/a" },
        { id: "p-b", directory: "/repos/b" },
      ],
    }),
    onSessions: async (projectId: string, listener: (snapshot: unknown) => void): Promise<() => void> => {
      sessionsListener = listener
      return () => {}
    },
    openSession: async (): Promise<void> => {},
    openUrl: async (): Promise<void> => {},
    serviceRequest: async (request: { method: string; path: string; query?: Record<string, string> }) => {
      serviceCalls.push({ method: request.method, path: request.path, slug: request.query?.slug })
      if (request.method === "GET" && request.path === "/lookup") {
        const registration = lookupByDirectory[request.query?.directory ?? ""] ?? null
        return { status: 200, body: JSON.stringify({ registration }) }
      }
      // The scenario key (DataPath) drives bodies and release bookkeeping; the
      // wire route string is kept separately for holds, held-request matching,
      // and the failure queue.
      const key = dataPathKeys.find((candidate) => dataPaths[candidate] === request.path) ?? null
      if (request.method !== "GET" || key === null) return { status: 404, body: "" }
      const route = dataPaths[key]!
      if (holdPaths.has(route)) {
        return new Promise<{ status: number; body: string }>((resolve, reject) => {
          heldRequests.push({ route, slug: request.query?.slug, resolve, reject })
        })
      }
      const failure = (failureQueue.get(route) ?? []).shift()
      if (failure === "reject") throw new Error("simulated service failure")
      if (typeof failure === "number") return { status: failure, body: "" }
      return { status: 200, body: dataBodies[key] }
    },
  }

  mock.module("@openchamber/sdk", () => ({ connectHost: () => fakeHost }))
  mock.module("@openchamber/sdk/ui", () => ({
    applyHostReady: () => {
      themeApplicationCount += 1
    },
    mountBadge: () => {},
  }))

  await import(join(import.meta.dir, "..", "..", "panel", "main.ts"))

  const controller: Controller = {
    ready(directory) {
      if (onReadyHandler === null) throw new Error("the panel has not registered onReady")
      onReadyHandler({ directory })
    },
    directoryChanged(directory) {
      if (onDirectoryHandler === null) throw new Error("the panel has not registered onDirectory")
      onDirectoryHandler(directory)
    },
    holdAll() {
      for (const key of dataPathKeys) holdPaths.add(dataPaths[key]!)
    },
    failAllNext(kind) {
      for (const key of dataPathKeys) controller.failNext(key, kind)
    },
    failNext(path, kind) {
      const route = dataPaths[path]!
      const queue = failureQueue.get(route) ?? []
      queue.push(kind)
      failureQueue.set(route, queue)
    },
    clearFailures() {
      failureQueue.clear()
    },
    releaseAll(options) {
      for (const key of dataPathKeys) controller.release(key, options)
    },
    release(path, options = {}) {
      const route = dataPaths[path]!
      const matching = heldRequests.filter(
        (entry) => entry.route === route && (options.slug === undefined || entry.slug === options.slug),
      )
      if (matching.length === 0) throw new Error(`no held request for ${route}`)
      const targets = options.all === true ? matching : [matching[0]!]
      for (const entry of targets) {
        heldRequests.splice(heldRequests.indexOf(entry), 1)
        if (options.outcome === "fail") entry.reject(new Error("simulated service failure"))
        else entry.resolve({ status: 200, body: dataBodies[path] })
      }
    },
    fireSessionsReady() {
      if (sessionsListener === null) throw new Error("the sessions subscription is not attached")
      sessionsListener({ kind: "sessions", projectId: "p-a", state: "ready", coverage: [], sessions: [] })
    },
    clickRefresh() {
      const button = fake.querySelector("button.fm-refresh")
      if (button === null) throw new Error("the refresh button is not rendered")
      button.click()
    },
    flush: () => fake.flushMicrotasks(),
    async advanceMs(ms) {
      fake.advanceClock(ms)
      await fake.flushMicrotasks()
    },
    calls(path, slug) {
      return serviceCalls.filter((call) => call.path === path && (slug === undefined || call.slug === slug)).length
    },
    counts() {
      return {
        lookup: controller.calls("/lookup"),
        board: controller.calls("/board"),
        watches: controller.calls("/watches"),
        shipping: controller.calls("/shipping"),
        suggestions: controller.calls("/suggestions"),
      }
    },
    refreshLabel() {
      const button = fake.querySelector("button.fm-refresh")
      return button === null ? null : { text: button.textContent, disabled: button.disabled }
    },
    rootText: () => collectText(fake.root),
    themeApplications: () => themeApplicationCount,
    openWatchCreateForm() {
      const button = findByText(fake.root, "button", "New watch")
      if (button === null) throw new Error("the New watch button is not rendered")
      button.click()
    },
    typeWatchName(name) {
      const input = findByAriaLabel(fake.root, "Watch name")
      if (input === null) throw new Error("the watch create form is not open")
      input.value = name
      input.emitInput()
    },
    watchNameDraft() {
      const input = findByAriaLabel(fake.root, "Watch name")
      return input === null ? null : input.value
    },
    observe() {
      return {
        label: controller.refreshLabel(),
        counts: controller.counts(),
        rootText: controller.rootText(),
        themeApplications: themeApplicationCount,
        watchNameDraft: controller.watchNameDraft(),
      }
    },
  }

  const scenario = scenarios[name]
  if (scenario === undefined) throw new Error(`unknown scenario "${name}"`)
  const extra = await scenario(controller)
  return { ...controller.observe(), ...extra }
}
