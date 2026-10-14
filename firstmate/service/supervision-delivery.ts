import type { Notification } from "./forwarder"

// Delivery retries run independently of observation. Each project preserves
// order, while a busy first mate never freezes the other projects' polling.
export function createSupervisionDelivery(input: {
  deliver(notification: Notification): Promise<void>
  failed(slug: string, error: unknown): void
  succeeded(slug: string): void
}) {
  const projects = new Map<string, { pending: Notification[]; dropped: number }>()

  async function drain(slug: string, project: { pending: Notification[]; dropped: number }): Promise<void> {
    while (project.pending.length > 0) {
      const notification = project.pending.shift()!
      if (project.dropped > 0) {
        notification.message = `${project.dropped} older supervision updates were coalesced; inspect the live fleet before acting.\n\n${notification.message}`
        project.dropped = 0
      }
      try {
        await input.deliver(notification)
        input.succeeded(slug)
      } catch (error) {
        input.failed(slug, error)
      }
    }
    if (projects.get(slug) === project) projects.delete(slug)
  }

  function enqueue(notification: Notification): void {
    let project = projects.get(notification.slug)
    if (project !== undefined) {
      project.pending.push({ ...notification })
      if (project.pending.length > 20) { project.pending.shift(); project.dropped += 1 }
      return
    }
    project = { pending: [{ ...notification }], dropped: 0 }
    projects.set(notification.slug, project)
    void drain(notification.slug, project).catch((error) => input.failed(notification.slug, error))
  }

  return { enqueue }
}
