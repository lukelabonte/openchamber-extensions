import { connectHost } from "@openchamber/sdk"
import { applyHostReady, mountBadge, type Tone } from "@openchamber/sdk/ui"
import { parseBoardWorkers, type BoardCard, type BoardColumn } from "./board"
import { parseShipping, shippingBadgeLabel, type LandingRow, type ShippingInfo } from "./shipping"
import { parseSuggestions, type SuggestionRow } from "./suggestions"
import { initialPanelState, reducePanelState, type Board, type PanelEvent, type PanelState, type RegistrationInfo } from "./state"
import { formatLastRun, parseWatches, watchOutcomeLabel, type WatchRow } from "./watches"

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
  void fetchBoard()
  void fetchWatches()
  void fetchShipping()
  void fetchSuggestions()
  void ensureSessionsSubscription(registration)
  boardRefreshTimer = window.setInterval(() => {
    void fetchBoard()
    void fetchWatches()
    void fetchShipping()
    void fetchSuggestions()
    // While the live subscription is unattached (transient host failures),
    // every refresh tick is also a re-attach attempt.
    void ensureSessionsSubscription(registration)
  }, boardRefreshIntervalMs)
}

function stopBoardFlow(): void {
  activeRegistration = null
  unsubscribeSessions?.()
  unsubscribeSessions = null
  if (boardRefreshTimer !== null) window.clearInterval(boardRefreshTimer)
  boardRefreshTimer = null
  if (boardFetchTimer !== null) window.clearTimeout(boardFetchTimer)
  boardFetchTimer = null
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
  root.append(heading())

  switch (state.kind) {
    case "loading":
      root.append(text("Reading the project…"))
      break
    case "no-directory":
      root.append(text("Open a project to launch its first mate."))
      break
    case "unregistered":
      root.append(text("This project has no first mate yet."), launchButton())
      break
    case "launching":
      root.append(text("Launching the first mate…"))
      break
    case "registered":
      root.append(coordinatorRow(state.registration, state.coordinatorTitle, state.shipping))
      if (state.shipping !== undefined) root.append(landingsSection(state.shipping))
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

function heading(): HTMLElement {
  const heading = document.createElement("h1")
  heading.textContent = "FirstMate"
  return heading
}

function text(contents: string): HTMLElement {
  const paragraph = document.createElement("p")
  paragraph.textContent = contents
  return paragraph
}

function launchButton(): HTMLElement {
  const button = document.createElement("button")
  button.textContent = "Launch first mate"
  button.addEventListener("click", () => {
    if (currentDirectory !== null) {
      void launch(currentDirectory)
    }
  })
  return button
}

function coordinatorRow(
  registration: RegistrationInfo,
  coordinatorTitle: string | undefined,
  shipping: ShippingInfo | undefined,
): HTMLElement {
  const row = document.createElement("p")
  row.textContent =
    coordinatorTitle === undefined
      ? `Coordinator session ${registration.coordinatorSessionId}`
      : `${coordinatorTitle} (session ${registration.coordinatorSessionId})`
  if (shipping !== undefined) row.append(shippingBadge(shipping))
  row.append(openChatButton(registration.coordinatorSessionId))
  row.append(bearingsControl(registration), ahoyButton(registration))
  return row
}

// /bearings and /ahoy reach the coordinator verbatim through POST /command —
// the panel composes nothing. The checkbox sends the variant that also
// writes the dated report into the home's reports/ directory; the answer
// arrives in the coordinator's chat, which Open chat opens.
function bearingsControl(registration: RegistrationInfo): HTMLElement {
  const control = document.createElement("span")
  const checkbox = document.createElement("input")
  checkbox.type = "checkbox"
  checkbox.setAttribute("aria-label", "Write the bearings report to a dated file")
  const button = document.createElement("button")
  button.textContent = "Bearings"
  button.addEventListener("click", () => {
    void sendCommand(registration, checkbox.checked ? "bearings-file" : "bearings")
  })
  control.append(checkbox, button)
  return control
}

function ahoyButton(registration: RegistrationInfo): HTMLElement {
  const button = document.createElement("button")
  button.textContent = "Ahoy"
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
function shippingBadge(shipping: ShippingInfo): HTMLElement {
  const badge = document.createElement("span")
  mountBadge(badge, {
    label: shippingBadgeLabel(shipping),
    tone: shipping.mode === null ? "warning" : "neutral",
  })
  return badge
}

function openChatButton(sessionId: string): HTMLElement {
  const button = document.createElement("button")
  button.textContent = "Open chat"
  // The sandboxed iframe cannot open the session itself; the host does it.
  button.addEventListener("click", () => {
    void host.openSession(sessionId)
  })
  return button
}

// Recent landings: the records the service parsed out of reports/landings.md,
// with a prominent warning for every entry it had to drop — a partly corrupt
// log must never read as a clean, empty one. The payload fields are untrusted
// file contents, so they reach the DOM only through textContent.
function landingsSection(shipping: ShippingInfo): HTMLElement {
  const section = document.createElement("section")
  const heading = document.createElement("h2")
  heading.textContent = "Recent landings"
  section.append(heading)
  for (const error of shipping.landingErrors) section.append(warningBadge(error))
  if (shipping.landings.length === 0) {
    if (shipping.landingErrors.length === 0) section.append(text("No landings."))
    return section
  }
  for (const landing of shipping.landings) section.append(landingRow(landing))
  return section
}

function landingRow(landing: LandingRow): HTMLElement {
  const row = document.createElement("p")
  row.textContent = `${landing.task} — commit ${landing.commit} — CI ${landing.ci} — mode ${landing.mode} — ${landing.authorization} — landed ${landing.landedAt}`
  return row
}

function boardView(board: Board): HTMLElement {
  const container = document.createElement("div")
  switch (board.kind) {
    case "loading":
      container.append(text("Reading the board…"))
      break
    case "error":
      container.append(text(board.message))
      break
    case "ready":
      if (board.refreshing) container.append(text("Refreshing…"))
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
  const heading = document.createElement("h2")
  heading.textContent = column.id
  section.append(heading)
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
  const title = document.createElement("strong")
  title.textContent = card.title
  article.append(title, stateBadge(card))
  if (card.warning !== undefined) article.append(warningBadge(card.warning))
  if (card.lastWord !== undefined) article.append(text(card.lastWord))
  if (card.prUrl !== undefined) article.append(prLink(card))
  article.append(cardActions(card))
  return article
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

function prLink(card: BoardCard): HTMLElement {
  const button = document.createElement("button")
  button.textContent = "Open pull request"
  button.disabled = card.prOpenable !== true
  // The sandboxed iframe cannot open links itself; the host opens it.
  button.addEventListener("click", () => {
    if (card.prOpenable === true && card.prUrl !== undefined) void host.openUrl(card.prUrl)
  })
  return button
}

// Card actions: Watch opens the worker session in the host; Steer and
// Relaunch relay through the service (the coordinator owns the backlog and
// the relaunch itself); Interrupt asks the service to stop the worker's
// current turn; End archives the card in extension state — the session and
// worktree are left exactly as they are. Feedback stays local to the card;
// the board refetch after the request settles carries any state change.
type ActionFeedback = (message: string) => void

function actionFeedback(): { element: HTMLElement; say: ActionFeedback } {
  const element = document.createElement("span")
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
  button.textContent = "Interrupt"
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
  button.textContent = "Watch"
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
  send.textContent = "Steer"
  // A Done worker is off the board's working set; steering it makes no sense.
  // Send stays disabled until the captain has typed something.
  const updateSend = (): void => {
    send.disabled = input.value.trim() === "" || card.sessionId === undefined || card.state === "Done"
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
  control.append(input, send)
  return control
}

function relaunchControl(card: BoardCard, say: ActionFeedback): HTMLElement {
  const input = document.createElement("input")
  input.type = "text"
  input.placeholder = "Note for the relaunch…"
  const send = document.createElement("button")
  send.textContent = "Relaunch"
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
  button.textContent = "End"
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
// one button per suggestion — pressed to send the suggestion's text to the
// coordinator — with a trash button that dismisses it unsent. The refetch
// after each call carries the file's new state; the line the service removed
// stops rendering. Action feedback lives in its own persistent slot so the
// refetch that follows every action cannot erase why the line stayed.
function suggestionsSection(state: PanelState & { kind: "registered" }): HTMLElement {
  const section = document.createElement("section")
  const heading = document.createElement("h2")
  heading.textContent = "Suggestions"
  section.append(heading)
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
  const send = document.createElement("button")
  send.textContent = suggestion.label
  send.title = suggestion.text
  send.disabled = actionPending
  // The in-flight flag is checked in the handler as well as via the disabled
  // attribute: a re-render between the click and the answer rebuilds the row
  // with fresh buttons, and only the flag can stop a repeat press.
  send.addEventListener("click", () => {
    if (suggestionActionInFlight) return
    void runSuggestionAction("/suggestion/send", suggestion.label)
  })
  const dismiss = document.createElement("button")
  dismiss.textContent = "Dismiss"
  dismiss.title = `Dismiss "${suggestion.label}" without sending`
  dismiss.setAttribute("aria-label", `Dismiss ${suggestion.label}`)
  dismiss.disabled = actionPending
  dismiss.addEventListener("click", () => {
    if (suggestionActionInFlight) return
    void runSuggestionAction("/suggestion/dismiss", suggestion.label)
  })
  row.append(send, dismiss)
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

// The Watches card sits below the board columns: one row per watch with its
// schedule, last run, last outcome, an on/off switch, and the expandable last
// output. The service runs watches only while the extension runs — the copy
// says so plainly rather than implying coverage that does not exist.
function watchesCard(state: PanelState & { kind: "registered" }): HTMLElement {
  const section = document.createElement("section")
  const heading = document.createElement("h2")
  heading.textContent = "Watches"
  section.append(heading)
  section.append(
    text(
      "Watches run only while OpenChamber is running. A run whose time passed while the machine was asleep fires once, late; runs missed while OpenChamber was closed are never made up.",
    ),
  )
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
  const title = document.createElement("strong")
  title.textContent = `${watch.name} (${watch.source})`
  article.append(title, enabledSwitch(watch))
  const summary = text(
    `${watch.schedule} — last run ${formatLastRun(watch.lastRunAt)} — ${watchOutcomeLabel(watch)}`,
  )
  if (watch.error !== undefined) summary.append(warningBadge(watch.error))
  article.append(summary)
  if (watch.lastOutput !== undefined) article.append(lastOutput(watch.lastOutput))
  return article
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
