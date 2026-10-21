import { createHash } from "node:crypto"
import type { BacklogTask } from "./backlog"
import type { FileSystemPort } from "./file-system"
import type { HttpFetcher, InterruptSupport } from "./interrupt"
import { notifyCaptain } from "./notifications"
import type { Registration } from "./registry"

interface AlertState {
  delivered: Map<string, string>
  dirty: boolean
}

function preview(text: string, limit: number): string {
  const characters = Array.from(text)
  return characters.length <= limit ? text : `${characters.slice(0, limit - 1).join("")}…`
}

// The first mate requests captain attention through an actionable backlog hold,
// not through a worker's raw status. The journal survives service restarts.
export function createCaptainAlerts(input: { filesystem: FileSystemPort; fetcher: HttpFetcher }) {
  const states = new Map<string, AlertState>()

  async function load(homeDirectory: string): Promise<AlertState> {
    const cached = states.get(homeDirectory)
    if (cached !== undefined) return cached
    const state: AlertState = { delivered: new Map(), dirty: false }
    const statePath = `${homeDirectory}/captain-alerts.json`
    if (await input.filesystem.exists(statePath)) {
      const saved: unknown = JSON.parse(await input.filesystem.readFile(statePath))
      if (saved === null || typeof saved !== "object" || Array.isArray(saved) ||
        !Object.values(saved).every((signature) => typeof signature === "string" && /^[a-f0-9]{64}$/.test(signature))) {
        throw new Error("invalid captain alert history")
      }
      state.delivered = new Map(Object.entries(saved) as [string, string][])
    }
    states.set(homeDirectory, state)
    return state
  }

  async function save(homeDirectory: string, state: AlertState): Promise<void> {
    if (!state.dirty) return
    const statePath = `${homeDirectory}/captain-alerts.json`
    const temporaryPath = `${statePath}.${crypto.randomUUID()}.tmp`
    await input.filesystem.writeFile(temporaryPath, `${JSON.stringify(Object.fromEntries(state.delivered))}\n`)
    await input.filesystem.rename(temporaryPath, statePath)
    state.dirty = false
  }

  return async function notifyDecisions(registration: Registration, tasks: BacklogTask[], support: InterruptSupport | undefined): Promise<void> {
    const state = await load(registration.homeDirectory)
    // Retry a failed journal save before sending anything new. Accepted alerts
    // stay acknowledged in memory even if their first save failed.
    await save(registration.homeDirectory, state)
    const completed = new Set(tasks.filter((task) => task.state === "Done").map((task) => task.id))
    const decisions = tasks.filter((task) =>
      task.id !== undefined && task.hold !== undefined && (task.actions?.length ?? 0) > 0 &&
      (task.state === "Blocked" || (task.kind === "captain" && task.state === "Queued")) &&
      (task.blockedBy === undefined || completed.has(task.blockedBy)),
    )
    // Temporary work or dependency waits don't create a new decision. Forget
    // only removed/resolved gates, not merely those that aren't ready today.
    const activeIds = new Set(tasks.filter((task) =>
      task.state !== "Done" && task.hold !== undefined && (task.actions?.length ?? 0) > 0,
    ).map((task) => task.id))
    for (const taskId of state.delivered.keys()) {
      if (!activeIds.has(taskId)) {
        state.delivered.delete(taskId)
        state.dirty = true
      }
    }
    try {
      for (const task of decisions) {
        const signature = createHash("sha256").update(JSON.stringify([
          task.title, task.hold, task.actions, task.prUrl, task.reviewHead,
        ])).digest("hex")
        if (state.delivered.get(task.id!) === signature || support?.kind !== "supported") continue
        const body = [
          `"${preview(task.title, 80)}" (${task.id}): ${preview(task.hold!, 400)}`,
          `Choices: ${task.actions!.map((action) => preview(action.label, 32)).join(" / ")}`,
          ...(task.reviewHead === undefined ? [] : [`Reviewed head: ${task.reviewHead}`]),
          ...(task.prUrl === undefined ? [] : [`PR: ${preview(task.prUrl, 150)}`]),
          "Open the first mate to review and answer.",
        ].join("\n")
        const accepted = await notifyCaptain({
          fetcher: input.fetcher, support, title: `FirstMate — ${registration.slug}: decision needed`,
          body, sessionId: registration.coordinatorSessionId, directory: registration.homeDirectory,
        })
        if (accepted) {
          state.delivered.set(task.id!, signature)
          state.dirty = true
        }
      }
    } finally {
      await save(registration.homeDirectory, state)
    }
  }
}
