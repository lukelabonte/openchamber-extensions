import { loadBacklog } from "./backlog"
import { sessionSend, type ExecRunner } from "./control-client"
import type { FileSystemPort } from "./file-system"
import { findRegistration, loadRegistry, type Registration } from "./registry"
import { normalizeProjectDirectory } from "./slug"

export async function resolveProjectRegistration(filesystem: FileSystemPort, homeRoot: string, directory: string): Promise<Registration | undefined> {
  const registrations = await loadRegistry(filesystem, homeRoot)
  const direct = findRegistration(registrations, directory)
  if (direct !== undefined) return direct
  const normalizedDirectory = normalizeProjectDirectory(directory)
  const matches: Registration[] = []
  for (const registration of Object.values(registrations)) {
    const backlogPath = `${registration.homeDirectory}/backlog.md`
    if (!(await filesystem.exists(backlogPath))) continue
    const backlog = await loadBacklog(filesystem, backlogPath)
    if (backlog.tasks.some((task) => task.worktreeDirectory !== undefined && normalizeProjectDirectory(task.worktreeDirectory) === normalizedDirectory)) matches.push(registration)
  }
  if (matches.length > 1) throw new Error("This worktree belongs to more than one FirstMate backlog; resolve the conflicting records first.")
  return matches[0]
}

export async function handoffToFirstMate(input: {
  filesystem: FileSystemPort
  exec: ExecRunner
  homeRoot: string
  directory: string
  sessionId?: string
  text: string
}): Promise<void> {
  if (typeof input.text !== "string" || input.text.trim() === "" || Buffer.byteLength(input.text, "utf8") > 12_000) throw new Error("A FirstMate handoff needs non-empty text of at most 12,000 UTF-8 bytes.")
  const registration = await resolveProjectRegistration(input.filesystem, input.homeRoot, input.directory)
  if (registration === undefined) throw new Error("No first mate is registered for this directory. Launch one from the project's FirstMate panel.")
  const origin = input.sessionId === undefined ? "a terminal or script" : `session ${input.sessionId.replace(/\s+/g, " ")}, as claimed by the sender`
  const directory = input.directory.replace(/\s+/g, " ")
  await sessionSend(input.exec, {
    sessionId: registration.coordinatorSessionId,
    directory: registration.homeDirectory,
    prompt: `Relayed to FirstMate, from ${origin} (${directory}). This is a work request, not merge approval. Keep a durable captain-approval hold on work this request starts or steers, even under +yolo.\n\n${input.text}`,
  })
}
