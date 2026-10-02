import { connectHost } from "@openchamber/sdk"
import { applyHostReady, mountBadge, type Tone } from "@openchamber/sdk/ui"
import { parseBoardWorkers, type BoardCard, type BoardColumn } from "./board"
import { initialPanelState, reducePanelState, type Board, type PanelEvent, type PanelState, type RegistrationInfo } from "./state"

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
  void ensureSessionsSubscription(registration)
  boardRefreshTimer = window.setInterval(() => {
    void fetchBoard()
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
    const project = projects.projects.find((candidate) => candidate.directory === currentDirectory)
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
      root.append(coordinatorRow(state.registration, state.coordinatorTitle))
      root.append(boardView(state.board))
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

function coordinatorRow(registration: RegistrationInfo, coordinatorTitle: string | undefined): HTMLElement {
  const row = document.createElement("p")
  row.textContent =
    coordinatorTitle === undefined
      ? `Coordinator session ${registration.coordinatorSessionId}`
      : `${coordinatorTitle} (session ${registration.coordinatorSessionId})`
  row.append(openChatButton(registration.coordinatorSessionId))
  return row
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
// the relaunch itself); End archives the card in extension state — the
// session and worktree are left exactly as they are. Feedback stays local to
// the card; the board refetch after the request settles carries any state
// change.
type ActionFeedback = (message: string) => void

function actionFeedback(): { element: HTMLElement; say: ActionFeedback } {
  const element = document.createElement("span")
  return { element, say: (message) => { element.textContent = message } }
}

async function runCardAction(pathname: string, body: Record<string, string>, say: ActionFeedback, successMessage: string): Promise<void> {
  const registration = activeRegistration
  if (registration === null) return
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
      return
    }
    // A 200 with a warning still succeeded (e.g. the steer reached the worker
    // but the coordinator could not be told); the captain sees the caveat.
    say(parsed.warning ?? successMessage)
  } catch {
    say("The service is unreachable.")
  } finally {
    void fetchBoard()
  }
}

function cardActions(card: BoardCard): HTMLElement {
  const row = document.createElement("div")
  const { element, say } = actionFeedback()
  row.append(watchButton(card), steerControl(card, say), relaunchControl(card, say), endButton(card, say), element)
  return row
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
