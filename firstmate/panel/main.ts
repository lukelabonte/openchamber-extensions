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
