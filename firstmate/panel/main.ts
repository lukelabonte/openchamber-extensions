import { connectHost } from "@openchamber/sdk"
import { applyHostReady, mountBadge, type Tone } from "@openchamber/sdk/ui"
import { parseBoardWorkers, type BoardCard, type BoardColumn } from "./board"
import { parseShipping, shippingBadgeLabel, type LandingRow, type ShippingInfo } from "./shipping"
import { parseSuggestions, type SuggestionRow } from "./suggestions"
import { initialPanelState, reducePanelState, type Board, type PanelEvent, type PanelState, type RegistrationInfo } from "./state"
import { formatLastRun, formatSchedule, nextRunLabel, nextRunTitle, parseWatches, watchOutcomeLabel, type WatchRow } from "./watches"

const host = connectHost()

const boardFetchDebounceMs = 1_000
const boardRefreshIntervalMs = 30_000

let state: PanelState = initialPanelState()
let currentDirectory: string | null = null
let activeRegistration: RegistrationInfo | null = null
let unsubscribeSessions: (() => void) | null = null
let sessionsAttachInFlight = false
let boardRefreshTimer: number | null = null
let boardFetchTimer: number | null = null
let refreshLabelTimer: number | null = null
let manualRefreshInFlight = false
let lastRefreshedAt: number | null = null

host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement)
  resetTo(ctx.directory)
})

// Replays the ready directory right after onReady; the equality guard makes
// that replay a no-op and a real directory change re-run the lookup flow.
host.onDirectory((directory) => {
  if (directory === currentDirectory) return
  resetTo(directory)
})

function resetTo(directory: string | null): void {
  stopBoardFlow()
  currentDirectory = directory
  state = initialPanelState()
  dispatch({ type: "directory-context", directory })
  if (directory !== null) {
    void lookup(directory)
  }
}

async function lookup(directory: string): Promise<void> {
  try {
    const result = await host.serviceRequest({ method: "GET", path: "/lookup", query: { directory } })
    // The captain may have switched projects while the lookup was in flight;
    // a stale answer must not start a board flow for the wrong directory.
    if (currentDirectory !== directory) return
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
    if (currentDirectory !== directory) return
    dispatch({ type: "lookup-failed", message: "Looking up the first mate failed: the service is unreachable." })
  }
}

async function launch(projectDirectory: string): Promise<void> {
  dispatch({ type: "launch-started" })
  try {
    const result = await host.serviceRequest({
      method: "POST",
      path: "/launch",
      body: JSON.stringify({ projectDirectory }),
    })
    if (currentDirectory !== projectDirectory) return
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
    if (currentDirectory !== projectDirectory) return
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
  void runFullRefresh(true)
  void ensureSessionsSubscription(registration)
  boardRefreshTimer = window.setInterval(() => {
    runFullRefresh(false)
    // While the live subscription is unattached (transient host failures),
    // every refresh tick is also a re-attach attempt.
    void ensureSessionsSubscription(registration)
  }, boardRefreshIntervalMs)
  // Keeps the header's relative freshness label current between ticks.
  refreshLabelTimer = window.setInterval(updateRefreshControl, boardRefreshIntervalMs)
}

function stopBoardFlow(): void {
  activeRegistration = null
  unsubscribeSessions?.()
  unsubscribeSessions = null
  if (boardRefreshTimer !== null) window.clearInterval(boardRefreshTimer)
  boardRefreshTimer = null
  if (boardFetchTimer !== null) window.clearTimeout(boardFetchTimer)
  boardFetchTimer = null
  if (refreshLabelTimer !== null) window.clearInterval(refreshLabelTimer)
  refreshLabelTimer = null
  manualRefreshInFlight = false
  lastRefreshedAt = null
  // A directory change (or re-registration) closes any open watch editor or
  // creation form; its drafts belonged to the previous project.
  watchFormState = { kind: "closed" }
}

// Attaches the live onSessions subscription for the registration's project.
// Transient failures (a listProjects rejection, a not-yet-ready snapshot)
// leave the panel unattached and are retried on the next refresh tick. A
// directory that is not an OpenChamber project has no session activity to
// mirror and stays a quiet no-op.
async function ensureSessionsSubscription(registration: RegistrationInfo): Promise<void> {
  if (unsubscribeSessions !== null || sessionsAttachInFlight || activeRegistration !== registration) return
  sessionsAttachInFlight = true
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
    sessionsAttachInFlight = false
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
// the initial mount and the manual click mark freshness (`markRefreshed`):
// the periodic cycle and the subscription-driven refetches must never reset
// the timestamp, so the label can age instead of being pinned at "just now".
async function runFullRefresh(markRefreshed: boolean): Promise<void> {
  await Promise.all([fetchBoard(), fetchWatches(), fetchShipping(), fetchSuggestions()])
  if (!markRefreshed) return
  lastRefreshedAt = Date.now()
  updateRefreshControl()
}

// A manual press marks the control ("Refreshing…" + disabled) for the run's
// duration and then reports the fresh age.
async function manualRefresh(): Promise<void> {
  manualRefreshInFlight = true
  updateRefreshControl()
  try {
    await runFullRefresh(true)
  } finally {
    manualRefreshInFlight = false
    updateRefreshControl()
  }
}

function refreshButton(): HTMLElement {
  const button = document.createElement("button")
  button.className = "fm-button fm-refresh"
  button.title = "Data refreshes automatically in the background; this shows the last manual refresh."
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
  // Before a freshly registered panel's first fetch settles there is no age
  // to report; the run is already under way, so say so.
  button.textContent = manualRefreshInFlight || lastRefreshedAt === null
    ? "Refreshing…"
    : refreshAgeLabel(lastRefreshedAt)
}

function refreshAgeLabel(timestamp: number): string {
  const elapsed = Date.now() - timestamp
  if (elapsed < 60_000) return "Refreshed just now"
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 60) return `Refreshed ${minutes}m ago`
  return `Refreshed ${Math.floor(minutes / 60)}h ago`
}

async function fetchBoard(): Promise<void> {
  const registration = activeRegistration
  if (registration === null) return
  try {
    const result = await host.serviceRequest({ method: "GET", path: "/board", query: { slug: registration.slug } })
    if (activeRegistration !== registration) return
    if (result.status !== 200) {
      dispatch({ type: "board-failed", message: `Reading the board failed (status ${result.status}).` })
      return
    }
    let body: { workers?: unknown; deliveryError?: string }
    try {
      body = JSON.parse(result.body) as { workers?: unknown; deliveryError?: string }
    } catch {
      dispatch({ type: "board-failed", message: "Reading the board failed: the service sent a malformed answer." })
      return
    }
    // Per-worker shape guard: malformed entries are skipped and counted here,
    // so the reducer never throws on a lying payload.
    const parsed = parseBoardWorkers(body.workers)
    dispatch({
      type: "board-loaded",
      workers: parsed.workers,
      malformedCount: parsed.malformedCount,
      deliveryError: body.deliveryError,
    })
  } catch {
    if (activeRegistration !== registration) return
    dispatch({ type: "board-failed", message: "Reading the board failed: the service is unreachable." })
  }
}

// Watches ride the same cadence as the board: one fetch on mount and one per
// refresh interval. The service is the authority; a toggle is only sent to
// it, and the refetch carries the authoritative switch state back.
async function fetchWatches(): Promise<void> {
  const registration = activeRegistration
  if (registration === null) return
  try {
    const result = await host.serviceRequest({ method: "GET", path: "/watches", query: { slug: registration.slug } })
    if (activeRegistration !== registration) return
    if (result.status !== 200) {
      dispatch({ type: "watches-failed", message: `Reading the watches failed (status ${result.status}).` })
      return
    }
    let body: { watches?: unknown }
    try {
      body = JSON.parse(result.body) as { watches?: unknown }
    } catch {
      dispatch({ type: "watches-failed", message: "Reading the watches failed: the service sent a malformed answer." })
      return
    }
    dispatch({ type: "watches-loaded", watches: parseWatches(body.watches) })
  } catch {
    if (activeRegistration !== registration) return
    dispatch({ type: "watches-failed", message: "Reading the watches failed: the service is unreachable." })
  }
}

// The shipping mode rides the same cadence as the board and the watches: one
// fetch on mount and one per refresh interval. A failed or malformed answer
// means no badge this round; the next tick retries.
async function fetchShipping(): Promise<void> {
  const registration = activeRegistration
  if (registration === null) return
  try {
    const result = await host.serviceRequest({ method: "GET", path: "/shipping", query: { slug: registration.slug } })
    if (activeRegistration !== registration) return
    if (result.status !== 200) return
    const shipping = parseShipping(JSON.parse(result.body))
    if (shipping !== undefined) dispatch({ type: "shipping-loaded", shipping })
  } catch {
    // Retried on the next refresh tick.
  }
}

// Suggestions ride the same cadence as the board, the watches, and the
// shipping badge: one fetch on mount and one per refresh interval. The
// service is the authority on suggestions.md; a send or dismiss is only sent
// to it, and the refetch carries the file's new state back.
async function fetchSuggestions(): Promise<void> {
  const registration = activeRegistration
  if (registration === null) return
  try {
    const result = await host.serviceRequest({ method: "GET", path: "/suggestions", query: { slug: registration.slug } })
    if (activeRegistration !== registration) return
    if (result.status !== 200) {
      dispatch({ type: "suggestions-failed", message: `Reading the suggestions failed (status ${result.status}).` })
      return
    }
    let body: { suggestions?: unknown }
    try {
      body = JSON.parse(result.body) as { suggestions?: unknown }
    } catch {
      dispatch({ type: "suggestions-failed", message: "Reading the suggestions failed: the service sent a malformed answer." })
      return
    }
    dispatch({ type: "suggestions-loaded", suggestions: parseSuggestions(body.suggestions) })
  } catch {
    if (activeRegistration !== registration) return
    dispatch({ type: "suggestions-failed", message: "Reading the suggestions failed: the service is unreachable." })
  }
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
      root.append(coordinatorRow(state.registration, state.coordinatorTitle, state.shipping))
      if (state.shipping !== undefined) root.append(landingsSection(state.shipping, state.board))
      root.append(suggestionsSection(state))
      root.append(boardView(state.board))
      root.append(watchesCard(state))
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
    if (currentDirectory !== null) {
      void launch(currentDirectory)
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
  header.append(name, project, actions)
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
  button.title =
    "Ask the coordinator to summarize what happened since your last exchange, with every open decision and a recommendation."
  button.addEventListener("click", () => {
    void sendCommand(registration, "ahoy")
  })
  return button
}

async function sendCommand(registration: RegistrationInfo, command: string): Promise<void> {
  try {
    await host.serviceRequest({
      method: "POST",
      path: "/command",
      body: JSON.stringify({ slug: registration.slug, command }),
    })
  } catch {
    // The service is unreachable; the next press retries.
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
  return row
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
      if (board.columns.length === 0) {
        container.append(text("The board is empty."))
      } else {
        for (const column of board.columns) container.append(boardColumn(column))
      }
      break
  }
  return container
}

function boardColumn(column: BoardColumn): HTMLElement {
  const section = document.createElement("section")
  section.append(collapsibleHeading(`column:${column.id}`, column.id))
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

function boardCard(card: BoardCard): HTMLElement {
  const article = document.createElement("article")
  article.className = "fm-card"
  const title = document.createElement("strong")
  title.textContent = card.title
  article.append(title, stateBadge(card))
  if (card.blockedReason !== undefined) article.append(blockedNote(card.blockedReason))
  if (card.warning !== undefined) article.append(warningBadge(card.warning))
  if (card.branch !== undefined) article.append(branchMeta(card.branch, card.worktree))
  if (card.lastWord !== undefined) article.append(lastWordLine(card.lastWord))
  if (card.prUrl !== undefined) article.append(prLink(card))
  if (card.sessionId === undefined) {
    // A card with no session (e.g. a task landed by direct PR merge) has
    // nothing for the action row to act on; a muted note says why instead of
    // a row of buttons disabled with no explanation.
    article.append(mutedNote("Merged directly — no worker session to act on."))
  } else {
    article.append(cardActions(card))
  }
  return article
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
  button.textContent = "Open PR on GitHub"
  button.title = "Open the pull request in your browser."
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
// worktree are left exactly as they are. Feedback stays local to the card;
// the board refetch after the request settles carries any state change.
type ActionFeedback = (message: string) => void

function actionFeedback(): { element: HTMLElement; say: ActionFeedback } {
  const element = document.createElement("span")
  element.className = "fm-feedback"
  return { element, say: (message) => { element.textContent = message } }
}

async function runCardAction(pathname: string, body: Record<string, string>, say: ActionFeedback, successMessage: string): Promise<{ status: number }> {
  const registration = activeRegistration
  if (registration === null) return { status: 0 }
  try {
    const result = await host.serviceRequest({
      method: "POST",
      path: pathname,
      body: JSON.stringify({ slug: registration.slug, ...body }),
    })
    let parsed: { error?: string; warning?: string } = {}
    try {
      parsed = JSON.parse(result.body) as { error?: string; warning?: string }
    } catch {
      // A non-JSON body only matters through the generic message below.
    }
    if (result.status !== 200) {
      say(parsed.error ?? `The action failed (status ${result.status}).`)
      return { status: result.status }
    }
    // A 200 with a warning still succeeded (e.g. the steer reached the worker
    // but the coordinator could not be told); the captain sees the caveat.
    say(parsed.warning ?? successMessage)
    return { status: result.status }
  } catch {
    say("The service is unreachable.")
    return { status: 0 }
  } finally {
    void fetchBoard()
  }
}

function cardActions(card: BoardCard): HTMLElement {
  const row = document.createElement("div")
  row.className = "fm-actions"
  const { element, say } = actionFeedback()
  row.append(watchButton(card), interruptButton(card, say), steerControl(card, say), relaunchControl(card, say), endButton(card, say), element)
  return row
}

// Interrupt rides a private-surface workaround (the managed opencode
// server's own abort call); hosts that do not offer it answer 501. Those
// session ids are remembered here so Interrupt stays disabled for the rest
// of the panel session — local DOM state on purpose: host capability is not
// board state, and the reducer does not model it.
const interruptUnsupportedSessions = new Set<string>()

function interruptButton(card: BoardCard, say: ActionFeedback): HTMLElement {
  const button = document.createElement("button")
  button.className = "fm-button"
  button.textContent = "Interrupt"
  button.title = "Stop the worker's current turn."
  button.disabled = card.sessionId === undefined || interruptUnsupportedSessions.has(card.sessionId)
  button.addEventListener("click", () => {
    const sessionId = card.sessionId
    if (sessionId === undefined) return
    button.disabled = true
    void runCardAction("/interrupt", { sessionId }, say, "Interrupt sent.").then((result) => {
      if (result.status === 501) {
        // Plain copy, no weaker substitute dressed up as equivalent: the
        // extension contract does not expose interrupt and this host
        // offered no fallback path.
        interruptUnsupportedSessions.add(sessionId)
        say("Interrupt is not exposed by OpenChamber's extension contract, and this host did not offer the fallback path.")
        return
      }
      button.disabled = false
    })
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

function steerControl(card: BoardCard, say: ActionFeedback): HTMLElement {
  const input = document.createElement("input")
  input.type = "text"
  input.placeholder = "Steer the worker…"
  const send = document.createElement("button")
  send.className = "fm-button"
  send.textContent = "Steer"
  // A Done worker is off the board's working set; steering it makes no sense.
  // Send stays disabled until the captain has typed something, and the
  // tooltip names the Done state instead of leaving the disabled button mute.
  const updateSend = (): void => {
    send.disabled = input.value.trim() === "" || card.sessionId === undefined || card.state === "Done"
    send.title = card.state === "Done"
      ? "This task is Done — relaunch the worker to continue."
      : "Send this message to the worker."
  }
  updateSend()
  input.addEventListener("input", updateSend)
  send.addEventListener("click", () => {
    const steerText = input.value.trim()
    if (card.sessionId === undefined || steerText === "") return
    input.disabled = true
    send.disabled = true
    void runCardAction("/steer", { sessionId: card.sessionId, text: steerText }, say, "Steered.").finally(() => {
      input.disabled = false
      updateSend()
    })
  })
  const control = document.createElement("span")
  control.className = "fm-steer"
  control.append(input, send)
  return control
}

function relaunchControl(card: BoardCard, say: ActionFeedback): HTMLElement {
  const input = document.createElement("input")
  input.type = "text"
  input.placeholder = "Note for the relaunch…"
  const send = document.createElement("button")
  send.className = "fm-button"
  send.textContent = "Relaunch"
  send.title = "Start a fresh worker in this task's worktree with your note."
  // The coordinator relaunches into the recorded worktree; without one the
  // service could not name where the fresh worker goes. The session id
  // identifies the backlog entry to supersede. Send stays disabled until the
  // captain has typed a note.
  const updateSend = (): void => {
    send.disabled = input.value.trim() === "" || card.sessionId === undefined || card.worktree === undefined
  }
  updateSend()
  input.addEventListener("input", updateSend)
  send.addEventListener("click", () => {
    const note = input.value.trim()
    if (card.sessionId === undefined || card.worktree === undefined || note === "") return
    input.disabled = true
    send.disabled = true
    void runCardAction("/relaunch", { sessionId: card.sessionId, note }, say, "Relaunch requested.").finally(() => {
      input.disabled = false
      updateSend()
    })
  })
  const control = document.createElement("span")
  control.append(input, send)
  return control
}

function endButton(card: BoardCard, say: ActionFeedback): HTMLElement {
  const button = document.createElement("button")
  button.className = "fm-button"
  button.textContent = "End"
  button.title = "Archive this card; the session and worktree are left as they are."
  button.disabled = card.sessionId === undefined
  // Two-click confirm instead of window.confirm: a sandboxed iframe without
  // allow-modals swallows dialogs silently.
  let armed = false
  button.addEventListener("click", () => {
    if (card.sessionId === undefined) return
    if (!armed) {
      armed = true
      button.textContent = "Really end?"
      return
    }
    armed = false
    button.textContent = "End"
    button.disabled = true
    void runCardAction("/end", { sessionId: card.sessionId }, say, "Archived.").finally(() => {
      button.disabled = card.sessionId === undefined
    })
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
  // The full suggestion text is longer than the label; it stays on hover.
  label.title = suggestion.text
  const actions = document.createElement("div")
  actions.className = "fm-suggestion-actions"
  const send = document.createElement("button")
  send.className = "fm-button"
  send.textContent = "Send"
  send.title = suggestion.text
  send.setAttribute("aria-label", `Send ${suggestion.label}`)
  send.disabled = actionPending
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
  row.append(label, actions)
  return row
}

let suggestionActionInFlight = false

async function runSuggestionAction(pathname: string, label: string): Promise<void> {
  const registration = activeRegistration
  if (registration === null || suggestionActionInFlight) return
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
    suggestionActionInFlight = false
    void fetchSuggestions()
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
  article.append(summary)
  if (watch.lastOutput !== undefined) article.append(lastOutput(watch.lastOutput))
  const formState = watchFormState
  if (formState.kind === "edit" && formState.watchKey === watchFormKey(watch)) {
    article.append(watchScheduleEditor(watch, formState))
  } else {
    article.append(watchEditRow(watch))
  }
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
