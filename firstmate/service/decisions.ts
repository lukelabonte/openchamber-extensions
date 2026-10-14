import { isTaskId, loadBacklog } from "./backlog"
import { sessionSend, type ExecRunner } from "./control-client"
import type { FileSystemPort } from "./file-system"
import { loadRegistry } from "./registry"

export async function sendTaskDecision(input: {
  filesystem: FileSystemPort
  exec: ExecRunner
  homeRoot: string
  slug: string
  taskId: string
  text?: string
  label?: string
  expectedText?: string
}): Promise<void> {
  if (!isTaskId(input.taskId)) throw new Error("taskId must be a path-safe task id")
  if ((input.text === undefined) === (input.label === undefined)) throw new Error("Provide either an answer or an action label, not both.")
  const registrations = await loadRegistry(input.filesystem, input.homeRoot)
  if (!Object.hasOwn(registrations, input.slug)) throw new Error("No first mate is registered for this project.")
  const registration = registrations[input.slug]
  const backlog = await loadBacklog(input.filesystem, `${registration.homeDirectory}/backlog.md`)
  if (backlog.errors.length > 0) throw new Error("Fix the backlog's malformed or duplicate records before answering a task.")
  const matches = backlog.tasks.filter((task) => task.id === input.taskId)
  if (matches.length !== 1) throw new Error("No unique task with this id exists.")
  const task = matches[0]
  if (task.state === "Done") throw new Error("This task is already Done; refresh the board.")
  let text = input.text
  if (input.label !== undefined) {
    const actions = task.actions?.filter((action) => action.label === input.label) ?? []
    if (actions.length !== 1) throw new Error("That task action no longer exists; refresh the board.")
    if (input.expectedText === undefined) throw new Error("The action text shown on the board is required; refresh before answering.")
    if (actions[0].text !== input.expectedText) throw new Error("That action changed; refresh the board before answering.")
    text = actions[0].text
  }
  if (typeof text !== "string" || text.trim() === "" || Buffer.byteLength(text, "utf8") > 12_000) throw new Error("An answer must contain 1 to 12,000 UTF-8 bytes.")
  await sessionSend(input.exec, {
    sessionId: registration.coordinatorSessionId,
    directory: registration.homeDirectory,
    prompt: `Task ${task.id} — ${task.title}: ${text}`,
  })
}
