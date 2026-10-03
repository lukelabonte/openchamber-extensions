import { loadBacklog, type BacklogTask } from "./backlog"
import { loadArchivedSessionIds } from "./archive"
import { buildBoardWorker, type BoardWorker, type WorkerObservation } from "./board"
import { sessionLastAssistant, sessionStatus, type ExecRunner, type SessionActivity, type SessionLastAssistant, type SessionOutcome } from "./control-client"
import { callDesktopProxy } from "./desktop-proxy"
import type { FileSystemPort } from "./file-system"
import type { HttpFetcher, InterruptSupport } from "./interrupt"
import { notifyCaptain } from "./notifications"
import { setSessionPermissionAuto } from "./permissions"
import { loadRegistry, type Registration } from "./registry"
import { fetchSessionInfo, type SessionInfo } from "./session-observation"

export type WorkerEventKind = "finished" | "failed" | "waiting-question" | "waiting-permission" | "steered-answer"

export interface WorkerEvent {
  taskTitle: string
  sessionId: string
  kind: WorkerEventKind
  /** The worker's new last word, for kind "steered-answer". */
  answer?: string
  /** The worker's own directory (its worktree when one is recorded) — the click context for the captain notification. */
  directory?: string
}

export interface ProjectNotification {
  slug: string
  coordinatorSessionId: string
  homeDirectory: string
  message: string
}

export interface PollRound {
  notifications: ProjectNotification[]
}

// The state of one host-observation channel for a round: working (the read
// came back well-shaped), degraded (a supported channel answered a
// transport failure or a malformed payload), or unavailable (the host
// offers no path to it, or none could be resolved this round).
export type ObservationState = "working" | "degraded" | "unavailable"

// The per-project supervision-health record the board exposes: the state of
// the two host-observation channels — the pending-blocked snapshot
// (/api/sessions/status) and the authoritative failure reads
// (/api/session/<id>) — plus the time of the last fully clean poll. Reason
// strings are concise and sanitized: no tokens, no raw bodies.
export interface SupervisionHealth {
  blockedObservation: ObservationState
  blockedObservationReason?: string
  failureObservation: ObservationState
  failureObservationReason?: string
  lastSuccessfulPollAt?: string
}

// The host's pending blocking requests keyed by session id, from the desktop
// server's /api/sessions/status: the permission and form lists each worker
// session is waiting on. Entries are untrusted host JSON — the snapshot read
// validates every entry before accepting the map as ok, so a malformed
// entry degrades the blocked channel instead of reading as "no pending
// information for this session".
type PendingSnapshot = Record<string, unknown>

// The once-per-round pending snapshot read, classified like the session-info
// result: ok with the map, unsupported when the host offers no proxy path,
// failed when the call or the payload shape is wrong. A valid empty map is
// ok — distinguishable from every failure mode.
type PendingSnapshotResult =
  | { kind: "ok"; pending: PendingSnapshot }
  | { kind: "unsupported"; reason: string }
  | { kind: "failed"; reason: string }

// The canonical terminal identity a well-shaped session-info read names: the
// merged outcome plus the finite time.idle it was recorded at.
interface SeenTerminal {
  outcome: SessionOutcome
  idleAt: number
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

// Deterministic relay half of the supervision loop: each round reads the
// registry, polls every backlog worker that has a session id (session status
// plus its last assistant message), and detects transitions since the last
// successful poll. Transitions debounce naturally — an event is emitted only
// when the previous observation differs, so one message per worker per
// transition — and all of one project's events in a round arrive together as
// one message for the coordinator. Poll state is in-memory: after a service
// restart the first poll re-reports what it sees — a worker already idle at
// first sight is re-reported finished (the backlog state says whether work
// was in flight), so a restart never swallows a finished turn. The
// supervision-health record is in-memory the same way: it describes only
// what this process's rounds have observed.
export interface SupervisionPoller {
  poll(): Promise<PollRound>
  getBoardWorkers(slug: string, tasks: BacklogTask[]): BoardWorker[]
  /** The project's supervision-health record; a fresh clone per call, the initial unknown record for a never-polled slug. */
  getSupervisionHealth(slug: string): SupervisionHealth
  getDeliveryError(slug: string): string | undefined
  recordDeliveryError(slug: string, message: string): void
  clearDeliveryError(slug: string): void
  /** Arms answer-forwarding for a freshly steered worker; a second steer re-arms. */
  markSteered(slug: string, sessionId: string): void
}

export function createSupervisionPoller(input: {
  filesystem: FileSystemPort
  exec: ExecRunner
  homeRoot: string
  fetcher: HttpFetcher
  // Support is resolved lazily at first sight, not once at construction: a
  // host that gains or loses the desktop proxy between service start and a
  // later poll must not be frozen out by a boot-time answer.
  resolveSupport: () => Promise<InterruptSupport>
  // Time for the health record's lastSuccessfulPollAt; injectable so no test
  // ever reads the real clock. Defaults to Date.now.
  nowMs?: () => number
}): SupervisionPoller {
  const { filesystem, exec, homeRoot, fetcher, resolveSupport, nowMs = () => Date.now() } = input
  const observations = new Map<string, WorkerObservation>()
  const pollErrors = new Map<string, string>()
  const deliveryErrors = new Map<string, string>()
  // Supervision health per slug, recorded at each project's completed poll
  // attempt; in-memory like every poll state.
  const supervisionHealth = new Map<string, SupervisionHealth>()
  // Workers steered from the board, awaiting their answer: the baseline is the
  // last word known at steer time; the next poll whose last word differs
  // forwards the answer to the coordinator once and clears the mark. A second
  // steer re-arms with the fresh baseline. In-memory like every poll state —
  // a restart drops pending marks, and the steer's answer is simply not
  // forwarded.
  const steeredBaselines = new Map<string, string | undefined>()
  // The stall detector's per-worker baseline: the last observed message
  // signature and the time it was first seen, kept ONLY while the worker is
  // continuously seen running (or retrying) on successful polls of an
  // unfinished (Queued/Working) task. Any waiting/idle/unknown activity, a
  // changed signature, an unrecognizable message, or a failed poll drops the
  // baseline — a failed poll must break continuity, never accumulate an
  // unknown period toward the threshold. First sight starts the baseline at
  // that moment, even when the message itself is old: no retrospective
  // claim. In-memory like every poll state.
  const stallBaselines = new Map<string, StallBaseline>()
  // The stable last-seen terminal record, keyed like the observations: the
  // canonical terminal each well-shaped session-info read named — updated on
  // EVERY such read, busy or idle, merged or not. A terminal merges into an
  // observation only against an idle activity, so intervening
  // busy/waiting/unknown rounds lose it from the observation while the host
  // schema keeps answering with the same terminal; keying the terminal-event
  // dedupe on the previous observation would re-notify that same historical
  // failure. The record is a seen record, not a delivery claim — a busy read
  // never emits or displays anything — and it feeds event dedupe only,
  // never the board state. A failed read never wipes it, so recovery does
  // not re-notify. In-memory like every poll state: after a restart the
  // first idle read of a terminal is reported again.
  const lastSeenTerminals = new Map<string, SeenTerminal>()
  // Worker sessions already set to auto-approve permissions this service's
  // lifetime. Rounds never overlap, so first sight is exactly one attempt
  // while it succeeds or answers unsupported; a failed attempt leaves the
  // session unmarked so the next round retries — one transient failure must
  // not block auto-approve for the session's lifetime. Unsupported is
  // terminal: the host offers no auto-approve path, so a retry would only
  // fail again. A waiting-permission notification is where a persisting
  // prompt would surface from.
  const autoAcceptedSessions = new Set<string>()

  const observationKey = (slug: string, sessionId: string): string => `${slug}\n${sessionId}`

  async function poll(): Promise<PollRound> {
    const notifications: ProjectNotification[] = []
    let registrations: Record<string, Registration>
    try {
      registrations = await loadRegistry(filesystem, homeRoot)
    } catch {
      // The board endpoint surfaces a corrupt registry itself; there is no
      // project to attach a poll error to.
      return { notifications }
    }
    // Once per round, not per session: the host's snapshot of pending blocking
    // requests is one GET, and the captain notifications below and the
    // authoritative session-info reads ride the same resolved support.
    // Anything wrong — no support, failed call, unexpected shape — answers
    // its own failure kind and the round degrades to the CLI-only behavior;
    // a host without the desktop proxy must never fail the round.
    let support: InterruptSupport | undefined
    try {
      support = await resolveSupport()
    } catch {
      support = undefined
    }
    const pending = await fetchPendingSnapshot(support)
    for (const registration of Object.values(registrations)) {
      const events = await pollProject(registration, support, pending)
      if (events.length > 0) {
        notifications.push(composeNotification(registration, events))
      }
      for (const event of events) await notifyEvent(registration, event, support)
    }
    return { notifications }
  }

  async function pollProject(
    registration: Registration,
    support: InterruptSupport | undefined,
    pending: PendingSnapshotResult,
  ): Promise<WorkerEvent[]> {
    const events: WorkerEvent[] = []
    let backlog: Awaited<ReturnType<typeof loadBacklog>>
    try {
      backlog = await loadBacklog(filesystem, `${homeRoot}/projects/${registration.slug}/backlog.md`)
    } catch {
      // The board endpoint surfaces the unreadable backlog itself; the health
      // record keeps the previous round's entry whole — its timestamp names
      // the staleness.
      return events
    }
    // An archived worker is off the board and off supervision; its session
    // and worktree are left exactly as they are. An unreadable archive fails
    // closed like an unreadable backlog: without it the poller cannot tell an
    // ended worker from a live one, so the project skips the round rather
    // than silently resuming supervision.
    let archivedSessionIds: Set<string>
    try {
      archivedSessionIds = await loadArchivedSessionIds(filesystem, homeRoot, registration.slug)
    } catch {
      return events
    }
    // Health inputs for this project's round: every active worker's CLI
    // observation must succeed, and — when the desktop proxy is resolved —
    // every authoritative session-info read must come back well-shaped. A
    // failure marks the record without touching the observations themselves.
    let workerObservationFailed = false
    let infoDegradedReason: string | undefined
    let infoUnavailableReason: string | undefined
    for (const task of backlog.tasks) {
      if (task.sessionId === undefined) continue
      if (archivedSessionIds.has(task.sessionId)) continue
      const key = observationKey(registration.slug, task.sessionId)
      const previous = observations.get(key)
      const lastSeenTerminal = lastSeenTerminals.get(key)
      try {
        const directory = registration.projectDirectory
        // Permission auto-accept rides the once-per-round support resolved
        // above, not a per-session discovery of its own: a round whose
        // discovery failed to resolve (support undefined) simply skips the
        // call — the session stays unmarked so a later round with support
        // retries, exactly like a failed attempt — and the worker's own CLI
        // observation proceeds untouched either way. Unsupported stays
        // terminal: the host offers no auto-approve path.
        if (support !== undefined && !autoAcceptedSessions.has(task.sessionId)) {
          const outcome = await setSessionPermissionAuto({
            fetcher,
            support,
            sessionId: task.sessionId,
            directory,
          })
          if (outcome.kind === "ok" || outcome.kind === "unsupported") {
            autoAcceptedSessions.add(task.sessionId)
          }
        }
        const status = await sessionStatus(exec, { sessionId: task.sessionId, directory })
        // One CLI call per worker per round: the richer extraction (id,
        // timestamps, full text) rides the same `--last-assistant` command
        // the plain text reader used, and lastWord stays the text.
        const last = await sessionLastAssistant(exec, { sessionId: task.sessionId, directory })
        const current: WorkerObservation = { status, ...(last.text !== undefined ? { lastWord: last.text } : {}), last }
        // Host data wins over the CLI's busy/idle: a permission request or
        // form pending on the desktop server is the authoritative blocked
        // state. No pending entry keeps the CLI-derived activity.
        const waiting = pending.kind === "ok" ? pendingActivity(pending.pending[task.sessionId]) : undefined
        if (waiting !== undefined) current.status = { ...current.status, activity: waiting }
        // The authoritative terminal outcome, one bounded GET per worker per
        // round on the same support resolved once above. The worker's own
        // worktree directory is the session's read context when one is
        // recorded. A failed or malformed read keeps the CLI-derived status —
        // it degrades the failure observation, never the round — and an
        // outcome merges (and displays) only against an idle activity: the
        // schema says the outcome is the LAST completed execution, recorded
        // at time.idle, and it persists while the session runs again, so a
        // busy worker's outcome is stale. An interrupted terminal merges no
        // outcome at all — interrupted is never failed. A well-shaped read
        // records its terminal in the stable last-seen record on EVERY read,
        // busy or idle: a terminal named while the session runs again is
        // history, and the idle round that re-observes the same one must not
        // re-notify it.
        let seenTerminal: SeenTerminal | undefined
        if (support !== undefined && support.kind === "supported") {
          const info = await fetchSessionInfo({
            fetcher,
            support,
            sessionId: task.sessionId,
            directory: task.worktreeDirectory ?? registration.projectDirectory,
          })
          if (info.kind === "failed") {
            if (infoDegradedReason === undefined) infoDegradedReason = info.reason
          } else if (info.kind === "unsupported") {
            if (infoUnavailableReason === undefined) infoUnavailableReason = info.reason
          } else {
            const terminal = terminalOutcome(info.info)
            if (terminal !== undefined) {
              if (current.status.activity === "idle") {
                current.status = { ...current.status, outcome: terminal.outcome }
                current.terminalAt = terminal.idleAt
              }
              seenTerminal = terminal
            }
          }
        }
        observations.set(key, current)
        updateStallTracking(key, task, current, nowMs())
        pollErrors.delete(key)
        events.push(...detectEvents(task, previous, current, lastSeenTerminal))
        if (seenTerminal !== undefined) lastSeenTerminals.set(key, seenTerminal)
        if (steeredBaselines.has(key) && current.lastWord !== undefined && current.lastWord !== steeredBaselines.get(key)) {
          steeredBaselines.delete(key)
          events.push({
            taskTitle: task.title,
            sessionId: task.sessionId,
            kind: "steered-answer",
            answer: current.lastWord,
          })
        }
      } catch (error) {
        // Keep the previous observation: a failed poll must not fake a
        // transition on the next successful one. The stall baseline is
        // dropped and the flag removed from the kept observation — a failed
        // poll breaks continuity, and a flag carried through an
        // unobserved round must not be shown as current confidence.
        pollErrors.set(key, error instanceof Error ? error.message : String(error))
        workerObservationFailed = true
        stallBaselines.delete(key)
        const kept = observations.get(key)
        if (kept !== undefined && kept.possiblyStalledSince !== undefined) {
          const { possiblyStalledSince: _droppedStall, ...withoutStall } = kept
          observations.set(key, withoutStall)
        }
      }
    }
    recordSupervisionHealth(registration.slug, {
      support,
      pending,
      workerObservationFailed,
      infoDegradedReason,
      infoUnavailableReason,
    })
    return events
  }

  function detectEvents(
    task: BacklogTask,
    previous: WorkerObservation | undefined,
    current: WorkerObservation,
    lastSeenTerminal: SeenTerminal | undefined,
  ): WorkerEvent[] {
    const events: WorkerEvent[] = []
    const emit = (kind: WorkerEventKind): WorkerEvent =>
      ({
        taskTitle: task.title,
        sessionId: task.sessionId as string,
        kind,
        // The worker's own directory (its worktree when recorded) rides the
        // event as the captain notification's click context.
        ...(task.worktreeDirectory !== undefined ? { directory: task.worktreeDirectory } : {}),
      })
    const activity = current.status.activity
    const outcome = current.status.outcome
    // A terminal merged from the host (terminalAt present) dedupes against
    // the stable last-seen record, not the previous observation: the same
    // canonical terminal re-observed after intervening busy/waiting rounds —
    // whose observations lost it, because it merges only against idle —
    // never re-fires. A CLI-derived outcome (no terminalAt to key it by)
    // keeps the previous-observation comparison, the old CLI behavior.
    const sameSeenTerminal =
      current.terminalAt !== undefined &&
      lastSeenTerminal !== undefined &&
      lastSeenTerminal.outcome === outcome &&
      lastSeenTerminal.idleAt === current.terminalAt
    const previousSameTerminal =
      previous !== undefined && previous.status.outcome === outcome && previous.terminalAt === current.terminalAt
    // A failed terminal fires on the outcome transition and on a DISTINCT
    // terminal: the host schema says the outcome is the LAST completed
    // execution, recorded at time.idle, so failed→failed with a new
    // time.idle is a second failed turn (the worker ran and failed again),
    // while the same terminal re-observed on a later poll never re-fires.
    if (outcome === "failed" && !sameSeenTerminal && (current.terminalAt !== undefined || !previousSameTerminal)) {
      events.push(emit("failed"))
    }
    if (activity === "waiting-question" && previous?.status.activity !== "waiting-question") events.push(emit("waiting-question"))
    if (activity === "waiting-permission" && previous?.status.activity !== "waiting-permission") events.push(emit("waiting-permission"))
    // The CLI's session status reports only busy/idle (mapped to running/idle
    // here) and carries no outcome — the outcome above is the host
    // session-info merge — so "finished" must also fire on the running→idle
    // transition. First sight counts as well — poll state is in-memory, so a
    // worker already idle when the first poll sees it (after a restart, or
    // before supervision began) is re-reported finished, but only when the
    // backlog state says the work was in flight. The detections share one
    // emit so a transition alongside a completed outcome reports exactly
    // once, and a failed observation never also reports finished — the turn
    // did not land, and "finished its turn" would contradict the failure.
    // The same-seen guard also keeps a stale historical terminal (completed
    // or interrupted alike) from re-firing "finished" through the
    // transition path after intervening busy rounds, while a terminal-less
    // transition — a new run whose outcome is unknown — still fires once.
    const outcomeFinished =
      outcome === "completed" && !sameSeenTerminal && (current.terminalAt !== undefined || previous?.status.outcome !== "completed")
    const idleFinished =
      activity === "idle" &&
      outcome !== "failed" &&
      !sameSeenTerminal &&
      (previous === undefined ? task.state === "Working" : previous.status.activity === "running")
    if (outcomeFinished || idleFinished) events.push(emit("finished"))
    return events
  }

  // One GET per round: the host's map of sessions with pending blocking
  // requests, read through the desktop proxy. Never throws — every failure
  // mode answers its own kind: unsupported when this host offers no proxy
  // path (or rejects its credentials), failed when the call or the payload
  // shape is wrong. The kinds become the blocked observation state in the
  // health record.
  async function fetchPendingSnapshot(support: InterruptSupport | undefined): Promise<PendingSnapshotResult> {
    if (support === undefined) return { kind: "unsupported", reason: "the desktop proxy support could not be resolved this round" }
    if (support.kind === "unsupported") return { kind: "unsupported", reason: support.reason }
    const outcome = await callDesktopProxy({
      fetcher,
      support,
      method: "GET",
      path: "/api/sessions/status",
      label: "session status",
    })
    if (outcome.kind === "unsupported") return { kind: "unsupported", reason: outcome.reason }
    if (outcome.kind === "failed") return { kind: "failed", reason: outcome.message }
    if (outcome.text === undefined) return { kind: "failed", reason: "the session status response body could not be read" }
    try {
      const parsed: unknown = JSON.parse(outcome.text)
      if (!isRecord(parsed) || !isRecord(parsed.pending) || Array.isArray(parsed.pending)) {
        return { kind: "failed", reason: "the session status response had no pending map" }
      }
      // Every entry is validated before the snapshot reads as ok: an entry
      // that is not a record, or whose permissions or forms list is present
      // but not an array, degrades the whole blocked channel — a garbage
      // entry must never read as "no pending information for this
      // session", letting the round claim a clean, waiting-free observation.
      // The reason is a fixed string: no raw body, no token.
      for (const entry of Object.values(parsed.pending)) {
        if (!isRecord(entry) || Array.isArray(entry)) {
          return { kind: "failed", reason: "the session status response had a malformed pending entry" }
        }
        if (
          (entry.permissions !== undefined && !Array.isArray(entry.permissions)) ||
          (entry.forms !== undefined && !Array.isArray(entry.forms))
        ) {
          return { kind: "failed", reason: "the session status response had a malformed pending entry" }
        }
      }
      return { kind: "ok", pending: parsed.pending }
    } catch {
      return { kind: "failed", reason: "the session status response was not valid JSON" }
    }
  }

  // Only the blocking and failed transitions reach the captain's desktop: the
  // coordinator message already carries every event, and the notification is
  // for the captain away from the desk. Transitions only — the event logic
  // above is transition-based, so a persisting block never re-notifies. The
  // notification's click context is the worker's own directory (its worktree
  // when recorded) so the click lands on the session the event is about.
  async function notifyEvent(registration: Registration, event: WorkerEvent, support: InterruptSupport | undefined): Promise<void> {
    const body = captainEventBody(event)
    if (body === undefined || support === undefined) return
    await notifyCaptain({
      fetcher,
      support,
      title: `FirstMate — ${registration.slug}`,
      body,
      sessionId: event.sessionId,
      directory: event.directory ?? registration.projectDirectory,
    })
  }

  function getBoardWorkers(slug: string, tasks: BacklogTask[]): BoardWorker[] {
    return tasks.map((task) => {
      const observation = task.sessionId === undefined ? undefined : observations.get(observationKey(slug, task.sessionId))
      const error = task.sessionId === undefined ? undefined : pollErrors.get(observationKey(slug, task.sessionId))
      const merged: WorkerObservation | undefined =
        observation === undefined && error === undefined ? undefined : { ...(observation ?? { status: { activity: "unknown", outcome: null } }), ...(error !== undefined ? { error } : {}) }
      return buildBoardWorker(task, merged)
    })
  }

  // The board reads each project's supervision health; a never-polled slug
  // reads the initial unknown record. Every call answers a fresh clone so no
  // caller can mutate the recorded state.
  function getSupervisionHealth(slug: string): SupervisionHealth {
    return { ...(supervisionHealth.get(slug) ?? initialSupervisionHealth()) }
  }

  function getDeliveryError(slug: string): string | undefined {
    return deliveryErrors.get(slug)
  }

  function recordDeliveryError(slug: string, message: string): void {
    deliveryErrors.set(slug, message)
  }

  function clearDeliveryError(slug: string): void {
    deliveryErrors.delete(slug)
  }

  function markSteered(slug: string, sessionId: string): void {
    const key = observationKey(slug, sessionId)
    steeredBaselines.set(key, observations.get(key)?.lastWord)
  }

  // Records one project's round outcome as its supervision-health entry.
  // The observation states always describe THIS round's reads; the clean-poll
  // timestamp moves only on a round in which the project's backlog and
  // archive reads, every active worker's CLI observation, and — when the
  // desktop proxy is resolved — every required authoritative HTTP
  // observation (the pending snapshot and each session-info read) succeeded.
  // Errors keep the previous timestamp; a host without the proxy polls clean
  // CLI-only, and an empty project with a valid snapshot polls clean.
  function recordSupervisionHealth(slug: string, input: {
    support: InterruptSupport | undefined
    pending: PendingSnapshotResult
    workerObservationFailed: boolean
    infoDegradedReason: string | undefined
    infoUnavailableReason: string | undefined
  }): void {
    const blocked: { state: ObservationState; reason?: string } =
      input.pending.kind === "ok"
        ? { state: "working" }
        : { state: input.pending.kind === "failed" ? "degraded" : "unavailable", reason: input.pending.reason }
    const failure: { state: ObservationState; reason?: string } =
      input.support === undefined
        ? { state: "unavailable", reason: "the desktop proxy support could not be resolved this round" }
        : input.support.kind === "unsupported"
          ? { state: "unavailable", reason: input.support.reason }
          : input.infoDegradedReason !== undefined
            ? { state: "degraded", reason: input.infoDegradedReason }
            : input.infoUnavailableReason !== undefined
              ? { state: "unavailable", reason: input.infoUnavailableReason }
              : { state: "working" }
    const requiredHttpObservationsClean =
      input.support === undefined ||
      input.support.kind === "unsupported" ||
      (input.pending.kind === "ok" && input.infoDegradedReason === undefined && input.infoUnavailableReason === undefined)
    const clean = !input.workerObservationFailed && requiredHttpObservationsClean
    const previous = supervisionHealth.get(slug)
    const health: SupervisionHealth = {
      blockedObservation: blocked.state,
      ...(blocked.reason !== undefined ? { blockedObservationReason: blocked.reason } : {}),
      failureObservation: failure.state,
      ...(failure.reason !== undefined ? { failureObservationReason: failure.reason } : {}),
    }
    if (clean) {
      health.lastSuccessfulPollAt = new Date(nowMs()).toISOString()
    } else if (previous?.lastSuccessfulPollAt !== undefined) {
      health.lastSuccessfulPollAt = previous.lastSuccessfulPollAt
    }
    supervisionHealth.set(slug, health)
  }

  // Advances (or resets) one worker's stall baseline against this round's
  // merged observation. The flag is cautious by construction:
  // - Only an unfinished task (Queued/Working) continuously seen running or
  //   retrying accumulates toward the threshold; waiting/idle/unknown
  //   activity resets the baseline.
  // - The signature is id + timestamps + FULL text of the last assistant
  //   message — a streaming message that keeps its id while its text grows
  //   is progress. A new signature (or new text) restarts the baseline.
  // - A message with no recognizable id or timestamp cannot establish
  //   "unchanged", so it never flags and resets the baseline rather than
  //   guessing. A long-running tool legitimately shows no assistant
  //   progress; only the full fixed 30 minutes of unchanged recognizable
  //   progress flags.
  function updateStallTracking(key: string, task: BacklogTask, observation: WorkerObservation, now: number): void {
    const activity = observation.status.activity
    const unfinished = task.state === "Queued" || task.state === "Working"
    const signature = unfinished && (activity === "running" || activity === "retrying") ? messageSignature(observation.last) : undefined
    if (signature === undefined) {
      stallBaselines.delete(key)
      return
    }
    const existing = stallBaselines.get(key)
    if (existing === undefined || existing.signature !== signature) {
      stallBaselines.set(key, { signature, sinceMs: now })
      return
    }
    if (now - existing.sinceMs >= stallThresholdMs) {
      observation.possiblyStalledSince = new Date(existing.sinceMs).toISOString()
    }
  }

  return { poll, getBoardWorkers, getSupervisionHealth, getDeliveryError, recordDeliveryError, clearDeliveryError, markSteered }
}

// The merged terminal from a verified session info: succeeded → completed,
// failed → failed, interrupted → no outcome at all — an interrupted turn is
// never a failure, so it falls to the plain idle handling. No terminal when
// the info carries no canonical outcome or no finite time.idle to key it by.
function terminalOutcome(info: SessionInfo): { outcome: SessionOutcome; idleAt: number } | undefined {
  if (info.outcome === undefined || info.time.idle === undefined) return undefined
  if (info.outcome === "succeeded") return { outcome: "completed", idleAt: info.time.idle }
  if (info.outcome === "failed") return { outcome: "failed", idleAt: info.time.idle }
  return { outcome: null, idleAt: info.time.idle }
}

// The stall threshold is deliberately fixed — no configuration: 30 minutes
// of unchanged, recognizable last-assistant-message progress on a worker
// continuously seen running flags the stall.
const stallThresholdMs = 30 * 60 * 1000

interface StallBaseline {
  signature: string
  sinceMs: number
}

// The progress signature: id + timestamps + FULL text of the last assistant
// message. Full text (not the board's truncated preview) is included so a
// streaming message that keeps its id while its text grows reads as
// progress. A message with no recognizable id and no timestamp cannot
// establish "unchanged" — the signature is undefined and the caller resets
// rather than guessing.
function messageSignature(last: SessionLastAssistant | undefined): string | undefined {
  if (last === undefined) return undefined
  if (last.id === undefined && last.createdAt === undefined && last.completedAt === undefined) return undefined
  return JSON.stringify([last.id ?? null, last.createdAt ?? null, last.completedAt ?? null, last.text ?? null])
}

// The initial unknown record a never-polled slug reads.
function initialSupervisionHealth(): SupervisionHealth {
  return {
    blockedObservation: "unavailable",
    blockedObservationReason: "Not polled yet",
    failureObservation: "unavailable",
    failureObservationReason: "Not polled yet",
  }
}

function composeNotification(registration: Registration, events: WorkerEvent[]): ProjectNotification {
  const lines = events.map((event) => `- "${event.taskTitle}" (${event.sessionId}): ${describeEvent(event)}`)
  return {
    slug: registration.slug,
    coordinatorSessionId: registration.coordinatorSessionId,
    homeDirectory: registration.homeDirectory,
    message: [`FirstMate (${registration.slug}) worker update:`, ...lines].join("\n"),
  }
}

function describeEvent(event: WorkerEvent): string {
  switch (event.kind) {
    case "finished":
      return "finished its turn and is idle now. Review the work and mark the task Done when satisfied — a finished turn never means Done."
    case "failed":
      return "failed (outcome: failed)."
    case "waiting-question":
      return "is waiting on a question. Open the session to read and answer it."
    case "waiting-permission":
      return "was waiting on a permission; the service auto-approves worker permissions, so this should clear itself. If it persists, tell the captain."
    case "steered-answer":
      return `answered the captain's steer: ${event.answer ?? ""}`
  }
}

// The waiting activity a host snapshot entry reports: a non-empty permission
// list wins over a pending form. The snapshot read already validated every
// entry of an ok map (a record whose lists are absent or arrays); the guard
// here keeps the use safe regardless, so a value that still is not a record
// reads as "no pending information for this session", keeping the
// CLI-derived activity rather than crashing the round.
function pendingActivity(entry: unknown): SessionActivity | undefined {
  if (!isRecord(entry)) return undefined
  if (Array.isArray(entry.permissions) && entry.permissions.length > 0) return "waiting-permission"
  if (Array.isArray(entry.forms) && entry.forms.length > 0) return "waiting-question"
  return undefined
}

// The captain notification bodies for the transition kinds that page the
// captain; other kinds are relayed to the coordinator only.
function captainEventBody(event: WorkerEvent): string | undefined {
  switch (event.kind) {
    case "waiting-permission":
      return `"${event.taskTitle}" is waiting on a permission approval.`
    case "waiting-question":
      return `"${event.taskTitle}" is waiting on an answer to a question.`
    case "failed":
      return `"${event.taskTitle}" failed.`
    default:
      return undefined
  }
}
