import { loadBacklog, type BacklogTask } from "./backlog"
import { loadArchivedSessionIds } from "./archive"
import { buildBoardWorker, type BoardWorker, type WorkerObservation } from "./board"
import { sessionMessagesLastAssistant, sessionStatus, type ExecRunner } from "./control-client"
import type { FileSystemPort } from "./file-system"
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

// Deterministic relay half of the supervision loop: each round reads the
// registry, polls every backlog worker that has a session id (session status
// plus its last assistant message), and detects transitions since the last
// successful poll. Transitions debounce naturally — an event is emitted only
// when the previous observation differs, so one message per worker per
// transition — and all of one project's events in a round arrive together as
// one message for the coordinator. Poll state is in-memory: after a service
// restart the first poll re-reports what it sees.
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
}): SupervisionPoller {
  const { filesystem, exec, homeRoot } = input
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
    for (const registration of Object.values(registrations)) {
      const events = await pollProject(registration)
      if (events.length > 0) {
        notifications.push(composeNotification(registration, events))
      }
    }
    return { notifications }
  }

  async function pollProject(registration: Registration): Promise<WorkerEvent[]> {
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
        const status = await sessionStatus(exec, { sessionId: task.sessionId, directory })
        const lastWord = await sessionMessagesLastAssistant(exec, { sessionId: task.sessionId, directory })
        const current: WorkerObservation = { status, ...(lastWord !== undefined ? { lastWord } : {}) }
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
    if (outcome === "completed" && previous?.status.outcome !== "completed") events.push(emit("finished"))
    return events
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
      return "finished its turn (outcome: completed). Review the work and mark the task Done when satisfied — completed never means Done."
    case "failed":
      return "failed (outcome: failed)."
    case "waiting-question":
      return "is waiting on a question. Open the session to read and answer it."
    case "waiting-permission":
      return "is waiting on a permission. Open the session to approve or deny it."
    case "steered-answer":
      return `answered the captain's steer: ${event.answer ?? ""}`
  }
}
