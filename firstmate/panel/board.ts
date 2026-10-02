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
  const { title, state, blockedReason, lastWord, prUrl, sessionId, worktree, branch, lastPollError } = record
  if (typeof title !== "string") return undefined
  if (typeof state !== "string" || !boardColumnOrder.includes(state as BoardWorkerState)) return undefined
  if (
    !isOptionalString(blockedReason) ||
    !isOptionalString(lastWord) ||
    !isOptionalString(prUrl) ||
    !isOptionalString(sessionId) ||
    !isOptionalString(worktree) ||
    !isOptionalString(branch) ||
    !isOptionalString(lastPollError)
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
  }
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
