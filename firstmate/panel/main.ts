import { connectHost } from "@openchamber/sdk"
import { applyHostReady, mountBadge, type Tone } from "@openchamber/sdk/ui"
import { parseBoardWorkers, parseSupervision, type BoardCard, type BoardColumn, type SupervisionHealth } from "./board"
import { moveColumn, parseColumnOrder } from "./column-order"
import { workerMessageLink } from "../service/message-links"
import { createWorkerShells } from "./worker-shells"
import { parseShipping, shippingBadgeLabel, type LandingRow, type ShippingInfo } from "./shipping"
import { parseSuggestions, type SuggestionRow } from "./suggestions"
import { initialPanelState, reducePanelState, type Board, type PanelEvent, type PanelState, type RegistrationInfo } from "./state"
import { formatLastRun, formatSchedule, nextRunLabel, nextRunTitle, parseWatches, watchOutcomeLabel, type WatchRow } from "./watches"

const host = connectHost()

const boardFetchDebounceMs = 1_000
const defaultBoardRefreshIntervalMs = 30_000
let boardRefreshIntervalMs = defaultBoardRefreshIntervalMs

let state: PanelState = initialPanelState()
let currentDirectory: string | null = null
let launchDirectory: string | null = null
let hasReceivedReady = false
let activeRegistration: RegistrationInfo | null = null
let unsubscribeSessions: (() => void) | null = null
let sessionsAttachInFlight: RegistrationInfo | null = null
let boardRefreshTimer: number | null = null
let boardFetchTimer: number | null = null
let refreshLabelTimer: number | null = null
let manualRefreshInFlight = false
let lastRefreshedAt: number | null = null
let refreshFailed = false
let boardRequestGeneration = 0
let contextGeneration = 0
let currentSessionId: string | null = null
const workerShells = createWorkerShells(host)

interface ProjectSettings {
  coordinatorModel: string
  coordinatorVariant: string
  workerModel: string
  workerVariant: string
  refreshSeconds: number
}
type SettingsDraft = Omit<ProjectSettings, "refreshSeconds"> & { refreshSeconds: string; dirty: boolean; pending: boolean; feedback?: string }
type UpgradeName = "charter" | "pr-watch"
type Upgrade = { name: UpgradeName; edited: boolean; outdated: boolean }
type UpgradeComparison = { pending: boolean; contents?: string; feedback?: string }
type WatchNotes = { notes: Array<{ id: string; createdAt: string; notification: { message: string; watchName?: string } }>; pendingCount: number; dropped: number }
type MessageDraft = { text: string; pending: boolean; feedback?: string }

const optionalCapabilities = new Set<string>()
const optionalErrors = new Map<string, string>()
const optionalRequests = new Map<string, number>()
let settingsRevision = 0
let settingsDraft: SettingsDraft | undefined
let upgrades: Upgrade[] | undefined
let watchNotes: WatchNotes | undefined
const upgradeComparisons = new Map<UpgradeName, UpgradeComparison>()
const messageDrafts = new Map<string, MessageDraft>()
const endConfirmations = new Set<string>()
const expandedDetails = new Set<string>()
let lifecycleConfirmation: "release" | "restart" | null = null
let lifecyclePending = false
let lifecycleFeedback: string | undefined
let adoptSessionId = ""
// Panel-local captain sends share one synchronous gate. Worker controls and
// automation are independent; other frames still need service-side dedupe.
let captainSendInFlight: RegistrationInfo | null = null
let commandFeedback: string | undefined

host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement)
  // Older host mocks omit session; omission must not erase a later session push.
  if (ctx.session !== undefined) setSessionContext(ctx.session?.id ?? null)
  // The host replays ready with an unchanged directory (iframe loads,
  // payload changes): the theme above reapplies every time, but the flow
  // only starts on the first ready — even a null-directory one, which a
  // naive equality guard would swallow — or on a genuine directory change.
  if (hasReceivedReady && ctx.directory === currentDirectory) return
  hasReceivedReady = true
  resetTo(ctx.directory)
})

// Replays the ready directory right after onReady; the equality guard makes
// that replay a no-op and a real directory change re-run the lookup flow.
host.onDirectory((directory) => {
  if (directory === currentDirectory) return
  resetTo(directory)
})

if (typeof host.onSession === "function") {
  host.onSession((session) => setSessionContext(session?.id ?? null))
}

function setSessionContext(sessionId: string | null): void {
  if (sessionId === currentSessionId) return
  currentSessionId = sessionId
  render(state)
}

function resetTo(directory: string | null): void {
  contextGeneration += 1
  stopBoardFlow()
  currentDirectory = directory
  launchDirectory = directory
  state = initialPanelState()
  dispatch({ type: "directory-context", directory })
  if (directory !== null) {
    void lookup(directory)
  }
}

async function lookup(directory: string): Promise<void> {
  const generation = contextGeneration
  try {
    const result = await host.serviceRequest({ method: "GET", path: "/lookup", query: { directory } })
    // The captain may have switched projects while the lookup was in flight;
    // a stale answer must not start a board flow for the wrong directory.
    if (currentDirectory !== directory || contextGeneration !== generation) return
    if (result.status !== 200) {
      dispatch({ type: "lookup-failed", message: `Looking up the first mate failed (status ${result.status}).` })
      return
    }
    let body: { registration: RegistrationInfo | null }
    try {
      body = JSON.parse(result.body) as { registration: RegistrationInfo | null }
    } catch {
      dispatch({ type: "lookup-failed", message: "Looking up the first mate failed: the service sent a malformed answer." })
      return
    }
    dispatch({ type: "lookup-succeeded", registration: body.registration ?? null })
    if (state.kind === "registered") startBoardFlow(state.registration)
  } catch {
    if (currentDirectory !== directory || contextGeneration !== generation) return
    dispatch({ type: "lookup-failed", message: "Looking up the first mate failed: the service is unreachable." })
  }
}

async function launch(projectDirectory: string): Promise<void> {
  const generation = contextGeneration
  dispatch({ type: "launch-started" })
  try {
    const result = await host.serviceRequest({
      method: "POST",
      path: "/launch",
      body: JSON.stringify({ projectDirectory }),
    })
    if (launchDirectory !== projectDirectory || contextGeneration !== generation) return
    let body: { error?: string; code?: string } = {}
    try {
      body = JSON.parse(result.body) as { error?: string; code?: string }
    } catch {
      // A non-JSON body only matters for the error paths handled below.
    }
    if (body.code === "cli-missing") {
      dispatch({ type: "launch-failed", cliMissing: true, message: body.error ?? "the openchamber CLI is required" })
      return
    }
    if (result.status !== 200) {
      dispatch({ type: "launch-failed", cliMissing: false, message: body.error ?? "Launching the first mate failed." })
      return
    }
    dispatch({ type: "launch-succeeded", registration: JSON.parse(result.body) as RegistrationInfo })
    if (state.kind === "registered") startBoardFlow(state.registration)
  } catch {
    if (launchDirectory !== projectDirectory || contextGeneration !== generation) return
    dispatch({ type: "launch-failed", cliMissing: false, message: "Launching the first mate failed." })
  }
}

// Board data flow: one fetch on mount, a debounced fetch whenever the live
// session subscription fires, and a slow interval as a safety net. The
// service's own poller is the authority; the panel never execs anything.
function startBoardFlow(registration: RegistrationInfo): void {
  if (
    activeRegistration?.slug === registration.slug &&
    activeRegistration?.coordinatorSessionId === registration.coordinatorSessionId
  ) {
    return
  }
  stopBoardFlow()
  activeRegistration = registration
  workerShells.setContext(registration.slug)
  void runFullRefresh(true)
  void ensureSessionsSubscription(registration)
  scheduleBoardRefresh(registration)
  // Keeps the header's relative freshness label current between ticks.
  refreshLabelTimer = window.setInterval(updateRefreshControl, defaultBoardRefreshIntervalMs)
}

function scheduleBoardRefresh(registration: RegistrationInfo): void {
  if (boardRefreshTimer !== null) window.clearInterval(boardRefreshTimer)
  boardRefreshTimer = window.setInterval(() => {
    if (activeRegistration !== registration) return
    void runFullRefresh(false)
    void ensureSessionsSubscription(registration)
  }, boardRefreshIntervalMs)
}

function applySettings(settings: ProjectSettings, registration: RegistrationInfo): void {
  if (settingsDraft === undefined || !settingsDraft.dirty) {
    settingsDraft = { ...settings, refreshSeconds: String(settings.refreshSeconds), dirty: false, pending: false }
  }
  const interval = settings.refreshSeconds * 1_000
  if (boardRefreshIntervalMs !== interval) {
    boardRefreshIntervalMs = interval
    scheduleBoardRefresh(registration)
  }
}

function stopBoardFlow(): void {
  workerShells.reset()
  activeRegistration = null
  unsubscribeSessions?.()
  unsubscribeSessions = null
  sessionsAttachInFlight = null
  if (boardRefreshTimer !== null) window.clearInterval(boardRefreshTimer)
  boardRefreshTimer = null
  if (boardFetchTimer !== null) window.clearTimeout(boardFetchTimer)
  boardFetchTimer = null
  if (refreshLabelTimer !== null) window.clearInterval(refreshLabelTimer)
  refreshLabelTimer = null
  manualRefreshInFlight = false
  lastRefreshedAt = null
  refreshFailed = false
  boardRefreshIntervalMs = defaultBoardRefreshIntervalMs
  optionalCapabilities.clear()
  optionalErrors.clear()
  optionalRequests.clear()
  settingsRevision = 0
  settingsDraft = undefined
  upgrades = undefined
  watchNotes = undefined
  upgradeComparisons.clear()
  messageDrafts.clear()
  endConfirmations.clear()
  expandedDetails.clear()
  lifecycleConfirmation = null
  lifecyclePending = false
  lifecycleFeedback = undefined
  adoptSessionId = ""
  captainSendInFlight = null
  commandFeedback = undefined
  suggestionActionInFlight = false
  // A directory change (or re-registration) closes any open watch editor or
  // creation form; its drafts belonged to the previous project. Run-now
  // in-flight markers and per-watch feedback belong to it too.
  watchFormState = { kind: "closed" }
  watchRunsInFlight.clear()
  watchRunMessages.clear()
}

// Attaches the live onSessions subscription for the registration's project.
// Transient failures (a listProjects rejection, a not-yet-ready snapshot)
// leave the panel unattached and are retried on the next refresh tick. A
// directory that is not an OpenChamber project has no session activity to
// mirror and stays a quiet no-op.
async function ensureSessionsSubscription(registration: RegistrationInfo): Promise<void> {
  if (unsubscribeSessions !== null || sessionsAttachInFlight === registration || activeRegistration !== registration) return
  sessionsAttachInFlight = registration
  try {
    const projects = await host.listProjects()
    if (activeRegistration !== registration) return
    // A session opened in the first mate's home (e.g. the coordinator's own
    // session) resolves through the registration but has no matching
    // currentDirectory; the project's directory is the subscription target.
    const project =
      projects.projects.find((candidate) => candidate.directory === currentDirectory) ??
      projects.projects.find((candidate) => candidate.directory === registration.projectDirectory)
    if (project === undefined) return
    const unsubscribe = await host.onSessions(project.id, (snapshot) => {
      if (activeRegistration !== registration) return
      if (snapshot.state !== "ready") return
      const coordinator = snapshot.sessions.find((session) => session.id === registration.coordinatorSessionId)
      dispatch({ type: "sessions-changed", coordinatorTitle: coordinator?.title })
      scheduleBoardFetch()
    })
    // The directory (or registration) may have changed while subscribing.
    if (activeRegistration !== registration) {
      unsubscribe()
      return
    }
    unsubscribeSessions = unsubscribe
  } catch {
    // Retried on the next refresh tick while unattached.
  } finally {
    if (sessionsAttachInFlight === registration) sessionsAttachInFlight = null
  }
}

function scheduleBoardFetch(): void {
  if (boardFetchTimer !== null) window.clearTimeout(boardFetchTimer)
  boardFetchTimer = window.setTimeout(() => {
    boardFetchTimer = null
    void fetchBoard()
  }, boardFetchDebounceMs)
}

// The periodic cycle runs the same four fetches as the manual refresh. Only
// the initial mount and the manual click (the deliberate cycles) settle the
// control: they mark freshness only when all four fetches succeeded — the
// shipping badge's quiet "no badge this round" counts as a failure too — and
// any failed deliberate cycle shows the explicit failure state. The periodic
// cycle and the subscription-driven refetches never reset the timestamp or
// the failure state, so the label can age instead of being pinned at "just
// now".
async function runFullRefresh(markRefreshed: boolean): Promise<void> {
  const registration = activeRegistration
  if (registration === null) return
  // Version-skewed services may omit all three extras. They never decide the
  // core board's freshness or keep a manual refresh waiting for an extension.
  void fetchExtensions(registration)
  const boardRequest = fetchBoard()
  const generation = boardRequestGeneration
  const outcomes = await Promise.all([boardRequest, fetchWatches(), fetchShipping(), fetchSuggestions()])
  // The captain may have switched projects while the cycle ran; a
  // superseded cycle's completion must not mark the new flow's age or
  // failure state.
  if (activeRegistration !== registration || boardRequestGeneration !== generation) return
  if (!markRefreshed) return
  if (outcomes.every((succeeded) => succeeded)) {
    refreshFailed = false
    lastRefreshedAt = Date.now()
  } else {
    refreshFailed = true
  }
  updateRefreshControl()
}

// A manual press marks the control ("Refreshing…" + disabled) for the run's
// duration and then reports the outcome: a fresh age on success, the last
// good age plus the failure otherwise. A stale completion (the directory
// switched mid-run) leaves the control alone — the new flow owns it now.
async function manualRefresh(): Promise<void> {
  const registration = activeRegistration
  manualRefreshInFlight = true
  updateRefreshControl()
  try {
    await runFullRefresh(true)
  } finally {
    if (activeRegistration === registration) {
      manualRefreshInFlight = false
      updateRefreshControl()
    }
  }
}

function refreshButton(): HTMLElement {
  const button = document.createElement("button")
  button.className = "fm-button fm-refresh"
  button.title =
    "The age shows the last successful initial or manual refresh; automatic background refreshes do not reset it, so it can be older than the most recent background fetch."
  button.addEventListener("click", () => {
    if (manualRefreshInFlight || activeRegistration === null) return
    void manualRefresh()
  })
  applyRefreshLabel(button)
  return button
}

// The rendered button is found fresh on every update: each dispatch rebuilds
// the DOM, so a cached element reference would go stale.
function updateRefreshControl(): void {
  const button = document.querySelector<HTMLButtonElement>("button.fm-refresh")
  if (button !== null) applyRefreshLabel(button)
}

function applyRefreshLabel(button: HTMLButtonElement): void {
  button.disabled = manualRefreshInFlight || activeRegistration === null
  if (manualRefreshInFlight) {
    button.textContent = "Refreshing…"
    return
  }
  // A failed deliberate cycle (initial or manual) must never read as fresh:
  // without a prior successful age the failure is all there is to say, with
  // one the last good age stays visible beside the failure.
  if (refreshFailed || (state.kind === "registered" && (state.board.kind === "error" || (state.board.kind === "ready" && state.board.refreshError !== undefined)))) {
    button.textContent = lastRefreshedAt === null
      ? "Refresh failed"
      : `Refresh failed (${refreshAgeLabel(lastRefreshedAt)})`
    return
  }
  // A superseded initial cycle cannot establish an age. Once its replacement
  // has loaded the board, don't leave the control claiming an ongoing read.
  button.textContent = lastRefreshedAt === null
    ? state.kind === "registered" && state.board.kind === "ready" ? "Not refreshed yet" : "Refreshing…"
    : refreshAgeLabel(lastRefreshedAt)
}

function refreshAgeLabel(timestamp: number): string {
  const elapsed = Date.now() - timestamp
  if (elapsed < 60_000) return "Refreshed just now"
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 60) return `Refreshed ${minutes}m ago`
  return `Refreshed ${Math.floor(minutes / 60)}h ago`
}

async function fetchBoard(): Promise<boolean> {
  const registration = activeRegistration
  if (registration === null) return false
  const generation = ++boardRequestGeneration
  try {
    const result = await host.serviceRequest({ method: "GET", path: "/board", query: { slug: registration.slug } })
    if (activeRegistration !== registration || boardRequestGeneration !== generation) return false
    if (result.status !== 200) {
      dispatch({ type: "board-failed", message: `Reading the board failed (status ${result.status}).` })
      return false
    }
    let body: { workers?: unknown; deliveryError?: string; supervision?: unknown }
    try {
      body = JSON.parse(result.body) as { workers?: unknown; deliveryError?: string; supervision?: unknown }
    } catch {
      dispatch({ type: "board-failed", message: "Reading the board failed: the service sent a malformed answer." })
      return false
    }
    // Per-worker shape guard: malformed entries are skipped and counted here,
    // so the reducer never throws on a lying payload.
    const parsed = parseBoardWorkers(body.workers)
    dispatch({
      type: "board-loaded",
      workers: parsed.workers,
      malformedCount: parsed.malformedCount,
      deliveryError: body.deliveryError,
      supervision: parseSupervision(body.supervision),
    })
    return true
  } catch {
    if (activeRegistration !== registration || boardRequestGeneration !== generation) return false
    dispatch({ type: "board-failed", message: "Reading the board failed: the service is unreachable." })
    return false
  }
}

// Watches ride the same cadence as the board: one fetch on mount and one per
// refresh interval. The service is the authority; a toggle is only sent to
// it, and the refetch carries the authoritative switch state back.
async function fetchWatches(): Promise<boolean> {
  const registration = activeRegistration
  if (registration === null) return false
  try {
    const result = await host.serviceRequest({ method: "GET", path: "/watches", query: { slug: registration.slug } })
    if (activeRegistration !== registration) return false
    if (result.status !== 200) {
      dispatch({ type: "watches-failed", message: `Reading the watches failed (status ${result.status}).` })
      return false
    }
    let body: { watches?: unknown; deliveryError?: string }
    try {
      body = JSON.parse(result.body) as { watches?: unknown; deliveryError?: string }
    } catch {
      dispatch({ type: "watches-failed", message: "Reading the watches failed: the service sent a malformed answer." })
      return false
    }
    dispatch({ type: "watches-loaded", watches: parseWatches(body.watches), deliveryError: body.deliveryError })
    return true
  } catch {
    if (activeRegistration !== registration) return false
    dispatch({ type: "watches-failed", message: "Reading the watches failed: the service is unreachable." })
    return false
  }
}

// The shipping mode rides the same cadence as the board and the watches: one
// fetch on mount and one per refresh interval. A failed or malformed answer
// means no badge this round and reports failure to the refresh aggregate —
// a quietly absent badge must never read as a successful refresh; the next
// tick retries.
async function fetchShipping(): Promise<boolean> {
  const registration = activeRegistration
  if (registration === null) return false
  try {
    const result = await host.serviceRequest({ method: "GET", path: "/shipping", query: { slug: registration.slug } })
    if (activeRegistration !== registration) return false
    if (result.status !== 200) return false
    let body: unknown
    try {
      body = JSON.parse(result.body)
    } catch {
      return false
    }
    const shipping = parseShipping(body)
    if (shipping === undefined) return false
    dispatch({ type: "shipping-loaded", shipping })
    return true
  } catch {
    // Retried on the next refresh tick; reported as a failed fetch above.
    return false
  }
}

// Suggestions ride the same cadence as the board, the watches, and the
// shipping badge: one fetch on mount and one per refresh interval. The
// service is the authority on suggestions.md; a send or dismiss is only sent
// to it, and the refetch carries the file's new state back.
async function fetchSuggestions(): Promise<boolean> {
  const registration = activeRegistration
  if (registration === null) return false
  try {
    const result = await host.serviceRequest({ method: "GET", path: "/suggestions", query: { slug: registration.slug } })
    if (activeRegistration !== registration) return false
    if (result.status !== 200) {
      dispatch({ type: "suggestions-failed", message: `Reading the suggestions failed (status ${result.status}).` })
      return false
    }
    let body: { suggestions?: unknown }
    try {
      body = JSON.parse(result.body) as { suggestions?: unknown }
    } catch {
      dispatch({ type: "suggestions-failed", message: "Reading the suggestions failed: the service sent a malformed answer." })
      return false
    }
    dispatch({ type: "suggestions-loaded", suggestions: parseSuggestions(body.suggestions) })
    return true
  } catch {
    if (activeRegistration !== registration) return false
    dispatch({ type: "suggestions-failed", message: "Reading the suggestions failed: the service is unreachable." })
    return false
  }
}

function record(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("The service sent a malformed answer.")
  return value as Record<string, unknown>
}

function parseSettings(value: unknown): ProjectSettings {
  const settings = record(value)
  for (const name of ["coordinatorModel", "coordinatorVariant", "workerModel", "workerVariant"]) {
    if (typeof settings[name] !== "string") throw new Error("The service sent malformed settings.")
  }
  if (!Number.isInteger(settings.refreshSeconds) || Number(settings.refreshSeconds) < 5 || Number(settings.refreshSeconds) > 3600) {
    throw new Error("Refresh seconds must be an integer from 5 to 3600.")
  }
  return settings as unknown as ProjectSettings
}

// Capability detection is per registration. An unknown endpoint is quiet;
// once it answers, later failures are visible beside its last good data.
async function readOptional(path: string, label: string, registration: RegistrationInfo, apply: (body: Record<string, unknown>) => void): Promise<void> {
  const requestId = (optionalRequests.get(path) ?? 0) + 1
  optionalRequests.set(path, requestId)
  const isCurrent = () => activeRegistration === registration && optionalRequests.get(path) === requestId
  try {
    const result = await host.serviceRequest({ method: "GET", path, query: { slug: registration.slug } })
    if (!isCurrent()) return
    if (result.status !== 200) {
      if (!optionalCapabilities.has(path)) return
      throw new Error(`status ${result.status}`)
    }
    optionalCapabilities.add(path)
    apply(record(JSON.parse(result.body)))
    optionalErrors.delete(path)
  } catch (error) {
    if (!isCurrent() || !optionalCapabilities.has(path)) return
    optionalErrors.set(path, `Reading the ${label} failed: ${error instanceof Error ? error.message : "the service is unreachable."}`)
  }
  if (isCurrent()) render(state)
}

async function fetchExtensions(registration: RegistrationInfo): Promise<void> {
  const revision = settingsRevision
  await Promise.all([
    readOptional("/settings", "settings", registration, (body) => {
      if (settingsRevision === revision) applySettings(parseSettings(body.settings), registration)
    }),
    readOptional("/upgrades", "upgrades", registration, (body) => {
      if (!Array.isArray(body.upgrades)) throw new Error("The service sent malformed upgrades.")
      upgrades = body.upgrades.map((value) => {
        const upgrade = record(value)
        if ((upgrade.name !== "charter" && upgrade.name !== "pr-watch") || typeof upgrade.edited !== "boolean" || typeof upgrade.outdated !== "boolean") {
          throw new Error("The service sent malformed upgrades.")
        }
        return { name: upgrade.name, edited: upgrade.edited, outdated: upgrade.outdated }
      })
    }),
    readOptional("/watchnotes", "watch notes", registration, (body) => {
      if (!Array.isArray(body.notes) || !Number.isInteger(body.pendingCount) || Number(body.pendingCount) < 0 || !Number.isInteger(body.dropped) || Number(body.dropped) < 0) {
        throw new Error("The service sent malformed watch notes.")
      }
      const notes = body.notes.slice(-50).map((value) => {
        const note = record(value)
        const notification = record(note.notification)
        if (typeof note.id !== "string" || typeof note.createdAt !== "string" || typeof notification.message !== "string" || (notification.watchName !== undefined && typeof notification.watchName !== "string")) {
          throw new Error("The service sent malformed watch notes.")
        }
        return { id: note.id, createdAt: note.createdAt, notification: { message: notification.message, ...(typeof notification.watchName === "string" ? { watchName: notification.watchName } : {}) } }
      })
      watchNotes = { notes, pendingCount: Number(body.pendingCount), dropped: Number(body.dropped) }
    }),
  ])
}

async function post(path: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const result = await host.serviceRequest({ method: "POST", path, body: JSON.stringify(body) })
  let answer: Record<string, unknown> = {}
  try { answer = record(JSON.parse(result.body)) } catch { /* Empty successes need no answer. */ }
  if (result.status !== 200) throw new Error(typeof answer.error === "string" ? answer.error : `The action failed (status ${result.status}).`)
  return answer
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "The service is unreachable."
}

function button(label: string, action: () => void, disabled = false): HTMLButtonElement {
  const element = document.createElement("button")
  element.className = "fm-button"
  element.textContent = label
  element.disabled = disabled
  element.addEventListener("click", () => { if (!element.disabled) action() })
  return element
}

function labeledInput(label: string, value: string, change: (value: string) => void, disabled = false, placeholder = ""): HTMLElement {
  const field = document.createElement("label")
  field.className = "fm-field"
  const input = document.createElement("input")
  input.type = "text"
  input.value = value
  input.placeholder = placeholder
  input.disabled = disabled
  input.setAttribute("aria-label", label)
  input.addEventListener("input", () => change(input.value))
  field.append(document.createTextNode(label), input)
  return field
}

function expandableText(id: string, label: string, contents: string, className: string): HTMLDetailsElement {
  const registration = activeRegistration
  const details = document.createElement("details")
  details.className = className
  details.open = expandedDetails.has(id)
  details.addEventListener("toggle", () => {
    if (activeRegistration !== registration) return
    if (details.open) expandedDetails.add(id)
    else expandedDetails.delete(id)
  })
  const summary = document.createElement("summary")
  summary.textContent = label
  const body = document.createElement("pre")
  body.className = "fm-expanded-text"
  body.textContent = contents
  details.append(summary, body)
  return details
}

function settingsSection(): HTMLElement {
  const section = document.createElement("section")
  section.append(collapsibleHeading("settings", "Settings"))
  if (collapsedSections.has("settings")) return section
  const error = optionalErrors.get("/settings")
  if (error !== undefined) section.append(warningCallout(error))
  const draft = settingsDraft
  if (draft !== undefined) {
    section.append(mutedNote("Use full provider/model IDs (for example openai/gpt-example) and the provider's exact reasoning/variant IDs, not a fixed list of effort levels. Blank coordinator fields use OpenChamber defaults and apply to new first mate sessions. Blank worker fields require the first mate to choose an explicit model and effort variant before creating or resuming a worker. Set worker fields stay fixed unless the captain explicitly changes them. Refresh defaults to 30 seconds."))
    const fields = [
      ["Coordinator model", "coordinatorModel"], ["Coordinator variant", "coordinatorVariant"],
      ["Worker model", "workerModel"], ["Worker variant", "workerVariant"], ["Refresh seconds", "refreshSeconds"],
    ] as const
    const form = document.createElement("div")
    form.className = "fm-watch-editor"
    for (const [label, name] of fields) {
      const placeholder = name === "workerVariant" ? "Leave it to the first mate" : name === "coordinatorVariant" ? "OpenChamber default" : ""
      form.append(labeledInput(label, draft[name], (value) => { draft[name] = value; draft.dirty = true }, draft.pending, placeholder))
    }
    form.append(button("Save settings", () => { void saveSettings(draft) }, draft.pending))
    if (draft.feedback !== undefined) form.append(mutedNote(draft.feedback))
    section.append(form)
  } else {
    section.append(mutedNote("Project settings are unavailable until the service supports them. The board refreshes every 30 seconds by default."))
  }
  section.append(labeledInput("Session to adopt", adoptSessionId, (value) => { adoptSessionId = value }, lifecyclePending))
  section.append(mutedNote("Adopt an existing session in this project's FirstMate home. The server verifies its placement and idle state; unrelated chats are never adopted automatically."))
  section.append(button("Adopt session", () => { void coordinatorAction("adopt", adoptSessionId.trim()) }, lifecyclePending))
  return section
}

async function saveSettings(draft: SettingsDraft): Promise<void> {
  const registration = activeRegistration
  if (registration === null || draft.pending || settingsDraft !== draft) return
  const refreshSeconds = Number(draft.refreshSeconds)
  if (draft.refreshSeconds.trim() === "" || !Number.isInteger(refreshSeconds) || refreshSeconds < 5 || refreshSeconds > 3600) {
    draft.feedback = "Refresh seconds must be an integer from 5 to 3600."
    render(state)
    return
  }
  const settings = {
    coordinatorModel: draft.coordinatorModel.trim(), coordinatorVariant: draft.coordinatorVariant.trim(),
    workerModel: draft.workerModel.trim(), workerVariant: draft.workerVariant.trim(), refreshSeconds,
  }
  draft.pending = true
  draft.dirty = true
  draft.feedback = undefined
  settingsRevision += 1
  render(state)
  try {
    const answer = await post("/settings", { slug: registration.slug, settings })
    if (activeRegistration !== registration || settingsDraft !== draft) return
    const saved = parseSettings(answer.settings)
    draft.dirty = false
    applySettings(saved, registration)
    settingsDraft!.feedback = "Settings saved."
    optionalCapabilities.add("/settings")
    optionalErrors.delete("/settings")
  } catch (error) {
    if (activeRegistration !== registration || settingsDraft !== draft) return
    draft.feedback = errorMessage(error)
  } finally {
    if (activeRegistration === registration) {
      settingsRevision += 1
      draft.pending = false
      render(state)
    }
  }
}

function lifecycleControls(): HTMLElement {
  const controls = document.createElement("div")
  controls.className = "fm-actions"
  for (const action of ["restart", "release"] as const) {
    const label = action === "restart" ? "Restart in fresh session" : "Release first mate"
    const confirmedLabel = action === "restart" ? "Confirm restart in fresh session" : "Confirm release"
    controls.append(button(lifecycleConfirmation === action ? confirmedLabel : label, () => {
      if (lifecyclePending) return
      if (lifecycleConfirmation !== action) { lifecycleConfirmation = action; render(state); return }
      void coordinatorAction(action)
    }, lifecyclePending))
  }
  if (lifecycleConfirmation !== null) {
    controls.append(button("Cancel", () => { lifecycleConfirmation = null; render(state) }, lifecyclePending))
    controls.append(mutedNote(lifecycleConfirmation === "restart"
      ? "Restart creates a fresh session: the old chat is preserved; backlog and workers continue. Context reset and same-thread restart are unavailable."
      : "Release removes the registration only: the session and worktree are preserved."))
  }
  if (lifecycleFeedback !== undefined) controls.append(warningCallout(lifecycleFeedback))
  return controls
}

async function coordinatorAction(action: "release" | "restart" | "adopt", sessionId?: string): Promise<void> {
  const registration = activeRegistration
  if (registration === null || lifecyclePending) return
  if (action === "adopt" && !sessionId) {
    lifecycleFeedback = "Enter the session ID to adopt."
    render(state)
    return
  }
  lifecyclePending = true
  lifecycleFeedback = undefined
  render(state)
  try {
    const answer = await post(`/coordinator/${action}`, { slug: registration.slug, ...(sessionId === undefined ? {} : { sessionId }) })
    if (activeRegistration !== registration) return
    if (action === "release") {
      resetTo(currentDirectory)
      // A captain may release from the preserved home chat. A later launch
      // still targets the project, never turns the home into a new project.
      launchDirectory = registration.projectDirectory
      return
    }
    if (answer.registration === undefined) {
      resetTo(currentDirectory)
      return
    }
    const replacement = record(answer.registration)
    for (const field of ["slug", "projectDirectory", "homeDirectory", "coordinatorSessionId", "createdAt"]) {
      if (typeof replacement[field] !== "string") throw new Error("The service sent a malformed registration.")
    }
    contextGeneration += 1
    stopBoardFlow()
    state = initialPanelState()
    dispatch({ type: "lookup-succeeded", registration: replacement as unknown as RegistrationInfo })
    if (state.kind === "registered") startBoardFlow(state.registration)
  } catch (error) {
    if (activeRegistration !== registration) return
    lifecycleFeedback = errorMessage(error)
  } finally {
    if (activeRegistration === registration) {
      lifecyclePending = false
      lifecycleConfirmation = null
      render(state)
    }
  }
}

function upgradesSection(): HTMLElement | null {
  const error = optionalErrors.get("/upgrades")
  if (upgrades === undefined && error === undefined) return null
  const section = document.createElement("section")
  section.append(collapsibleHeading("upgrades", "Home upgrades"))
  if (collapsedSections.has("upgrades")) return section
  section.append(mutedNote("Compare upstream changes with personal words. Acknowledge marks the comparison reviewed; it does not overwrite your files."))
  if (error !== undefined) section.append(warningCallout(error))
  for (const upgrade of upgrades ?? []) {
    const row = document.createElement("article")
    row.className = "fm-card"
    row.append(text(`${upgrade.name} — ${upgrade.edited ? "personally edited" : "unedited"}; ${upgrade.outdated ? "upstream update available" : "up to date"}`))
    const comparison = upgradeComparisons.get(upgrade.name)
    row.append(button(`Compare ${upgrade.name}`, () => { void upgradeAction(upgrade.name, "compare") }, comparison?.pending === true))
    if (comparison?.contents !== undefined) {
      const contents = document.createElement("pre")
      contents.className = "fm-upgrade-comparison"
      contents.textContent = comparison.contents
      row.append(contents)
      row.append(button(`Acknowledge ${upgrade.name}`, () => { void upgradeAction(upgrade.name, "ack") }, comparison.pending))
    }
    if (comparison?.feedback !== undefined) row.append(mutedNote(comparison.feedback))
    section.append(row)
  }
  return section
}

async function upgradeAction(name: UpgradeName, action: "compare" | "ack"): Promise<void> {
  const registration = activeRegistration
  if (registration === null || upgradeComparisons.get(name)?.pending) return
  const comparison = upgradeComparisons.get(name) ?? { pending: false }
  comparison.pending = true
  comparison.feedback = undefined
  upgradeComparisons.set(name, comparison)
  render(state)
  try {
    if (action === "compare") {
      const result = await host.serviceRequest({ method: "GET", path: "/upgrades/compare", query: { slug: registration.slug, name } })
      if (activeRegistration !== registration) return
      if (result.status !== 200) throw new Error(`Comparison failed (status ${result.status}).`)
      const answer = record(JSON.parse(result.body))
      if (typeof answer.contents !== "string") throw new Error("The service sent a malformed comparison.")
      comparison.contents = answer.contents
    } else {
      await post("/upgrades/ack", { slug: registration.slug, name })
      if (activeRegistration !== registration) return
      comparison.feedback = "Acknowledged; personal words are unchanged."
      void fetchExtensions(registration)
    }
  } catch (error) {
    if (activeRegistration !== registration) return
    comparison.feedback = errorMessage(error)
  } finally {
    if (activeRegistration === registration) { comparison.pending = false; render(state) }
  }
}

function watchNotesHistory(): HTMLElement | null {
  const error = optionalErrors.get("/watchnotes")
  if (watchNotes === undefined && error === undefined) return null
  const history = document.createElement("div")
  if (error !== undefined) history.append(warningCallout(error))
  if (watchNotes === undefined) return history
  history.append(mutedNote(`Pending delivery: ${watchNotes.pendingCount}. Dropped: ${watchNotes.dropped}. Retained history is separate from pending delivery.`))
  const details = document.createElement("details")
  const registration = activeRegistration
  details.open = expandedDetails.has("watchnotes")
  details.addEventListener("toggle", () => {
    if (activeRegistration !== registration) return
    if (details.open) expandedDetails.add("watchnotes")
    else expandedDetails.delete("watchnotes")
  })
  const summary = document.createElement("summary")
  summary.textContent = `Retained watch notes (${watchNotes.notes.length}; latest 50 maximum)`
  details.append(summary)
  for (const note of watchNotes.notes) {
    details.append(expandableText(`watchnote:${note.id}`, `${note.createdAt}${note.notification.watchName === undefined ? "" : ` — ${note.notification.watchName}`}`, note.notification.message, "fm-watch-note"))
  }
  history.append(details)
  return history
}

function dispatch(event: PanelEvent): void {
  state = reducePanelState(state, event)
  render(state)
}

function render(state: PanelState): void {
  const root = document.getElementById("firstmate-root")
  if (!root) return
  root.replaceChildren()
  root.append(heading(state.kind === "registered"))

  switch (state.kind) {
    case "loading":
      root.append(text("Reading the project…"))
      break
    case "no-directory":
      root.append(noDirectoryCard())
      break
    case "unregistered":
      root.append(welcomeCard())
      break
    case "launching":
      root.append(text("Launching the first mate…"))
      break
    case "registered":
      if (state.board.kind === "ready") {
        const cards = state.board.columns.flatMap((column) => column.cards)
        const currentWorker = cards.find((card) => card.sessionId !== undefined && card.sessionId === currentSessionId)
        workerShells.retainWorkers(new Set((currentWorker === undefined ? cards : [currentWorker]).flatMap((card) => card.sessionId === undefined ? [] : [card.sessionId])))
      } else workerShells.retainWorkers(new Set())
      if (state.board.kind === "ready" && state.board.refreshError !== undefined) {
        root.append(warningCallout(`Board is stale — showing the last successful read. ${state.board.refreshError} Controls remain available. Steer, Interrupt, Relaunch and End still use service-side checks.`))
      }
      if (commandFeedback !== undefined) root.append(warningCallout(commandFeedback))
      if (state.board.kind === "ready") {
        const worker = state.board.columns.flatMap((column) => column.cards).find((card) => card.sessionId !== undefined && card.sessionId === currentSessionId)
        if (worker !== undefined) {
          root.append(button("Open first mate", () => { void host.openSession(state.registration.coordinatorSessionId).catch(() => {}) }))
          root.append(workerPanel(worker, state.registration))
          break
        }
      }
      root.append(coordinatorRow(state.registration, state.coordinatorTitle, state.shipping))
      if (state.shipping !== undefined) root.append(landingsSection(state.shipping, state.board))
      root.append(suggestionsSection(state))
      root.append(boardView(state.board))
      root.append(watchesCard(state))
      root.append(settingsSection())
      const homeUpgrades = upgradesSection()
      if (homeUpgrades !== null) root.append(homeUpgrades)
      break
    case "cli-missing":
      root.append(text("The openchamber CLI is required. Install it with: npm i -g @openchamber/web"))
      break
    case "service-error":
      root.append(text(state.message))
      break
  }
}

// Top header row: the panel title on the left; once a first mate is
// registered, the refresh control on the right shows how stale the data is
// and re-runs the fetches.
function heading(withRefresh: boolean): HTMLElement {
  const row = document.createElement("div")
  row.className = "fm-heading"
  const title = document.createElement("h1")
  title.textContent = "FirstMate"
  row.append(title)
  if (withRefresh) row.append(refreshButton())
  return row
}

function text(contents: string): HTMLElement {
  const paragraph = document.createElement("p")
  paragraph.textContent = contents
  return paragraph
}

function launchButton(): HTMLElement {
  const button = document.createElement("button")
  button.className = "fm-button fm-button-primary"
  button.textContent = "Launch first mate"
  button.addEventListener("click", () => {
    if (launchDirectory !== null) {
      void launch(launchDirectory)
    }
  })
  return button
}

// A project with no first mate yet gets an introduction instead of a bare
// line: what the first mate is, how it works, and the launch action with an
// explicit safety note. Presentation only — the button is the same launch
// flow with the same guards as before.
function welcomeCard(): HTMLElement {
  const card = document.createElement("article")
  card.className = "fm-welcome"
  const intro = document.createElement("p")
  intro.className = "fm-welcome-intro"
  intro.textContent =
    "A first mate runs this project for you: it turns what you need into supervised coding workers — each in its own git worktree on its own branch — and brings you finished pull requests. It writes only to its own home folder; your repository is only ever changed by the workers it dispatches."
  const heading = document.createElement("h2")
  heading.textContent = "How it works"
  const steps = document.createElement("ul")
  steps.className = "fm-welcome-steps"
  for (const step of [
    "You describe the work — or it picks up your backlog.",
    "It briefs a worker and dispatches it into an isolated worktree.",
    "It supervises the worker and reports back; landings wait for your word (unless the project runs +yolo).",
  ]) {
    const item = document.createElement("li")
    item.textContent = step
    steps.append(item)
  }
  const actions = document.createElement("div")
  actions.className = "fm-welcome-actions"
  actions.append(
    launchButton(),
    mutedNote("Starts a session in this project's FirstMate home — nothing is written to your repository."),
  )
  card.append(intro, heading, steps, actions)
  return card
}

// The no-directory state gets the same card treatment, stripped to a single
// line: there is nothing to introduce until a project is open.
function noDirectoryCard(): HTMLElement {
  const card = document.createElement("article")
  card.className = "fm-welcome"
  card.append(text("Open a project to launch its first mate."))
  return card
}

function coordinatorRow(
  registration: RegistrationInfo,
  coordinatorTitle: string | undefined,
  shipping: ShippingInfo | undefined,
): HTMLElement {
  const header = document.createElement("header")
  header.className = "fm-coordinator"
  // The raw session id means nothing at a glance, so it leaves the visible
  // text and stays available as a hover tooltip on the whole header (with
  // the session title in front when the live subscription knows one).
  header.title = coordinatorTitle === undefined
    ? registration.coordinatorSessionId
    : `${coordinatorTitle} (${registration.coordinatorSessionId})`
  const name = document.createElement("span")
  name.className = "fm-coordinator-name"
  name.textContent = "Coordinator"
  const project = document.createElement("span")
  project.className = "fm-coordinator-project"
  project.textContent = prettifySlug(registration.slug)
  const actions = document.createElement("div")
  actions.className = "fm-actions"
  if (shipping !== undefined) actions.append(shippingBadge(shipping))
  const saveToFile = saveToFileCheckbox()
  actions.append(
    openChatButton(registration.coordinatorSessionId),
    statusReportButton(registration, saveToFile.checked),
    ahoyButton(registration),
    saveToFile.element,
  )
  header.append(name, project, actions, lifecycleControls())
  return header
}

// "openchamber-extensions" → "OpenChamber Extensions": split on "-", then
// capitalize each word. Slugs whose words carry internal capitals keep their
// canonical spelling through the display-name table.
const slugDisplayNames: Record<string, string> = {
  "openchamber-extensions": "OpenChamber Extensions",
}

function prettifySlug(slug: string): string {
  const known = slugDisplayNames[slug]
  if (known !== undefined) return known
  return slug
    .split("-")
    .map((word) => (word === "" ? word : word[0].toUpperCase() + word.slice(1)))
    .join(" ")
}

// /bearings and /ahoy reach the coordinator verbatim through POST /command —
// the panel composes nothing. The save-to-file option at the end of the row
// sends the variant that also writes the dated report into the home's
// reports/ directory; the answer arrives in the coordinator's chat, which
// Open chat opens.
function saveToFileCheckbox(): { element: HTMLElement; checked: () => boolean } {
  // A wrapping label ties the visible text to the checkbox for free.
  const label = document.createElement("label")
  label.className = "fm-save"
  label.title = "Also write the report to a dated file in the project's reports folder."
  const checkbox = document.createElement("input")
  checkbox.type = "checkbox"
  checkbox.setAttribute("aria-label", "Write the bearings report to a dated file")
  label.append(checkbox, document.createTextNode("save report to file"))
  return { element: label, checked: () => checkbox.checked }
}

function statusReportButton(registration: RegistrationInfo, saveToFile: () => boolean): HTMLElement {
  const button = document.createElement("button")
  button.className = "fm-button"
  button.textContent = "Status report"
  button.disabled = captainSendInFlight !== null
  button.title =
    "Ask the coordinator for a status report (bearings): what needs your call, what landed, what is under way, what is next."
  button.addEventListener("click", () => {
    void sendCommand(registration, saveToFile() ? "bearings-file" : "bearings")
  })
  return button
}

function ahoyButton(registration: RegistrationInfo): HTMLElement {
  const button = document.createElement("button")
  button.className = "fm-button"
  button.textContent = "Catch me up"
  button.disabled = captainSendInFlight !== null
  button.title =
    "Ask the coordinator to summarize what happened since your last exchange, with every open decision and a recommendation."
  button.addEventListener("click", () => {
    void sendCommand(registration, "ahoy")
  })
  return button
}

async function sendCommand(registration: RegistrationInfo, command: string): Promise<void> {
  if (activeRegistration !== registration || captainSendInFlight !== null) return
  captainSendInFlight = registration
  commandFeedback = undefined
  render(state)
  try {
    const result = await post("/command", { slug: registration.slug, command })
    if (activeRegistration !== registration) return
    if (result.sent !== true) throw new Error("Requesting the report failed: the service sent a malformed delivery answer.")
    if (typeof result.warning === "string") commandFeedback = result.warning
  } catch (error) {
    if (activeRegistration !== registration) return
    commandFeedback = `Command failed: ${errorMessage(error)}`
  } finally {
    if (activeRegistration === registration) {
      captainSendInFlight = null
      render(state)
    }
  }
}

// The project's shipping mode as read from projects.md via the service; a
// badge only — projects.md is the record, so there is nothing to edit here.
// The tooltip spells the mode out because the short label alone says nothing.
const shippingModeTitles: Record<string, string> = {
  "direct-PR": "Shipping mode: workers open pull requests directly; landings wait for your word.",
  "reviewed-PR": "Shipping mode: workers review their diff and wait for CI before asking for your word.",
  "local-only": "Shipping mode: no remote; work stays on a clean branch and lands only on your word.",
}

const yoloTitleSuffix = " +yolo: green, in-scope work lands without asking."

function shippingBadge(shipping: ShippingInfo): HTMLElement {
  const badge = document.createElement("span")
  mountBadge(badge, {
    label: shippingBadgeLabel(shipping),
    tone: shipping.mode === null ? "warning" : "neutral",
  })
  const baseTitle = shipping.mode === null ? undefined : shippingModeTitles[shipping.mode]
  if (baseTitle !== undefined) badge.title = shipping.yolo ? baseTitle + yoloTitleSuffix : baseTitle
  return badge
}

function openChatButton(sessionId: string): HTMLElement {
  const button = document.createElement("button")
  button.className = "fm-button"
  button.textContent = "Open chat"
  button.title = "Open the coordinator's chat."
  // The sandboxed iframe cannot open the session itself; the host does it.
  button.addEventListener("click", () => {
    void host.openSession(sessionId)
  })
  return button
}

// Collapsible sections: Landings, Suggestions, Watches, and each board
// column. Collapse state is keyed by a stable section id at module level, so
// the panel's full re-renders preserve it, and persists best-effort to
// localStorage — a sandboxed iframe that denies storage loses only the
// persistence, not the feature. Default is expanded.
const collapsedSectionsStorageKey = "firstmate-collapsed-sections"

const collapsedSections = loadCollapsedSections()
const columnOrderStorageKey = "firstmate-column-order"
let columnOrder = loadColumnOrder()

function loadColumnOrder(): ReturnType<typeof parseColumnOrder> {
  try {
    return parseColumnOrder(JSON.parse(window.localStorage.getItem(columnOrderStorageKey) ?? "null"))
  } catch {
    return parseColumnOrder(null)
  }
}

function orderedColumns(columns: BoardColumn[]): BoardColumn[] {
  return [...columns].sort((left, right) => columnOrder.indexOf(left.id) - columnOrder.indexOf(right.id))
}

function reorderColumn(id: BoardColumn["id"], direction: "up" | "down"): void {
  if (state.kind !== "registered" || state.board.kind !== "ready") return
  const visible = orderedColumns(state.board.columns)
  const index = visible.findIndex((column) => column.id === id)
  const neighbor = visible[index + (direction === "up" ? -1 : 1)]
  if (index < 0 || neighbor === undefined) return
  const target = columnOrder.indexOf(neighbor.id)
  while (columnOrder.indexOf(id) !== target) columnOrder = moveColumn(columnOrder, id, direction)
  try { window.localStorage.setItem(columnOrderStorageKey, JSON.stringify(columnOrder)) } catch { /* Session-only order when storage is denied. */ }
  render(state)
}

function loadCollapsedSections(): Set<string> {
  try {
    const raw = window.localStorage.getItem(collapsedSectionsStorageKey)
    if (raw === null) return new Set()
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return new Set()
    return new Set(parsed.filter((entry): entry is string => typeof entry === "string"))
  } catch {
    return new Set()
  }
}

function persistCollapsedSections(): void {
  try {
    window.localStorage.setItem(collapsedSectionsStorageKey, JSON.stringify([...collapsedSections]))
  } catch {
    // Storage denied (e.g. a sandboxed iframe); collapse state then only
    // lives for this panel session.
  }
}

// The heading doubles as the toggle: a button in behavior (role,
// aria-expanded, Enter/Space) with a chevron pointing right when collapsed
// and down when expanded. A collapsed section renders the heading only, so
// callers skip their content (captions included) after appending it.
function collapsibleHeading(sectionId: string, label: string): HTMLElement {
  const collapsed = collapsedSections.has(sectionId)
  const heading = document.createElement("h2")
  heading.className = "fm-collapsible-heading"
  heading.setAttribute("role", "button")
  heading.setAttribute("aria-expanded", String(!collapsed))
  heading.tabIndex = 0
  const chevron = document.createElement("span")
  chevron.className = "fm-chevron"
  chevron.setAttribute("aria-hidden", "true")
  chevron.textContent = collapsed ? "▸" : "▾"
  heading.append(chevron, document.createTextNode(label))
  const toggle = (): void => {
    if (collapsedSections.has(sectionId)) collapsedSections.delete(sectionId)
    else collapsedSections.add(sectionId)
    persistCollapsedSections()
    render(state)
  }
  heading.addEventListener("click", toggle)
  heading.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" && event.key !== " ") return
    event.preventDefault()
    toggle()
  })
  return heading
}

// Landings: all the records the service parsed out of reports/landings.md,
// in a fixed-height scrollable box, with a prominent warning for every entry
// it had to drop — a partly corrupt log must never read as a clean, empty
// one. The payload fields are untrusted file contents, so they reach the DOM
// only through textContent.
function landingsSection(shipping: ShippingInfo, board: Board): HTMLElement {
  const section = document.createElement("section")
  section.append(collapsibleHeading("landings", "Landings"))
  if (collapsedSections.has("landings")) return section
  // Cleanup visibility ground rule, stated once: the extension never deletes.
  const cleanupCaption = document.createElement("p")
  cleanupCaption.className = "fm-caption"
  cleanupCaption.textContent = "FirstMate does not delete worktrees or branches; cleanup after a landing is yours."
  section.append(cleanupCaption)
  if (shipping.cleanupError !== undefined) section.append(warningCallout(shipping.cleanupError))
  for (const error of shipping.landingErrors) section.append(warningCallout(error))
  if (shipping.landings.length === 0) {
    if (shipping.landingErrors.length === 0) section.append(text("No landings."))
    return section
  }
  const sessions = sessionsByTitle(board)
  const list = document.createElement("div")
  list.className = "fm-landings"
  for (const landing of shipping.landings) list.append(landingRow(landing, sessions.get(landing.task)))
  section.append(list)
  return section
}

// Live workers by exact board title, so a landing can open the worker's
// session. This only reads the already-fetched board; the reducer is untouched.
function sessionsByTitle(board: Board): Map<string, string> {
  const sessions = new Map<string, string>()
  if (board.kind !== "ready") return sessions
  for (const column of board.columns) {
    for (const card of column.cards) {
      if (card.sessionId !== undefined) sessions.set(card.title, card.sessionId)
    }
  }
  return sessions
}

function landingRow(landing: LandingRow, sessionId: string | undefined): HTMLElement {
  const row = document.createElement("article")
  row.className = "fm-landing"
  if (sessionId === undefined) {
    // The landing's worker is gone from the board; the row stays readable
    // but gives no false affordance of being clickable.
    row.classList.add("fm-landing-archived")
    row.title = "No live worker session to open."
  } else {
    row.classList.add("fm-landing-open")
    row.title = "Open the worker's session"
    row.setAttribute("role", "button")
    row.tabIndex = 0
    // The sandboxed iframe cannot open the session itself; the host does it.
    row.addEventListener("click", () => {
      void host.openSession(sessionId)
    })
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return
      event.preventDefault()
      void host.openSession(sessionId)
    })
  }
  const task = document.createElement("strong")
  task.className = "fm-landing-task"
  task.textContent = landing.task
  const meta = document.createElement("span")
  meta.className = "fm-landing-meta"
  meta.append(
    metaPiece("commit", commitChip(landing.commit)),
    metaPiece("CI", ciBadge(landing.ci)),
    metaPiece("mode", metaValue(landing.mode)),
    metaPiece("authorization", metaValue(landing.authorization)),
    metaPiece("landed", metaValue(formatLanded(landing.landedAt))),
  )
  row.append(task, meta)
  if (landing.cleanup !== undefined) row.append(cleanupDisplay(landing.cleanup))
  return row
}

// The landing's worktree cleanup state as the service observed it with one
// stat of the recorded directory: pending shows the amber badge plus the
// wrapped recorded path, removed may say so, unknown says exactly that, and
// no claim renders nothing. There is deliberately no cleanup action —
// FirstMate does not delete worktrees or branches.
function cleanupDisplay(cleanup: NonNullable<LandingRow["cleanup"]>): HTMLElement {
  const block = document.createElement("div")
  block.className = "fm-cleanup"
  if (cleanup.state === "pending") {
    const badge = warningBadge("Awaiting captain cleanup")
    badge.title = cleanup.worktree
    block.append(badge)
    const worktreePath = document.createElement("span")
    worktreePath.className = "fm-watch-path"
    worktreePath.textContent = cleanup.worktree
    worktreePath.title = cleanup.worktree
    block.append(worktreePath)
  } else if (cleanup.state === "removed") {
    const note = document.createElement("span")
    note.className = "fm-note"
    note.textContent = "Worktree removed."
    block.append(note)
  } else {
    const note = document.createElement("span")
    note.className = "fm-note"
    note.textContent = "Cleanup status unknown."
    block.append(note)
  }
  return block
}

// One labeled piece of the landing meta line: muted label, then the value.
function metaPiece(label: string, value: HTMLElement): HTMLElement {
  const piece = document.createElement("span")
  piece.className = "fm-meta"
  const name = document.createElement("span")
  name.className = "fm-meta-label"
  name.textContent = label
  piece.append(name, value)
  return piece
}

function metaValue(value: string): HTMLElement {
  const span = document.createElement("span")
  span.textContent = value
  return span
}

// Short sha in the row, full sha on hover.
function commitChip(commit: string): HTMLElement {
  const chip = document.createElement("code")
  chip.className = "fm-mono"
  chip.textContent = commit.slice(0, 8)
  chip.title = commit
  return chip
}

// The charter records the CI result as a free word ("green" in practice);
// known pass/fail words pick the tone, anything else stays neutral.
function ciBadge(ci: string): HTMLElement {
  const badge = document.createElement("span")
  const result = ci.trim().toLowerCase()
  const tone: Tone = result.includes("green") || result.includes("pass")
    ? "success"
    : result.includes("red") || result.includes("fail")
      ? "error"
      : "neutral"
  mountBadge(badge, { label: ci, tone })
  return badge
}

// landedAt is an ISO 8601 timestamp; a value that fails to parse is shown as-is.
function formatLanded(iso: string): string {
  const parsed = new Date(iso)
  return Number.isNaN(parsed.getTime())
    ? iso
    : parsed.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" })
}

// Supervision health rows above the board columns: what the service's two
// host-observation channels saw on their last round, and when that round
// was. Nothing here claims to be live — the poll age is shown as its own
// number, marked stale once it passes a minute, and a missing or
// malformed record reads "Unknown" rather than healthy. The words reuse the
// panel's tiny text tokens; the state is always spelled out, never color-only.
function supervisionRows(supervision: SupervisionHealth | undefined): HTMLElement {
  const block = document.createElement("div")
  block.className = "fm-supervision"
  const rows = document.createElement("div")
  rows.className = "fm-landing-meta"
  const blockedValue = metaValue(observationLabel(supervision?.blockedObservation, supervision?.blockedObservationReason))
  if (supervision?.blockedObservationReason !== undefined) blockedValue.title = supervision.blockedObservationReason
  const failureValue = metaValue(observationLabel(supervision?.failureObservation, supervision?.failureObservationReason))
  if (supervision?.failureObservationReason !== undefined) failureValue.title = supervision.failureObservationReason
  const poll = pollAge(supervision?.lastSuccessfulPollAt)
  const pollValue = metaValue(poll.label)
  if (poll.title !== undefined) pollValue.title = poll.title
  rows.append(
    metaPiece("blocked observation", blockedValue),
    metaPiece("failure observation", failureValue),
    metaPiece("last successful poll", pollValue),
  )
  block.append(rows)
  // The fallback spelled out: an observation channel can answer and still
  // miss what the captain actually cares about.
  const caption = document.createElement("p")
  caption.className = "fm-caption"
  caption.textContent =
    "When observation is degraded or unavailable, a Working card may still be waiting on a question or permission; failures may be unobserved."
  block.append(caption)
  return block
}

// The service's channel states, word for word; a missing or malformed record
// is "Unknown" — never a healthy claim.
function observationLabel(state: SupervisionHealth["blockedObservation"] | undefined, reason: string | undefined): string {
  const word = state === "working" ? "Available" : state === "degraded" ? "Degraded" : state === "unavailable" ? "Unavailable" : "Unknown"
  return reason === undefined ? word : `${word} — ${reason}`
}

// The last successful poll as a relative age ("just now", "3m ago") with the
// full timestamp on hover; past a minute it is marked stale, and an absent
// or unparseable time reads "Not polled yet". A timestamp ahead of the
// local clock is an anomaly, not freshness — it says so instead of reading
// "just now" as healthy. Never the word "live".
function pollAge(iso: string | undefined): { label: string; title?: string } {
  if (iso === undefined) return { label: "Not polled yet" }
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return { label: "Not polled yet" }
  const elapsed = Date.now() - date.getTime()
  if (elapsed < 0) {
    return {
      label: "timestamp ahead of local clock",
      title: date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }),
    }
  }
  const minutes = Math.floor(elapsed / 60_000)
  const relative = elapsed < 60_000 ? "just now" : minutes < 60 ? `${minutes}m ago` : `${Math.floor(minutes / 60)}h ago`
  return {
    label: elapsed <= 60_000 ? relative : `${relative} (stale)`,
    title: date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }),
  }
}

function boardView(board: Board): HTMLElement {
  const container = document.createElement("div")
  container.className = "fm-board"
  switch (board.kind) {
    case "loading":
      container.append(text("Reading the board…"))
      break
    case "error":
      container.append(text(board.message))
      break
    case "ready":
      if (board.warning !== undefined) container.append(warningBadge(board.warning))
      container.append(supervisionRows(board.supervision))
      if (board.columns.length === 0) {
        container.append(text("The board is empty."))
      } else {
        const columns = orderedColumns(board.columns)
        for (const [index, column] of columns.entries()) container.append(boardColumn(column, index, columns.length))
      }
      break
  }
  return container
}

function boardColumn(column: BoardColumn, index: number, count: number): HTMLElement {
  const section = document.createElement("section")
  section.setAttribute("data-column", column.id)
  const header = document.createElement("div")
  header.className = "fm-watch-header"
  header.append(collapsibleHeading(`column:${column.id}`, column.id))
  const controls = document.createElement("div")
  controls.className = "fm-actions"
  for (const direction of ["up", "down"] as const) {
    const move = button(direction === "up" ? "↑" : "↓", () => reorderColumn(column.id, direction), direction === "up" ? index === 0 : index === count - 1)
    move.setAttribute("aria-label", `Move ${column.id} ${direction}`)
    move.title = `Move ${column.id} ${direction}`
    controls.append(move)
  }
  header.append(controls)
  section.append(header)
  if (collapsedSections.has(`column:${column.id}`)) return section
  if (column.id === "Done") {
    // Done cards confuse the eye: they look finished but keep live actions.
    // The caption explains what the column is for before the captain asks.
    const caption = document.createElement("p")
    caption.className = "fm-caption"
    caption.textContent = "Completed tasks — kept for reference. Relaunch to continue work, or End to archive the card."
    section.append(caption)
  }
  for (const card of column.cards) section.append(boardCard(card))
  return section
}

const badgeTones: Record<BoardCard["state"], Tone> = {
  Queued: "neutral",
  Working: "primary",
  Blocked: "warning",
  Parked: "info",
  Done: "success",
  Failed: "error",
  Idle: "neutral",
}

function boardCard(card: BoardCard, workerContext = false): HTMLElement {
  const article = document.createElement("article")
  article.className = "fm-card"
  const title = document.createElement("strong")
  title.textContent = card.title
  article.append(title, stateBadge(card))
  if (card.taskId !== undefined) article.append(metaPiece("task", metaValue(card.taskId)))
  if (card.kind !== undefined) article.append(metaPiece("kind", metaValue(card.kind)))
  if (card.blockedBy !== undefined) article.append(mutedNote(`Blocked by: ${card.blockedBy}`))
  if (card.hold !== undefined) article.append(warningCallout(`Hold: ${card.hold}`))
  if (card.reviewHead !== undefined) article.append(metaPiece("review head", commitChip(card.reviewHead)))
  if (card.blockedReason !== undefined) article.append(blockedNote(card.blockedReason))
  if (card.warning !== undefined) article.append(warningBadge(card.warning))
  if (isUnfinished(card.state) && card.possiblyStalledSince !== undefined) article.append(stallNote())
  if (card.branch !== undefined) article.append(branchMeta(card.branch, card.worktree))
  if (card.workerReport !== undefined) {
    article.append(mutedNote(`Worker reported ${card.workerReport.state}: ${card.workerReport.text || "No details supplied."}`))
  } else if (card.lastWord !== undefined) article.append(lastWordLine(card.lastWord))
  const messageLink = messageLinkControl(card)
  if (messageLink !== undefined) article.append(messageLink)
  if (card.prUrl !== undefined) article.append(prLink(card))
  if (card.sessionId !== undefined) article.append(workerShells.render(card.sessionId))
  if (workerContext) return article
  if (card.taskId !== undefined) article.append(decisionControls(card))
  if (card.sessionId === undefined) {
    article.append(mutedNote(card.kind === "captain" ? "Captain task — no worker session required." : "No worker session to act on."))
  } else {
    article.append(cardActions(card))
  }
  return article
}

function messageLinkControl(card: BoardCard): HTMLElement | undefined {
  const link = workerMessageLink(card.sessionId, card.lastMessageId)
  if (link === undefined) return undefined
  const registration = activeRegistration
  const row = document.createElement("div")
  row.className = "fm-actions"
  const feedback = document.createElement("span")
  feedback.className = "fm-feedback"
  const copy = button("Copy message link", () => {
    if (typeof host.writeClipboard !== "function" || activeRegistration !== registration) return
    void host.writeClipboard(link).then(() => {
      if (activeRegistration === registration) feedback.textContent = "Message link copied. Paste in OpenChamber chat to open this exact message."
    }).catch(() => {
      if (activeRegistration === registration) feedback.textContent = "Copy failed."
    })
  }, typeof host.writeClipboard !== "function")
  copy.title = `${link}\nThe SDK opens whole sessions only. This link targets the observed message in OpenChamber chat.`
  row.append(copy, feedback)
  return row
}

function messageDraft(key: string): MessageDraft {
  let draft = messageDrafts.get(key)
  if (draft === undefined) { draft = { text: "", pending: false }; messageDrafts.set(key, draft) }
  return draft
}

function messageControl(draft: MessageDraft, label: string, sendLabel: string, send: (text: string) => void): HTMLElement {
  const row = document.createElement("div")
  row.className = "fm-steer"
  const input = document.createElement("input")
  input.type = "text"
  input.placeholder = label
  input.setAttribute("aria-label", label)
  input.value = draft.text
  input.disabled = draft.pending
  const submit = button(sendLabel, () => {
    if (draft.pending || captainSendInFlight !== null || draft.text.trim() === "") return
    send(draft.text.trim())
  }, draft.pending || captainSendInFlight !== null || draft.text.trim() === "")
  input.addEventListener("input", () => { draft.text = input.value; submit.disabled = draft.pending || captainSendInFlight !== null || draft.text.trim() === "" })
  row.append(input, submit)
  return row
}

function decisionControls(card: BoardCard): HTMLElement {
  const row = document.createElement("div")
  row.className = "fm-actions"
  const taskId = card.taskId!
  const draft = messageDraft(`decision:${taskId}`)
  for (const action of card.actions ?? []) {
    const choice = button(action.label, () => { void sendDecision(taskId, draft, { label: action.label, expectedText: action.text }) }, draft.pending || captainSendInFlight !== null)
    choice.title = action.text
    row.append(choice)
  }
  row.append(messageControl(draft, `Answer for ${taskId}`, "Answer", (answer) => { void sendDecision(taskId, draft, { text: answer }) }))
  row.append(mutedNote("Replies go to the first mate, not the worker; holds and landing authorization are unchanged until the backlog records a change."))
  if (draft.feedback !== undefined) row.append(mutedNote(draft.feedback))
  return row
}

async function sendDecision(taskId: string, draft: MessageDraft, answer: { label: string; expectedText: string } | { text: string }): Promise<void> {
  const registration = activeRegistration
  if (registration === null || captainSendInFlight !== null || draft.pending || messageDrafts.get(`decision:${taskId}`) !== draft) return
  captainSendInFlight = registration
  draft.pending = true
  draft.feedback = undefined
  render(state)
  try {
    const result = await post("/decision", { slug: registration.slug, taskId, ...answer })
    if (activeRegistration !== registration) return
    draft.feedback = typeof result.warning === "string" ? result.warning : "Sent to first mate; holds and task state are unchanged by this reply."
    if ("text" in answer) draft.text = ""
  } catch (error) {
    if (activeRegistration !== registration) return
    draft.feedback = errorMessage(error)
  } finally {
    if (activeRegistration === registration) { captainSendInFlight = null; draft.pending = false; render(state); void fetchBoard() }
  }
}

function workerPanel(card: BoardCard, registration: RegistrationInfo): HTMLElement {
  const section = document.createElement("section")
  section.append(boardCard(card, true))
  section.append(mutedNote("This worker's task. Notes go to the first mate with this session as their origin; they do not steer the worker or release a captain hold."))
  const draft = messageDraft(`handoff:${card.sessionId}`)
  section.append(messageControl(draft, "Note for first mate", "Send note to first mate", (message) => {
    void sendHandoff(registration, card.sessionId!, draft, message)
  }))
  if (draft.feedback !== undefined) section.append(mutedNote(draft.feedback))
  return section
}

async function sendHandoff(registration: RegistrationInfo, sessionId: string, draft: MessageDraft, message: string): Promise<void> {
  if (activeRegistration !== registration || captainSendInFlight !== null || draft.pending) return
  captainSendInFlight = registration
  draft.pending = true
  draft.feedback = undefined
  render(state)
  try {
    const result = await post("/handoff", { directory: registration.projectDirectory, sessionId, text: message })
    if (activeRegistration !== registration) return
    draft.feedback = typeof result.warning === "string" ? result.warning : "Note sent to first mate; the worker and captain hold are unchanged."
    draft.text = ""
  } catch (error) {
    if (activeRegistration !== registration) return
    draft.feedback = errorMessage(error)
  } finally {
    if (activeRegistration === registration) { captainSendInFlight = null; draft.pending = false; render(state) }
  }
}

// Muted branch line; the worktree the branch was checked out in rides on hover.
function branchMeta(branch: string, worktree: string | undefined): HTMLElement {
  const value = metaValue(branch)
  if (worktree !== undefined) value.title = worktree
  return metaPiece("branch", value)
}

function mutedNote(message: string): HTMLElement {
  const note = document.createElement("p")
  note.className = "fm-note"
  note.textContent = message
  return note
}

// The worker's last word, quoted as speech and muted: a visually secondary
// preview under the title and badges, clamped by CSS to two lines. Cards
// without one render nothing extra.
function lastWordLine(lastWord: string): HTMLElement {
  const quote = document.createElement("p")
  quote.className = "fm-last-word"
  quote.textContent = `“${lastWord}”`
  return quote
}

// A blocked card says what it waits on in plain words — the state badge's
// short "(reason)" suffix is not a sentence. Same amber treatment as the
// panel's other warnings.
const blockedReasonNotes: Record<NonNullable<BoardCard["blockedReason"]>, string> = {
  permission: "Blocked — waiting on a permission approval",
  question: "Blocked — waiting on an answer to a question",
}

function blockedNote(reason: NonNullable<BoardCard["blockedReason"]>): HTMLElement {
  const note = document.createElement("p")
  note.className = "fm-blocked-note"
  note.textContent = blockedReasonNotes[reason]
  return note
}

// Advisory stall flag, rendered in the same amber as the other cautionary
// notes. It is deliberately not a state: the card stays Working (or whatever
// the backlog records), nothing stops automatically, and the note never calls
// the worker Failed or Blocked. Only shown while the service currently
// provides the flag on an unfinished worker.
const stallNoteText =
  "Possibly stalled — no observed message progress for 30 minutes. Open the session or Interrupt; nothing stops automatically."

function isUnfinished(state: BoardCard["state"]): boolean {
  return state !== "Done" && state !== "Failed"
}

function stallNote(): HTMLElement {
  const note = document.createElement("p")
  note.className = "fm-blocked-note"
  note.textContent = stallNoteText
  return note
}

function stateBadge(card: BoardCard): HTMLElement {
  const badge = document.createElement("span")
  mountBadge(badge, {
    label: card.blockedReason === undefined ? card.state : `${card.state} (${card.blockedReason})`,
    tone: badgeTones[card.state],
  })
  return badge
}

function warningBadge(label: string): HTMLElement {
  const badge = document.createElement("span")
  mountBadge(badge, { label, tone: "warning" })
  return badge
}

// Long drop messages (e.g. landing-line parse failures) read better as a
// wrapping callout than as a pill; the tone is the same warning color.
function warningCallout(message: string): HTMLElement {
  const callout = document.createElement("div")
  callout.className = "fm-warning"
  callout.textContent = message
  return callout
}

function prLink(card: BoardCard): HTMLElement {
  const button = document.createElement("button")
  button.className = "fm-button"
  button.textContent = card.prSource === "worker-report" ? "Open worker-reported PR" : "Open PR on GitHub"
  button.title = card.prSource === "worker-report" ? "Worker testimony only. This link doesn't establish verified readiness or completion." : "Open the pull request in your browser."
  button.disabled = card.prOpenable !== true
  // The sandboxed iframe cannot open links itself; the host opens it.
  button.addEventListener("click", () => {
    if (card.prOpenable === true && card.prUrl !== undefined) void host.openUrl(card.prUrl)
  })
  return button
}

// Card actions: Open session opens the worker session in the host; Steer and
// Relaunch relay through the service (the coordinator owns the backlog and
// the relaunch itself); Interrupt asks the service to stop the worker's
// current turn; End archives the card in extension state — the session and
// worktree are left exactly as they are. Drafts, pending requests and feedback
// survive card rebuilds; the board refetch carries authoritative state changes.
type WorkerActionPath = "/steer" | "/relaunch" | "/interrupt" | "/end"

function workerActionKey(registration: RegistrationInfo, sessionId: string, pathname: WorkerActionPath): string {
  return `worker:${registration.slug}\n${registration.coordinatorSessionId}\n${sessionId}\n${pathname}`
}

function workerActionDraft(card: BoardCard, pathname: WorkerActionPath): MessageDraft {
  return messageDraft(workerActionKey(activeRegistration!, card.sessionId!, pathname))
}

function actionFeedback(card: BoardCard): HTMLElement {
  const element = document.createElement("span")
  element.className = "fm-feedback"
  element.textContent = (["/interrupt", "/steer", "/relaunch", "/end"] as const)
    .map((pathname) => workerActionDraft(card, pathname).feedback)
    .filter((message): message is string => message !== undefined)
    .join(" ")
  return element
}

async function runCardAction(pathname: WorkerActionPath, body: Record<string, string>, draft: MessageDraft, successMessage: string): Promise<{ status: number }> {
  const registration = activeRegistration
  if (registration === null || draft.pending || messageDrafts.get(workerActionKey(registration, body.sessionId, pathname)) !== draft) return { status: 0 }
  draft.pending = true
  draft.feedback = undefined
  render(state)
  try {
    const result = await host.serviceRequest({
      method: "POST",
      path: pathname,
      body: JSON.stringify({ slug: registration.slug, ...body }),
    })
    if (activeRegistration !== registration) return { status: 0 }
    let parsed: { error?: string; warning?: string } = {}
    try {
      parsed = JSON.parse(result.body) as { error?: string; warning?: string }
    } catch {
      // A non-JSON body only matters through the generic message below.
    }
    if (result.status !== 200) {
      if (pathname === "/interrupt" && result.status === 501) {
        interruptUnsupportedSessions.add(body.sessionId)
        draft.feedback = "Interrupt is not exposed by OpenChamber's extension contract, and this host did not offer the fallback path."
      } else {
        draft.feedback = parsed.error ?? `The action failed (status ${result.status}).`
      }
      return { status: result.status }
    }
    // A 200 with a warning still succeeded (e.g. the steer reached the worker
    // but the coordinator could not be told); the captain sees the caveat.
    draft.feedback = parsed.warning ?? successMessage
    draft.text = ""
    return { status: result.status }
  } catch {
    if (activeRegistration === registration) draft.feedback = "The service is unreachable."
    return { status: 0 }
  } finally {
    if (activeRegistration === registration) {
      draft.pending = false
      render(state)
      void fetchBoard()
    }
  }
}

function cardActions(card: BoardCard): HTMLElement {
  const row = document.createElement("div")
  row.className = "fm-actions"
  row.append(watchButton(card), interruptButton(card), steerControl(card), relaunchControl(card), endButton(card), actionFeedback(card))
  return row
}

// Interrupt rides a private-surface workaround (the managed opencode
// server's own abort call); hosts that do not offer it answer 501. Those
// session ids are remembered here so Interrupt stays disabled for the rest
// of the panel session — module state on purpose: host capability is not
// board state, and the reducer does not model it.
const interruptUnsupportedSessions = new Set<string>()

function interruptButton(card: BoardCard): HTMLElement {
  const draft = workerActionDraft(card, "/interrupt")
  const button = document.createElement("button")
  button.className = "fm-button"
  button.textContent = "Interrupt"
  button.title = "Stop the worker's current turn."
  button.disabled = card.sessionId === undefined || draft.pending || interruptUnsupportedSessions.has(card.sessionId)
  button.addEventListener("click", () => {
    const sessionId = card.sessionId
    if (sessionId === undefined || draft.pending || interruptUnsupportedSessions.has(sessionId)) return
    void runCardAction("/interrupt", { sessionId }, draft, "Interrupt sent.")
  })
  return button
}

function watchButton(card: BoardCard): HTMLElement {
  const button = document.createElement("button")
  button.className = "fm-button"
  button.textContent = "Open session"
  button.title = "Open this worker's session in OpenChamber"
  button.disabled = card.sessionId === undefined
  // The sandboxed iframe cannot open the session itself; the host does it.
  button.addEventListener("click", () => {
    if (card.sessionId !== undefined) void host.openSession(card.sessionId)
  })
  return button
}

function steerControl(card: BoardCard): HTMLElement {
  const draft = workerActionDraft(card, "/steer")
  const input = document.createElement("input")
  input.type = "text"
  input.placeholder = "Steer the worker…"
  input.value = draft.text
  input.disabled = draft.pending
  const send = document.createElement("button")
  send.className = "fm-button"
  send.textContent = "Steer"
  // A Done worker is off the board's working set; steering it makes no sense.
  // Send stays disabled until the captain has typed something, and the
  // tooltip names the Done state instead of leaving the disabled button mute.
  const updateSend = (): void => {
    send.disabled = draft.pending || input.value.trim() === "" || card.sessionId === undefined || card.state === "Done"
    send.title = card.state === "Done"
      ? "This task is Done — relaunch the worker to continue."
      : "Send this message to the worker."
  }
  updateSend()
  input.addEventListener("input", () => { draft.text = input.value; updateSend() })
  send.addEventListener("click", () => {
    const steerText = input.value.trim()
    if (card.sessionId === undefined || draft.pending || card.state === "Done" || steerText === "") return
    void runCardAction("/steer", { sessionId: card.sessionId, text: steerText }, draft, "Steered.")
  })
  const control = document.createElement("span")
  control.className = "fm-steer"
  control.append(input, send)
  return control
}

function relaunchControl(card: BoardCard): HTMLElement {
  const draft = workerActionDraft(card, "/relaunch")
  const input = document.createElement("input")
  input.type = "text"
  input.placeholder = "Note for the relaunch…"
  input.value = draft.text
  input.disabled = draft.pending
  const send = document.createElement("button")
  send.className = "fm-button"
  send.textContent = "Relaunch"
  send.title = "Start a fresh worker in this task's worktree with your note."
  // The coordinator relaunches into the recorded worktree; without one the
  // service could not name where the fresh worker goes. The session id
  // identifies the backlog entry to supersede. Send stays disabled until the
  // captain has typed a note.
  const updateSend = (): void => {
    send.disabled = draft.pending || input.value.trim() === "" || card.sessionId === undefined || card.worktree === undefined
  }
  updateSend()
  input.addEventListener("input", () => { draft.text = input.value; updateSend() })
  send.addEventListener("click", () => {
    const note = input.value.trim()
    if (card.sessionId === undefined || card.worktree === undefined || draft.pending || note === "") return
    void runCardAction("/relaunch", { sessionId: card.sessionId, note }, draft, "Relaunch requested.")
  })
  const control = document.createElement("span")
  control.append(input, send)
  return control
}

function endButton(card: BoardCard): HTMLElement {
  const draft = workerActionDraft(card, "/end")
  const key = workerActionKey(activeRegistration!, card.sessionId!, "/end")
  const button = document.createElement("button")
  button.className = "fm-button"
  button.textContent = endConfirmations.has(key) ? "Really end?" : "End"
  button.title = "Archive this card; the session and worktree are left as they are."
  button.disabled = card.sessionId === undefined || draft.pending
  // Two-click confirm instead of window.confirm: a sandboxed iframe without
  // allow-modals swallows dialogs silently.
  button.addEventListener("click", () => {
    if (card.sessionId === undefined || draft.pending || messageDrafts.get(key) !== draft) return
    if (!endConfirmations.has(key)) {
      endConfirmations.add(key)
      render(state)
      return
    }
    endConfirmations.delete(key)
    void runCardAction("/end", { sessionId: card.sessionId }, draft, "Archived.")
  })
  return button
}

// The Suggestions section sits below the coordinator row, above the board:
// project-level messages the coordinator proposes, each shown as a label
// line with Send and Dismiss buttons — Send relays the suggestion's text to
// the coordinator verbatim; Dismiss drops it unsent. The refetch after each
// call carries the file's new state; the line the service removed stops
// rendering. Action feedback lives in its own persistent slot so the
// refetch that follows every action cannot erase why the line stayed.
function suggestionsSection(state: PanelState & { kind: "registered" }): HTMLElement {
  const section = document.createElement("section")
  section.append(collapsibleHeading("suggestions", "Suggestions"))
  if (collapsedSections.has("suggestions")) return section
  const caption = document.createElement("p")
  caption.className = "fm-caption"
  caption.textContent = "Messages the coordinator suggests — Send relays it to the coordinator."
  section.append(caption)
  if (state.suggestionActionFeedback !== undefined) section.append(warningBadge(state.suggestionActionFeedback))
  if (state.suggestionsError !== undefined) {
    if (state.suggestions !== undefined) {
      section.append(text(`${state.suggestionsError} — showing the last read suggestions.`))
    } else {
      section.append(text(state.suggestionsError))
      return section
    }
  }
  if (state.suggestions === undefined) {
    section.append(text("Reading the suggestions…"))
    return section
  }
  if (state.suggestions.length === 0) {
    section.append(text("No suggestions."))
    return section
  }
  for (const suggestion of state.suggestions) {
    section.append(suggestionRow(suggestion, state.suggestionActionPending === true))
  }
  return section
}

function suggestionRow(suggestion: SuggestionRow, actionPending: boolean): HTMLElement {
  const row = document.createElement("div")
  row.className = "fm-suggestion"
  const label = document.createElement("span")
  label.className = "fm-suggestion-label"
  label.textContent = suggestion.label
  // Hover remains a preview; the full text is also keyboard-accessible below.
  label.title = suggestion.text
  const actions = document.createElement("div")
  actions.className = "fm-suggestion-actions"
  const send = document.createElement("button")
  send.className = "fm-button"
  send.textContent = "Send"
  send.title = suggestion.text
  send.setAttribute("aria-label", `Send ${suggestion.label}`)
  send.disabled = actionPending || captainSendInFlight !== null
  // The in-flight flag is checked in the handler as well as via the disabled
  // attribute: a re-render between the click and the answer rebuilds the row
  // with fresh buttons, and only the flag can stop a repeat press.
  send.addEventListener("click", () => {
    if (suggestionActionInFlight) return
    void runSuggestionAction("/suggestion/send", suggestion.label)
  })
  const dismiss = document.createElement("button")
  dismiss.className = "fm-button"
  dismiss.textContent = "Dismiss"
  dismiss.title = `Dismiss "${suggestion.label}" without sending`
  dismiss.setAttribute("aria-label", `Dismiss ${suggestion.label}`)
  dismiss.disabled = actionPending
  dismiss.addEventListener("click", () => {
    if (suggestionActionInFlight) return
    void runSuggestionAction("/suggestion/dismiss", suggestion.label)
  })
  actions.append(send, dismiss)
  const details = expandableText(`suggestion:${suggestion.label}`, "Read suggestion", suggestion.text, "fm-suggestion-details")
  const copyFeedback = text("")
  const copy = button("Copy suggestion", () => {
    if (typeof host.writeClipboard !== "function") return
    void host.writeClipboard(suggestion.text).then(() => { copyFeedback.textContent = "Copied." }).catch(() => { copyFeedback.textContent = "Copy failed; select and copy the text above." })
  }, typeof host.writeClipboard !== "function")
  copy.title = typeof host.writeClipboard === "function" ? "Copy the full suggestion text." : "Clipboard is unavailable; select and copy the expanded text."
  details.append(copy, copyFeedback)
  row.append(label, actions, details)
  return row
}

let suggestionActionInFlight = false

async function runSuggestionAction(pathname: string, label: string): Promise<void> {
  const registration = activeRegistration
  const sendsMessage = pathname === "/suggestion/send"
  if (registration === null || suggestionActionInFlight || (sendsMessage && captainSendInFlight !== null)) return
  if (sendsMessage) captainSendInFlight = registration
  suggestionActionInFlight = true
  dispatch({ type: "suggestion-action-started" })
  try {
    const result = await host.serviceRequest({
      method: "POST",
      path: pathname,
      body: JSON.stringify({ slug: registration.slug, label }),
    })
    // The captain may have switched projects while the action was in flight;
    // a stale answer must not land as feedback on the new project.
    if (activeRegistration !== registration) return
    if (result.status !== 200) {
      let message = `The action failed (status ${result.status}).`
      try {
        const parsed = JSON.parse(result.body) as { error?: string }
        if (parsed.error !== undefined) message = parsed.error
      } catch {
        // A non-JSON body only matters through the generic message above.
      }
      dispatch({ type: "suggestion-action-settled", feedback: message })
      return
    }
    let parsed: { warning?: string } = {}
    try {
      parsed = JSON.parse(result.body) as { warning?: string }
    } catch {
      // A plain 200 without a body is a clean success.
    }
    dispatch({ type: "suggestion-action-settled", feedback: parsed.warning })
  } catch {
    if (activeRegistration !== registration) return
    dispatch({ type: "suggestion-action-settled", feedback: "The action failed: the service is unreachable." })
  } finally {
    if (activeRegistration === registration) {
      if (sendsMessage) captainSendInFlight = null
      suggestionActionInFlight = false
      render(state)
      void fetchSuggestions()
    }
  }
}

// The panel re-renders on every dispatch — including the periodic refetches —
// which would wipe a half-typed editor. The open schedule editor or creation
// form and its drafts therefore live here, module-level on purpose: the
// reducer models the watches the service reports, not the captain's typing.
// The state is one slot, so exactly one editor or form is open at a time, and
// it is cleared on close and on success.
type WatchFormState =
  | { kind: "closed" }
  | { kind: "edit"; watchKey: string; schedule: string; feedback?: string; inFlight: boolean }
  | { kind: "create"; name: string; schedule: string; command: string; feedback?: string; inFlight: boolean }

let watchFormState: WatchFormState = { kind: "closed" }

const watchFormKey = (watch: WatchRow): string => `${watch.source}\n${watch.name}`

const defaultNewWatchSchedule = "*/30 * * * *"

// The Watches card sits below the board columns: one row per watch with its
// schedule, last run, last outcome, an on/off switch, and the expandable last
// output. The service runs watches only while the extension runs — the copy
// says so plainly rather than implying coverage that does not exist. The
// header row carries the New watch button, which opens the creation form and
// closes any open editor — the module state is a single slot.
function watchesCard(state: PanelState & { kind: "registered" }): HTMLElement {
  const section = document.createElement("section")
  const heading = collapsibleHeading("watches", "Watches")
  if (collapsedSections.has("watches")) {
    section.append(heading)
    return section
  }
  const headerRow = document.createElement("div")
  headerRow.className = "fm-watch-header"
  headerRow.append(heading)
  if (watchFormState.kind !== "create") headerRow.append(newWatchButton())
  section.append(headerRow)
  section.append(
    text(
      "Watches run only while OpenChamber is running. A run whose time passed while the machine was asleep fires once, late; runs missed while OpenChamber was closed are never made up.",
    ),
  )
  const history = watchNotesHistory()
  if (history !== null) section.append(history)
  const formState = watchFormState
  if (formState.kind === "create") section.append(watchCreateForm(formState))
  if (state.watchesError !== undefined) {
    if (state.watches !== undefined) {
      section.append(text(`${state.watchesError} — showing the last read watches.`))
    } else {
      section.append(text(state.watchesError))
      return section
    }
  }
  if (state.watches === undefined) {
    section.append(text("Reading the watches…"))
    return section
  }
  if (state.watches.length === 0) {
    section.append(text("No watches. Add an executable script with a `# schedule:` comment to the home's watches/ directory."))
    return section
  }
  // The service's top-level delivery summary shows only when no row can show
  // its own delivery error — the per-row badge is the detail; a summary on
  // top of it would say the same thing twice.
  if (state.watchesDeliveryError !== undefined && !state.watches.some((watch) => watch.deliveryError !== undefined)) {
    section.append(warningCallout(state.watchesDeliveryError))
  }
  for (const watch of state.watches) section.append(watchRow(watch))
  return section
}

function watchRow(watch: WatchRow): HTMLElement {
  const article = document.createElement("article")
  article.className = "fm-card"
  const title = document.createElement("strong")
  title.textContent = watch.name
  const source = document.createElement("span")
  mountBadge(source, { label: watch.source, tone: "neutral" })
  article.append(title, source, enabledSwitch(watch))
  // Human-readable schedule first, with the raw cron expression always
  // visible beside it — no hover required. When the two are identical (the
  // expression's shape has no human phrasing), it shows once.
  const schedule = document.createElement("span")
  schedule.className = "fm-schedule"
  const humanSchedule = formatSchedule(watch.schedule)
  if (humanSchedule === watch.schedule) {
    schedule.textContent = watch.schedule
  } else {
    const cron = document.createElement("span")
    cron.className = "fm-schedule-cron"
    cron.textContent = watch.schedule
    schedule.append(document.createTextNode(humanSchedule), cron)
  }
  schedule.title = watch.schedule
  article.append(schedule)
  const summary = document.createElement("span")
  summary.className = "fm-landing-meta"
  // The next scheduled run: relative while near, absolute when far out,
  // "paused" without one; the full timestamp rides on hover.
  const nextRun = metaValue(nextRunLabel(watch.nextRun, Date.now()))
  const nextRunFull = nextRunTitle(watch.nextRun)
  if (nextRunFull !== undefined) nextRun.title = nextRunFull
  summary.append(
    metaPiece("last run", metaValue(formatLastRun(watch.lastRunAt))),
    metaPiece("outcome", metaValue(watchOutcomeLabel(watch))),
    nextRun,
  )
  if (watch.error !== undefined) summary.append(warningBadge(watch.error))
  if (watch.lastError !== undefined) summary.append(warningBadge(`run failed: ${watch.lastError}`))
  if (watch.deliveryError !== undefined) summary.append(warningBadge(`coordinator delivery failed: ${watch.deliveryError}`))
  article.append(summary)
  if (watch.lastOutput !== undefined) article.append(lastOutput(watch.lastOutput))
  const formState = watchFormState
  if (formState.kind === "edit" && formState.watchKey === watchFormKey(watch)) {
    article.append(watchScheduleEditor(watch, formState))
  } else {
    article.append(watchEditRow(watch))
  }
  article.append(watchRunRow(watch))
  return article
}

// One small affordance per card: Edit opens the schedule editor on the card
// itself, closing any other open editor or form — the module state is a
// single slot.
function watchEditRow(watch: WatchRow): HTMLElement {
  const row = document.createElement("div")
  row.className = "fm-actions"
  const edit = document.createElement("button")
  edit.className = "fm-button"
  edit.textContent = "Edit"
  edit.title = "Edit this watch's schedule."
  edit.setAttribute("aria-label", `Edit watch ${watch.name}`)
  edit.addEventListener("click", () => {
    watchFormState = {
      kind: "edit",
      watchKey: watchFormKey(watch),
      schedule: watch.schedule,
      inFlight: false,
    }
    render(state)
  })
  row.append(edit)
  return row
}

// Manual runs: the in-flight marker and the per-watch feedback message live
// here, module level, keyed by registration and watch — the DOM is rebuilt on
// every dispatch, so live elements could carry neither across a background
// rerender. Keys include the coordinator session id, so a re-registration of
// the same slug can never mistake an old run's settle for its own feedback.
const watchRunsInFlight = new Map<string, RegistrationInfo>()

const watchRunMessages = new Map<string, string>()

function watchRunKey(registration: RegistrationInfo, watch: WatchRow): string {
  return `${registration.coordinatorSessionId}\n${watch.source}\n${watch.name}`
}

function watchRunRow(watch: WatchRow): HTMLElement {
  const row = document.createElement("div")
  row.className = "fm-actions"
  const run = document.createElement("button")
  run.className = "fm-button"
  run.textContent = "Run now"
  run.setAttribute("aria-label", `Run watch ${watch.name} now`)
  run.title = "Run this watch once now; a manual run works even while the schedule switch is off."
  // A watch whose schedule does not parse can never run — the service would
  // refuse it — so the button stays disabled and says why.
  if (watch.error !== undefined) {
    run.disabled = true
    run.title = `This watch's schedule does not parse, so it cannot run: ${watch.error}`
  }
  const registration = activeRegistration
  const key = registration === null ? undefined : watchRunKey(registration, watch)
  // The marker lives outside the DOM on purpose: a background refetch
  // rebuilds this row mid-run, and the rebuilt button must still be disabled.
  if (key !== undefined && watchRunsInFlight.has(key)) run.disabled = true
  run.addEventListener("click", () => {
    const clickRegistration = activeRegistration
    if (clickRegistration === null) return
    const runKey = watchRunKey(clickRegistration, watch)
    // Duplicate-press guard, checked before any await.
    if (watchRunsInFlight.has(runKey)) return
    watchRunsInFlight.set(runKey, clickRegistration)
    run.disabled = true
    void runWatchNow(clickRegistration, watch, runKey)
  })
  const feedback = document.createElement("span")
  feedback.className = "fm-feedback"
  feedback.textContent = key === undefined ? "" : watchRunMessages.get(key) ?? ""
  row.append(run, feedback)
  return row
}

async function runWatchNow(registration: RegistrationInfo, watch: WatchRow, key: string): Promise<void> {
  let feedback: string
  try {
    const result = await host.serviceRequest({
      method: "POST",
      path: "/watch/run",
      body: JSON.stringify({ slug: registration.slug, name: watch.name, source: watch.source }),
    })
    let parsed: { lastOutcome?: string; lastError?: string; deliveryError?: string; error?: string } = {}
    try {
      parsed = JSON.parse(result.body) as typeof parsed
    } catch {
      // A non-JSON body only matters through the generic messages below.
    }
    if (result.status !== 200) {
      feedback = parsed.error ?? `Running the watch failed (status ${result.status}).`
    } else if (parsed.lastOutcome === "failed") {
      // A failed script is still a completed run: the reason is the message,
      // never a generic success.
      feedback = `Watch failed: ${parsed.lastError ?? "the run failed"}`
    } else if (parsed.deliveryError !== undefined) {
      feedback = `Ran; coordinator delivery failed: ${parsed.deliveryError}`
    } else {
      feedback = "Ran."
    }
  } catch {
    feedback = "Running the watch failed: the service is unreachable."
  }
  watchRunsInFlight.delete(key)
  // Feedback lands only on the project that pressed the button; a stale
  // settle after a directory switch changes nothing for the new project.
  if (activeRegistration === registration) {
    watchRunMessages.set(key, feedback)
    render(state)
  }
  // The refetch carries the run's authoritative outcome back; it is a
  // background fetch and does not reset the manual-refresh age.
  void fetchWatches()
}

// The schedule editor rendered on the card itself: a raw cron input with a
// live human preview, the script's path, and Save / Cancel. Every field
// restores from the module draft on each render, so a background refetch
// cannot erase what the captain is typing; the input events write it back.
function watchScheduleEditor(watch: WatchRow, formState: WatchFormState & { kind: "edit" }): HTMLElement {
  const editor = document.createElement("div")
  editor.className = "fm-watch-editor"
  const scheduleInput = document.createElement("input")
  scheduleInput.type = "text"
  scheduleInput.value = formState.schedule
  scheduleInput.placeholder = defaultNewWatchSchedule
  scheduleInput.setAttribute("aria-label", `Schedule for watch ${watch.name}`)
  const preview = document.createElement("span")
  preview.className = "fm-schedule"
  preview.textContent = formatSchedule(formState.schedule)
  scheduleInput.addEventListener("input", () => {
    formState.schedule = scheduleInput.value
    preview.textContent = formatSchedule(scheduleInput.value)
  })
  editor.append(scheduleInput, preview)
  if (watch.path !== undefined) {
    // The script's absolute path: muted, selectable text, so it can be read
    // and copied but never reads as a link.
    const scriptPath = document.createElement("code")
    scriptPath.className = "fm-watch-path"
    scriptPath.textContent = watch.path
    editor.append(scriptPath)
  }
  const actions = document.createElement("div")
  actions.className = "fm-actions"
  const save = document.createElement("button")
  save.className = "fm-button"
  save.textContent = "Save"
  save.title = "Write the new schedule into the script's `# schedule:` line."
  save.disabled = formState.inFlight
  save.addEventListener("click", () => {
    if (formState.inFlight) return
    void saveWatchSchedule(watch, formState)
  })
  const cancel = document.createElement("button")
  cancel.className = "fm-button"
  cancel.textContent = "Cancel"
  cancel.addEventListener("click", () => {
    watchFormState = { kind: "closed" }
    render(state)
  })
  const feedback = document.createElement("span")
  feedback.className = "fm-feedback"
  feedback.textContent = formState.feedback ?? ""
  actions.append(save, cancel, feedback)
  editor.append(actions)
  return editor
}

// Save posts the raw cron expression; the service is the authority on whether
// it parses, and its error text is the feedback. Success closes the editor;
// the refetch carries the file's new schedule back.
async function saveWatchSchedule(watch: WatchRow, formState: WatchFormState & { kind: "edit" }): Promise<void> {
  const registration = activeRegistration
  if (registration === null) return
  formState.inFlight = true
  formState.feedback = undefined
  render(state)
  try {
    const result = await host.serviceRequest({
      method: "POST",
      path: "/watch/schedule",
      body: JSON.stringify({
        slug: registration.slug,
        name: watch.name,
        source: watch.source,
        schedule: formState.schedule,
      }),
    })
    if (activeRegistration !== registration) return
    let parsed: { error?: string } = {}
    try {
      parsed = JSON.parse(result.body) as { error?: string }
    } catch {
      // A non-JSON body only matters through the generic message below.
    }
    if (result.status !== 200) {
      formState.inFlight = false
      formState.feedback = parsed.error ?? `Saving the schedule failed (status ${result.status}).`
      render(state)
      return
    }
    watchFormState = { kind: "closed" }
    render(state)
  } catch {
    if (activeRegistration !== registration) return
    formState.inFlight = false
    formState.feedback = "Saving the schedule failed: the service is unreachable."
    render(state)
  } finally {
    void fetchWatches()
  }
}

// The header's New watch button opens the creation form on the section
// itself, closing any open editor — the module state is a single slot.
function newWatchButton(): HTMLElement {
  const button = document.createElement("button")
  button.className = "fm-button"
  button.textContent = "New watch"
  button.title = "Add a watch script to this project's watches folder."
  button.addEventListener("click", () => {
    if (watchFormState.kind === "create") return
    watchFormState = { kind: "create", name: "", schedule: defaultNewWatchSchedule, command: "", inFlight: false }
    render(state)
  })
  return button
}

// The creation form under the section header: name, schedule, and command.
// Like the schedule editor, every field restores from the module draft on
// each render.
function watchCreateForm(formState: WatchFormState & { kind: "create" }): HTMLElement {
  const form = document.createElement("div")
  form.className = "fm-watch-editor"
  const nameInput = document.createElement("input")
  nameInput.type = "text"
  nameInput.value = formState.name
  nameInput.placeholder = "watch name, e.g. daily-check"
  nameInput.setAttribute("aria-label", "Watch name")
  nameInput.addEventListener("input", () => {
    formState.name = nameInput.value
  })
  const scheduleInput = document.createElement("input")
  scheduleInput.type = "text"
  scheduleInput.value = formState.schedule
  scheduleInput.placeholder = defaultNewWatchSchedule
  scheduleInput.setAttribute("aria-label", "Schedule (cron expression)")
  const preview = document.createElement("span")
  preview.className = "fm-schedule"
  preview.textContent = formatSchedule(formState.schedule)
  scheduleInput.addEventListener("input", () => {
    formState.schedule = scheduleInput.value
    preview.textContent = formatSchedule(scheduleInput.value)
  })
  const commandInput = document.createElement("input")
  commandInput.type = "text"
  commandInput.value = formState.command
  commandInput.placeholder = "command to run, e.g. echo hello"
  commandInput.setAttribute("aria-label", "Command")
  commandInput.addEventListener("input", () => {
    formState.command = commandInput.value
  })
  form.append(nameInput, scheduleInput, preview, commandInput)
  const actions = document.createElement("div")
  actions.className = "fm-actions"
  const create = document.createElement("button")
  create.className = "fm-button"
  create.textContent = "Create"
  create.title = "Write the watch script into the project's watches folder."
  create.disabled = formState.inFlight
  create.addEventListener("click", () => {
    if (formState.inFlight) return
    void createWatchRequest(formState)
  })
  const cancel = document.createElement("button")
  cancel.className = "fm-button"
  cancel.textContent = "Cancel"
  cancel.addEventListener("click", () => {
    watchFormState = { kind: "closed" }
    render(state)
  })
  const feedback = document.createElement("span")
  feedback.className = "fm-feedback"
  feedback.textContent = formState.feedback ?? ""
  actions.append(create, cancel, feedback)
  form.append(actions)
  return form
}

// Create posts the form; the service validates the name, the schedule, and
// the command, and its error text is the feedback. Success closes the form;
// the refetch lists the new watch.
async function createWatchRequest(formState: WatchFormState & { kind: "create" }): Promise<void> {
  const registration = activeRegistration
  if (registration === null) return
  formState.inFlight = true
  formState.feedback = undefined
  render(state)
  try {
    const result = await host.serviceRequest({
      method: "POST",
      path: "/watch/create",
      body: JSON.stringify({
        slug: registration.slug,
        name: formState.name.trim(),
        schedule: formState.schedule.trim(),
        command: formState.command.trim(),
      }),
    })
    if (activeRegistration !== registration) return
    let parsed: { error?: string } = {}
    try {
      parsed = JSON.parse(result.body) as { error?: string }
    } catch {
      // A non-JSON body only matters through the generic message below.
    }
    if (result.status !== 200) {
      formState.inFlight = false
      formState.feedback = parsed.error ?? `Creating the watch failed (status ${result.status}).`
      render(state)
      return
    }
    watchFormState = { kind: "closed" }
    render(state)
  } catch {
    if (activeRegistration !== registration) return
    formState.inFlight = false
    formState.feedback = "Creating the watch failed: the service is unreachable."
    render(state)
  } finally {
    void fetchWatches()
  }
}

function enabledSwitch(watch: WatchRow): HTMLElement {
  const checkbox = document.createElement("input")
  checkbox.type = "checkbox"
  checkbox.checked = watch.enabled
  checkbox.setAttribute("aria-label", `Enable watch ${watch.name}`)
  checkbox.addEventListener("change", () => {
    const registration = activeRegistration
    if (registration === null) return
    void toggleWatch(registration, watch, checkbox.checked)
  })
  return checkbox
}

async function toggleWatch(registration: RegistrationInfo, watch: WatchRow, enabled: boolean): Promise<void> {
  try {
    const result = await host.serviceRequest({
      method: "POST",
      path: "/watches/toggle",
      body: JSON.stringify({ slug: registration.slug, name: watch.name, source: watch.source, enabled }),
    })
    if (result.status !== 200) {
      let message = `Toggling the watch failed (status ${result.status}).`
      try {
        const parsed = JSON.parse(result.body) as { error?: string }
        if (parsed.error !== undefined) message = parsed.error
      } catch {
        // A non-JSON body only matters through the generic message above.
      }
      dispatch({ type: "watches-failed", message })
    }
  } catch {
    dispatch({ type: "watches-failed", message: "Toggling the watch failed: the service is unreachable." })
  } finally {
    void fetchWatches()
  }
}

function lastOutput(output: string): HTMLElement {
  const details = document.createElement("details")
  const summary = document.createElement("summary")
  summary.textContent = "Last output"
  const pre = document.createElement("pre")
  pre.textContent = output
  details.append(summary, pre)
  return details
}
