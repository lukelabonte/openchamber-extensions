import type { BacklogState, BacklogTask } from "./backlog"
import type { SessionLastAssistant, SessionStatus } from "./control-client"

// Board-state mapping. The backlog entry's `state:` field is the
// human/coordinator-owned record; the live session signals from polling only
// refine it. The board shows the refined view:
//
//   backlog          live signal                     board state
//   ---------------  ------------------------------  --------------------
//   Queued           not polled / unknown activity   Queued
//   Queued           idle                            Queued
//   Queued           running | retrying              Working
//   Queued           waiting-question                Blocked (question)
//   Queued           waiting-permission              Blocked (permission)
//   Queued, Working  outcome failed                  Failed
//   Working          not polled / unknown activity   Working
//   Working          running | retrying              Working
//   Working          waiting-question                Blocked (question)
//   Working          waiting-permission              Blocked (permission)
//   Working          idle + outcome completed        Working — completed never
//                                                    means the task is Done;
//                                                    only the coordinator's
//                                                    backlog record can say Done
//   Working          idle + no outcome               Idle
//   Blocked / Parked / Done / Failed / Idle          unchanged — the
//                                                    coordinator owns these
//                                                    states; polling never
//                                                    overrides them

export type BlockedReason = "question" | "permission"

export interface BoardState {
  state: BacklogState
  blockedReason?: BlockedReason
}

export interface WorkerObservation {
  status: SessionStatus
  lastWord?: string
  error?: string
  /** time.idle of the terminal outcome merged from the host's session info; distinguishes a second, distinct failed terminal from the same one re-observed. */
  terminalAt?: number
  /** The last assistant message's id, timestamps, and FULL text from the richer extraction — the signature source for the stall detector. */
  last?: SessionLastAssistant
  /**
   * ISO baseline time of the fixed 30-minute no-message-progress stall flag.
   * Present only while the flag is currently observable — a poll failure,
   * any non-running activity, or a new message signature drops it, so a
   * stale flag is never shown as current confidence.
   */
  possiblyStalledSince?: string
}

export interface BoardWorker {
  title: string
  state: BacklogState
  blockedReason?: BlockedReason
  lastWord?: string
  prUrl?: string
  sessionId?: string
  worktree?: string
  branch?: string
  lastPollError?: string
  /** ISO baseline of the cautious stall flag: >=30 minutes of no observed message progress on a continuously running worker. Advisory only — nothing stops automatically. */
  possiblyStalledSince?: string
}

const lastWordMaxLength = 280
export function mapBoardState(input: { backlogState: BacklogState; live?: SessionStatus }): BoardState {  const { backlogState, live } = input
  if (backlogState !== "Queued" && backlogState !== "Working") {
    return { state: backlogState }
  }
  if (live === undefined) return { state: backlogState }
  if (live.outcome === "failed") return { state: "Failed" }
  if (live.activity === "waiting-question") return { state: "Blocked", blockedReason: "question" }
  if (live.activity === "waiting-permission") return { state: "Blocked", blockedReason: "permission" }
  if (live.activity === "running" || live.activity === "retrying") return { state: "Working" }
  if (backlogState === "Working" && live.activity === "idle") {
    // outcome completed deliberately falls through to Working: the coordinator
    // must review and mark the task Done itself.
    return { state: live.outcome === "completed" ? "Working" : "Idle" }
  }
  return { state: backlogState }
}

export function buildBoardWorker(task: BacklogTask, observation?: WorkerObservation): BoardWorker {
  const refined =
    task.sessionId === undefined ? { state: task.state, blockedReason: undefined } : mapBoardState({ backlogState: task.state, live: observation?.status })
  const worker: BoardWorker = {
    title: task.title,
    state: refined.state,
    ...(refined.blockedReason !== undefined ? { blockedReason: refined.blockedReason } : {}),
    ...(task.prUrl !== undefined ? { prUrl: task.prUrl } : {}),
    ...(task.sessionId !== undefined ? { sessionId: task.sessionId } : {}),
    ...(task.worktreeDirectory !== undefined ? { worktree: task.worktreeDirectory } : {}),
    ...(task.branch !== undefined ? { branch: task.branch } : {}),
  }
  const lastWord = observation?.lastWord
  if (lastWord !== undefined) worker.lastWord = truncateLastWord(lastWord)
  if (observation?.error !== undefined) worker.lastPollError = observation.error
  if (observation?.possiblyStalledSince !== undefined) worker.possiblyStalledSince = observation.possiblyStalledSince
  return worker
}

function truncateLastWord(text: string): string {
  return text.length > lastWordMaxLength ? `${text.slice(0, lastWordMaxLength)}…` : text
}