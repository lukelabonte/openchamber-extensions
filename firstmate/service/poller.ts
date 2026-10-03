import { loadBacklog, type BacklogTask } from "./backlog"
import { loadArchivedSessionIds } from "./archive"
import { buildBoardWorker, type BoardWorker, type WorkerObservation } from "./board"
import { sessionMessagesLastAssistant, sessionStatus, type ExecRunner, type SessionActivity } from "./control-client"
import { callDesktopProxy } from "./desktop-proxy"
import type { FileSystemPort } from "./file-system"
import type { HttpFetcher, InterruptSupport } from "./interrupt"
import { notifyCaptain } from "./notifications"
import { setSessionPermissionAuto } from "./permissions"
import { loadRegistry, type Registration } from "./registry"

export type WorkerEventKind = "finished" | "failed" | "waiting-question" | "waiting-permission" | "steered-answer"

export interface WorkerEvent {
  taskTitle: string
  sessionId: string
  kind: WorkerEventKind
  /** The worker's new last word, for kind "steered-answer". */
  answer?: string
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

// The host's pending blocking requests keyed by session id, from the desktop
// server's /api/sessions/status: the permission and form lists each worker
// session is waiting on.
interface PendingSnapshot {
  [sessionId: string]: { permissions?: unknown[]; forms?: unknown[] }
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
// was in flight), so a restart never swallows a finished turn.
export interface SupervisionPoller {
  poll(): Promise<PollRound>
  getBoardWorkers(slug: string, tasks: BacklogTask[]): BoardWorker[]
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
}): SupervisionPoller {
  const { filesystem, exec, homeRoot, fetcher, resolveSupport } = input
  const observations = new Map<string, WorkerObservation>()
  const pollErrors = new Map<string, string>()
  const deliveryErrors = new Map<string, string>()
  // Workers steered from the board, awaiting their answer: the baseline is the
  // last word known at steer time; the next poll whose last word differs
  // forwards the answer to the coordinator once and clears the mark. A second
  // steer re-arms with the fresh baseline. In-memory like every poll state —
  // a restart drops pending marks, and the steer's answer is simply not
  // forwarded.
  const steeredBaselines = new Map<string, string | undefined>()
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
    // requests is one GET, and the captain notifications below ride the same
    // resolved support. Anything wrong — no support, failed call, unexpected
    // shape — answers undefined and the round degrades to the CLI-only
    // behavior; a host without the desktop proxy must never fail the round.
    let support: InterruptSupport | undefined
    try {
      support = await resolveSupport()
    } catch {
      support = undefined
    }
    const pending = await fetchPendingSnapshot(support)
    for (const registration of Object.values(registrations)) {
      const events = await pollProject(registration, pending)
      if (events.length > 0) {
        notifications.push(composeNotification(registration, events))
      }
      for (const event of events) await notifyEvent(registration, event, support)
    }
    return { notifications }
  }

  async function pollProject(registration: Registration, pending: PendingSnapshot | undefined): Promise<WorkerEvent[]> {
    const events: WorkerEvent[] = []
    let backlog: Awaited<ReturnType<typeof loadBacklog>>
    try {
      backlog = await loadBacklog(filesystem, `${homeRoot}/projects/${registration.slug}/backlog.md`)
    } catch {
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
    for (const task of backlog.tasks) {
      if (task.sessionId === undefined) continue
      if (archivedSessionIds.has(task.sessionId)) continue
      const key = observationKey(registration.slug, task.sessionId)
      const previous = observations.get(key)
      try {
        const directory = registration.projectDirectory
        if (!autoAcceptedSessions.has(task.sessionId)) {
          const outcome = await setSessionPermissionAuto({
            fetcher,
            support: await resolveSupport(),
            sessionId: task.sessionId,
            directory,
          })
          if (outcome.kind === "ok" || outcome.kind === "unsupported") {
            autoAcceptedSessions.add(task.sessionId)
          }
        }
        const status = await sessionStatus(exec, { sessionId: task.sessionId, directory })
        const lastWord = await sessionMessagesLastAssistant(exec, { sessionId: task.sessionId, directory })
        const current: WorkerObservation = { status, ...(lastWord !== undefined ? { lastWord } : {}) }
        // Host data wins over the CLI's busy/idle: a permission request or
        // form pending on the desktop server is the authoritative blocked
        // state. No pending entry keeps the CLI-derived activity.
        const waiting = pending === undefined ? undefined : pendingActivity(pending[task.sessionId])
        if (waiting !== undefined) current.status = { ...current.status, activity: waiting }
        observations.set(key, current)
        pollErrors.delete(key)
        events.push(...detectEvents(task, previous, current))
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
        // transition on the next successful one.
        pollErrors.set(key, error instanceof Error ? error.message : String(error))
      }
    }
    return events
  }

  function detectEvents(task: BacklogTask, previous: WorkerObservation | undefined, current: WorkerObservation): WorkerEvent[] {
    const events: WorkerEvent[] = []
    const emit = (kind: WorkerEventKind): WorkerEvent =>
      ({ taskTitle: task.title, sessionId: task.sessionId as string, kind })
    const activity = current.status.activity
    const outcome = current.status.outcome
    if (outcome === "failed" && previous?.status.outcome !== "failed") events.push(emit("failed"))
    if (activity === "waiting-question" && previous?.status.activity !== "waiting-question") events.push(emit("waiting-question"))
    if (activity === "waiting-permission" && previous?.status.activity !== "waiting-permission") events.push(emit("waiting-permission"))
    // The verified host class reports only busy/idle (mapped to running/idle
    // here) and exposes no outcome field, so "finished" must also fire on the
    // running→idle transition; waiting-* and outcome-based "failed" can only
    // fire on host classes that report richer statuses. First sight counts as
    // well — poll state is in-memory, so a worker already idle when the first
    // poll sees it (after a restart, or before supervision began) is
    // re-reported finished, but only when the backlog state says the work was
    // in flight. The detections share one emit so a transition alongside a
    // completed outcome reports exactly once.
    const outcomeFinished = outcome === "completed" && previous?.status.outcome !== "completed"
    const idleFinished =
      activity === "idle" && (previous === undefined ? task.state === "Working" : previous.status.activity === "running")
    if (outcomeFinished || idleFinished) events.push(emit("finished"))
    return events
  }

  // One GET per round: the host's map of sessions with pending blocking
  // requests, read through the desktop proxy. Never throws — every failure
  // mode answers undefined.
  async function fetchPendingSnapshot(support: InterruptSupport | undefined): Promise<PendingSnapshot | undefined> {
    if (support === undefined || support.kind === "unsupported") return undefined
    const outcome = await callDesktopProxy({
      fetcher,
      support,
      method: "GET",
      path: "/api/sessions/status",
      label: "session status",
    })
    if (outcome.kind !== "ok" || outcome.text === undefined) return undefined
    try {
      const parsed: unknown = JSON.parse(outcome.text)
      if (!isRecord(parsed) || !isRecord(parsed.pending)) return undefined
      return parsed.pending as PendingSnapshot
    } catch {
      return undefined
    }
  }

  // Only the blocking and failed transitions reach the captain's desktop: the
  // coordinator message already carries every event, and the notification is
  // for the captain away from the desk. Transitions only — the event logic
  // above is transition-based, so a persisting block never re-notifies.
  async function notifyEvent(registration: Registration, event: WorkerEvent, support: InterruptSupport | undefined): Promise<void> {
    const body = captainEventBody(event)
    if (body === undefined || support === undefined) return
    await notifyCaptain({
      fetcher,
      support,
      title: `FirstMate — ${registration.slug}`,
      body,
      sessionId: event.sessionId,
      directory: registration.projectDirectory,
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

  return { poll, getBoardWorkers, getDeliveryError, recordDeliveryError, clearDeliveryError, markSteered }
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
// list wins over a pending form. Entries that do not match the host shape
// report nothing, keeping the CLI-derived activity.
function pendingActivity(entry: { permissions?: unknown[]; forms?: unknown[] } | undefined): SessionActivity | undefined {
  if (entry === undefined) return undefined
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
