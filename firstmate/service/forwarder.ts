import { SessionBusyError, sessionSend, type ExecRunner } from "./control-client"
import type { ClockPort } from "./clock"

export interface Notification {
  slug: string
  coordinatorSessionId: string
  homeDirectory: string
  message: string
}

// Backoff for a busy coordinator: 30s, 2m, then keep trying every 5m. Whether
// `session send` to a busy session queues or errors is runtime-verified at
// acceptance (plan.md, "Could not determine"); the forwarder handles the error
// case and tolerates either behavior.
const busyRetryDelaysMs: readonly number[] = [30_000, 120_000, 300_000]
const steadyRetryDelayMs = 300_000

export async function deliverNotification(input: {
  exec: ExecRunner
  clock: ClockPort
  notification: Notification
}): Promise<void> {
  const { exec, clock, notification } = input
  for (let attempt = 0; ; attempt += 1) {
    try {
      await sessionSend(exec, {
        sessionId: notification.coordinatorSessionId,
        directory: notification.homeDirectory,
        prompt: notification.message,
      })
      return
    } catch (error) {
      if (!(error instanceof SessionBusyError)) throw error
      await clock.delay(attempt < busyRetryDelaysMs.length ? busyRetryDelaysMs[attempt] : steadyRetryDelayMs)
    }
  }
}
