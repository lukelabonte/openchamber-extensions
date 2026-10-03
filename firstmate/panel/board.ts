// Wire types and pure display mapping for the board the service serves at
// GET /board?slug=… . The service's poller is the authority on worker state;
// the panel only reshapes the payload for display and never execs anything.

export type BoardWorkerState = "Queued" | "Working" | "Blocked" | "Parked" | "Done" | "Failed" | "Idle"

export interface BoardWorker {
  title: string
  state: BoardWorkerState
  blockedReason?: "question" | "permission"
  lastWord?: string
  prUrl?: string
  sessionId?: string
  worktree?: string
  branch?: string
  lastPollError?: string
  /** ISO baseline of the service's cautious stall flag; advisory only. */
  possiblyStalledSince?: string
}

export interface BoardCard {
  title: string
  state: BoardWorkerState
  blockedReason?: "question" | "permission"
  lastWord?: string
  prUrl?: string
  /** True when the PR link is an http(s) URL the host can open. */
  prOpenable?: boolean
  warning?: string
  /** Present on dispatched workers; Watch and the action calls need it. */
  sessionId?: string
  /** The worker's worktree directory from the backlog record; Relaunch needs it. */
  worktree?: string
  /** The worker's branch from the backlog record; shown as the card's meta line. */
  branch?: string
  /** Advisory stall flag from the service; shown as an amber note, never as a state change. */
  possiblyStalledSince?: string
}

export interface BoardColumn {
  id: BoardWorkerState
  cards: BoardCard[]
}

export const boardColumnOrder: readonly BoardWorkerState[] = [
  "Queued",
  "Working",
  "Blocked",
  "Parked",
  "Done",
  "Failed",
  "Idle",
]

const cardTextMaxLength = 140

// Panel-side shape guard for the /board payload: a malformed worker entry is
// skipped and counted instead of poisoning the whole board or throwing inside
// the reducer.
export function parseBoardWorkers(value: unknown): { workers: BoardWorker[]; malformedCount: number } {
  if (!Array.isArray(value)) return { workers: [], malformedCount: 0 }
  const workers: BoardWorker[] = []
  let malformedCount = 0
  for (const entry of value) {
    const worker = parseBoardWorker(entry)
    if (worker === undefined) malformedCount += 1
    else workers.push(worker)
  }
  return { workers, malformedCount }
}

function parseBoardWorker(value: unknown): BoardWorker | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  const { title, state, blockedReason, lastWord, prUrl, sessionId, worktree, branch, lastPollError, possiblyStalledSince } = record
  if (typeof title !== "string") return undefined
  if (typeof state !== "string" || !boardColumnOrder.includes(state as BoardWorkerState)) return undefined
  if (
    !isOptionalString(blockedReason) ||
    !isOptionalString(lastWord) ||
    !isOptionalString(prUrl) ||
    !isOptionalString(sessionId) ||
    !isOptionalString(worktree) ||
    !isOptionalString(branch) ||
    !isOptionalString(lastPollError) ||
    !isOptionalString(possiblyStalledSince)
  ) {
    return undefined
  }
  if (blockedReason !== undefined && blockedReason !== "question" && blockedReason !== "permission") return undefined
  return {
    title,
    state: state as BoardWorkerState,
    ...(blockedReason !== undefined ? { blockedReason: blockedReason as BoardWorker["blockedReason"] } : {}),
    ...(lastWord !== undefined ? { lastWord } : {}),
    ...(prUrl !== undefined ? { prUrl } : {}),
    ...(sessionId !== undefined ? { sessionId } : {}),
    ...(worktree !== undefined ? { worktree } : {}),
    ...(branch !== undefined ? { branch } : {}),
    ...(lastPollError !== undefined ? { lastPollError } : {}),
    // A stall baseline that is not a finite, parseable timestamp is dropped
    // rather than displayed as a number-shaped lie.
    ...(possiblyStalledSince !== undefined && hasFiniteDate(possiblyStalledSince) ? { possiblyStalledSince } : {}),
  }
}

function hasFiniteDate(iso: string): boolean {
  return !Number.isNaN(new Date(iso).getTime())
}

function isOptionalString(value: unknown): value is string | undefined {
  return value === undefined || typeof value === "string"
}

export function toBoardCard(worker: BoardWorker): BoardCard {
  const trimmedTitle = worker.title.trim()
  const card: BoardCard = {
    title: trimmedTitle === "" ? "(untitled)" : trimmedTitle,
    state: worker.state,
    ...(worker.blockedReason !== undefined ? { blockedReason: worker.blockedReason } : {}),
  }
  const lastWord = optionalText(worker.lastWord)
  if (lastWord !== undefined) card.lastWord = lastWord
  const prUrl = worker.prUrl?.trim()
  if (prUrl !== undefined && prUrl !== "") {
    // A non-openable link stays on the card; the button renders disabled
    // rather than the field disappearing silently.
    card.prUrl = prUrl
    if (isHttpUrl(prUrl)) card.prOpenable = true
  }
  const warning = optionalText(worker.lastPollError)
  if (warning !== undefined) card.warning = warning
  if (worker.sessionId !== undefined) card.sessionId = worker.sessionId
  if (worker.worktree !== undefined) card.worktree = worker.worktree
  if (worker.branch !== undefined) card.branch = worker.branch
  if (worker.possiblyStalledSince !== undefined) card.possiblyStalledSince = worker.possiblyStalledSince
  return card
}

// Columns in fixed board order; a state without workers gets no column.
export function groupBoardColumns(workers: BoardWorker[]): BoardColumn[] {
  const cardsByState = new Map<BoardWorkerState, BoardCard[]>()
  for (const worker of workers) {
    const cards = cardsByState.get(worker.state) ?? []
    cards.push(toBoardCard(worker))
    cardsByState.set(worker.state, cards)
  }
  return boardColumnOrder.flatMap((id) => {
    const cards = cardsByState.get(id)
    return cards === undefined ? [] : [{ id, cards }]
  })
}

function optionalText(value: string | undefined): string | undefined {
  const trimmed = value?.trim()
  if (trimmed === undefined || trimmed === "") return undefined
  return truncate(trimmed)
}

function truncate(text: string): string {
  return text.length > cardTextMaxLength ? `${text.slice(0, cardTextMaxLength)}…` : text
}

function isHttpUrl(url: string): boolean {
  return /^https?:\/\//i.test(url)
}

// Supervision health: the state of the service's two host-observation
// channels plus the last clean poll's time, served at GET /board. "working"
// means the channel answered; it does NOT establish that no question or
// permission wait exists, and a failure may not be observed — the panel
// phrases it exactly that cautiously.
export type SupervisionObservationState = "working" | "degraded" | "unavailable"

export interface SupervisionHealth {
  blockedObservation: SupervisionObservationState
  blockedObservationReason?: string
  failureObservation: SupervisionObservationState
  failureObservationReason?: string
  lastSuccessfulPollAt?: string
}

// Panel-side shape guard for the supervision record: missing, malformed, or
// version-skewed payloads yield undefined, which renders as "Unknown" — never
// as a false healthy claim.
export function parseSupervision(value: unknown): SupervisionHealth | undefined {
  if (typeof value !== "object" || value === null) return undefined
  const record = value as Record<string, unknown>
  const blocked = parseObservation(record.blockedObservation, record.blockedObservationReason)
  const failure = parseObservation(record.failureObservation, record.failureObservationReason)
  if (blocked === undefined || failure === undefined) return undefined
  return {
    blockedObservation: blocked.state,
    ...(blocked.reason !== undefined ? { blockedObservationReason: blocked.reason } : {}),
    failureObservation: failure.state,
    ...(failure.reason !== undefined ? { failureObservationReason: failure.reason } : {}),
    // Only a parseable timestamp is kept; anything else reads as "not polled".
    ...(typeof record.lastSuccessfulPollAt === "string" && hasFiniteDate(record.lastSuccessfulPollAt)
      ? { lastSuccessfulPollAt: record.lastSuccessfulPollAt }
      : {}),
  }
}

function parseObservation(
  state: unknown,
  reason: unknown,
): { state: SupervisionObservationState; reason?: string } | undefined {
  if (state !== "working" && state !== "degraded" && state !== "unavailable") return undefined
  if (reason !== undefined && typeof reason !== "string") return undefined
  return { state, ...(typeof reason === "string" ? { reason } : {}) }
}
