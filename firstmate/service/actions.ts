import { sessionSend, type ExecRunner } from "./control-client"

// Steer and Relaunch are pure relays: the captain's words go to the worker or
// coordinator over the control CLI, and the backlog stays the coordinator's to
// edit. The worker's answer reaches the captain through the normal poller
// flow, so nothing here waits on a reply.

export interface WorkerRef {
  sessionId: string
  title: string
}

export interface CoordinatorRef {
  sessionId: string
  directory: string
}

export interface SteerOutcome {
  coordinatorNotified: true
}

export interface SteerPartialOutcome {
  coordinatorNotified: false
  coordinatorError: string
}

// The worker send uses the registration's project directory — the same
// directory context the poller addresses sessions in. A failed coordinator
// notify is reported back to the caller instead of raised: the steer reached
// the worker, so retrying is the captain's informed choice, and the worker's
// answer still arrives via the poller.
export async function steerWorker(input: {
  exec: ExecRunner
  worker: WorkerRef
  workerDirectory: string
  coordinator: CoordinatorRef
  text: string
}): Promise<SteerOutcome | SteerPartialOutcome> {
  await sessionSend(input.exec, {
    sessionId: input.worker.sessionId,
    directory: input.workerDirectory,
    prompt: input.text,
  })
  try {
    await sessionSend(input.exec, {
      sessionId: input.coordinator.sessionId,
      directory: input.coordinator.directory,
      prompt: `The captain steered worker "${input.worker.title}": ${input.text}`,
    })
    return { coordinatorNotified: true }
  } catch (error) {
    return { coordinatorNotified: false, coordinatorError: error instanceof Error ? error.message : String(error) }
  }
}

// Suggestion sends and the /bearings and /ahoy commands are pure relays too:
// the panel's press becomes one coordinator message, verbatim.
export async function sendCoordinatorMessage(input: {
  exec: ExecRunner
  coordinator: CoordinatorRef
  text: string
}): Promise<void> {
  await sessionSend(input.exec, {
    sessionId: input.coordinator.sessionId,
    directory: input.coordinator.directory,
    prompt: input.text,
  })
}

// The coordinator is asked to launch a fresh worker in the same worktree
// (kind: 'existing'): work on disk carries over, the conversation does not.
// The coordinator owns the backlog edit that supersedes the old card.
export async function requestRelaunch(input: {
  exec: ExecRunner
  worker: WorkerRef
  worktreeDirectory: string
  coordinator: CoordinatorRef
  note: string
}): Promise<void> {
  await sessionSend(input.exec, {
    sessionId: input.coordinator.sessionId,
    directory: input.coordinator.directory,
    prompt:
      `The captain requested a relaunch of worker "${input.worker.title}" (session ${input.worker.sessionId}): ` +
      `launch a fresh worker in the existing worktree ${input.worktreeDirectory}; ` +
      `the conversation does not carry over. Update the backlog to supersede the old entry. ` +
      `The captain's note: ${input.note}`,
  })
}
