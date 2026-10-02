import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { spawn } from "node:child_process"
import { mkdir, readFile, readdir, rename, stat, writeFile, appendFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { requestRelaunch, steerWorker } from "./actions"
import { archiveSession, loadArchivedSessionIds } from "./archive"
import { loadBacklog, type BacklogTask } from "./backlog"
import { composeInstructions } from "./compose"
import { createNodeClock } from "./clock"
import { MissingCliError, type ExecRunner } from "./control-client"
import type { FileSystemPort } from "./file-system"
import { deliverNotification } from "./forwarder"
import { discoverSupport, interruptWorker, type HttpFetcher } from "./interrupt"
import { launchFirstMate } from "./launch"
import { createSupervisionPoller } from "./poller"
import { provisionProject } from "./provision"
import { findRegistration, loadRegistry, type Registration } from "./registry"

const rawServicePort = process.env.OPENCHAMBER_SERVICE_PORT
const serviceToken = process.env.OPENCHAMBER_SERVICE_TOKEN
const homeRoot = process.env.FIRSTMATE_HOME ?? path.join(homedir(), ".config", "firstmate")
// Interrupt's fallback path discovers the managed opencode server from the
// OpenChamber CLI's own settings (private surface, see interrupt.ts); the
// env override exists so tests can point discovery at a fixture file.
const openchamberSettingsPath =
  process.env.FIRSTMATE_OPENCHAMBER_SETTINGS ?? path.join(homedir(), ".config", "openchamber", "settings.json")
// Templates ship beside the service; argv[1] is the entry path under both bun and node.
const templatesDirectory = path.resolve(path.dirname(process.argv[1] ?? "."), "..", "templates")

const servicePort = Number(rawServicePort)
if (!rawServicePort || !Number.isInteger(servicePort) || servicePort < 0) {
  throw new Error("OPENCHAMBER_SERVICE_PORT must be set to a valid port")
}
if (!serviceToken) {
  throw new Error("OPENCHAMBER_SERVICE_TOKEN must be set")
}

const nodeFileSystem: FileSystemPort = {
  exists: async (filePath) => {
    try {
      await stat(filePath)
      return true
    } catch {
      return false
    }
  },
  readFile: (filePath) => readFile(filePath, "utf8"),
  writeFile: (filePath, contents) => writeFile(filePath, contents, "utf8"),
  appendFile: (filePath, contents) => appendFile(filePath, contents, "utf8"),
  createDirectory: (directoryPath) => mkdir(directoryPath, { recursive: true }),
  rename: (fromPath, toPath) => rename(fromPath, toPath),
  listDirectories: async (directoryPath) => {
    try {
      const entries = await readdir(directoryPath, { withFileTypes: true })
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch {
      return []
    }
  },
}

const nodeExec: ExecRunner = (command, args) =>
  new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] })
    const stdoutChunks: Buffer[] = []
    const stderrChunks: Buffer[] = []
    child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk))
    child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk))
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdoutChunks).toString("utf8"))
        return
      }
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim()
      reject(new Error(`${command} exited with code ${code}${stderr === "" ? "" : `: ${stderr}`}`))
    })
  })

const nodeFetcher: HttpFetcher = (url, init) => fetch(url, init)

const templateReader = (templateName: string): Promise<string> =>
  readFile(path.join(templatesDirectory, templateName), "utf8")

const defaultPollIntervalMs = 15_000

function readPollIntervalMs(): number {
  const raw = process.env.FIRSTMATE_POLL_MS
  if (raw === undefined || raw.trim() === "") return defaultPollIntervalMs
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error("FIRSTMATE_POLL_MS must be a positive integer")
  }
  return value
}

const pollIntervalMs = readPollIntervalMs()
const clock = createNodeClock()
const supervisionPoller = createSupervisionPoller({ filesystem: nodeFileSystem, exec: nodeExec, homeRoot })

// One supervision round: poll every registered project's workers, then
// deliver each project's notification to its coordinator. A failed delivery is
// recorded for the board, never thrown into the interval. Rounds never overlap:
// the interval can fire while a round's CLI calls are still in flight, and an
// overlapping round would observe the same not-yet-recorded transitions and
// send the coordinator the same notification twice — so an in-flight round
// makes the next tick a no-op.
let roundInFlight = false

async function runSupervisionRound(): Promise<void> {
  if (roundInFlight) return
  roundInFlight = true
  try {
    const round = await supervisionPoller.poll()
    for (const notification of round.notifications) {
      try {
        await deliverNotification({ exec: nodeExec, clock, notification })
        supervisionPoller.clearDeliveryError(notification.slug)
      } catch (error) {
        supervisionPoller.recordDeliveryError(notification.slug, error instanceof Error ? error.message : String(error))
      }
    }
  } finally {
    roundInFlight = false
  }
}

function isAuthorized(request: IncomingMessage): boolean {
  return request.headers.authorization === `Bearer ${serviceToken}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function respondJson(response: ServerResponse, statusCode: number, body: unknown): void {
  response.statusCode = statusCode
  response.setHeader("content-type", "application/json")
  response.end(JSON.stringify(body))
}

function readJsonBody(request: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = []
    request.on("data", (chunk: Buffer) => chunks.push(chunk))
    request.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")))
      } catch (error) {
        reject(error)
      }
    })
    request.on("error", reject)
  })
}

async function readJsonRecord(request: IncomingMessage): Promise<Record<string, unknown> | undefined> {
  try {
    const payload = await readJsonBody(request)
    return isRecord(payload) ? payload : undefined
  } catch {
    return undefined
  }
}

function recordString(record: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = record?.[key]
  return typeof value === "string" && value.trim() !== "" ? value : undefined
}

async function readProjectDirectory(request: IncomingMessage): Promise<string | undefined> {
  let payload: unknown
  try {
    payload = await readJsonBody(request)
  } catch {
    return undefined
  }
  const projectDirectory = isRecord(payload) ? payload.projectDirectory : undefined
  if (typeof projectDirectory !== "string" || projectDirectory.trim() === "") {
    return undefined
  }
  return projectDirectory
}

async function handleProvision(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const projectDirectory = await readProjectDirectory(request)
  if (projectDirectory === undefined) {
    respondJson(response, 400, { error: "projectDirectory must be a non-empty string" })
    return
  }
  try {
    const { slug, projectHomeDirectory } = await provisionProject({
      filesystem: nodeFileSystem,
      templateReader,
      homeRoot,
      projectDirectory,
    })
    await composeInstructions({ filesystem: nodeFileSystem, homeRoot, slug })
    respondJson(response, 200, { slug, homeDirectory: projectHomeDirectory })
  } catch (error) {
    respondJson(response, 500, { error: error instanceof Error ? error.message : "provisioning failed" })
  }
}

async function handleLaunch(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const projectDirectory = await readProjectDirectory(request)
  if (projectDirectory === undefined) {
    respondJson(response, 400, { error: "projectDirectory must be a non-empty string" })
    return
  }
  try {
    const { registration } = await launchFirstMate({
      filesystem: nodeFileSystem,
      exec: nodeExec,
      templateReader,
      homeRoot,
      projectDirectory,
    })
    respondJson(response, 200, registration)
  } catch (error) {
    if (error instanceof MissingCliError) {
      respondJson(response, 503, { error: error.message, code: "cli-missing" })
      return
    }
    respondJson(response, 500, { error: error instanceof Error ? error.message : "launch failed" })
  }
}

async function handleRegistryList(response: ServerResponse): Promise<void> {
  const registrations = await loadRegistry(nodeFileSystem, homeRoot)
  respondJson(response, 200, { registrations: Object.values(registrations) })
}

async function handleRegistryItem(slug: string, response: ServerResponse): Promise<void> {
  const registrations = await loadRegistry(nodeFileSystem, homeRoot)
  if (!Object.hasOwn(registrations, slug)) {
    respondJson(response, 404, { error: `no first mate registered for slug ${slug}` })
    return
  }
  respondJson(response, 200, registrations[slug])
}

async function handleLookup(url: URL, response: ServerResponse): Promise<void> {
  const directory = url.searchParams.get("directory")
  if (directory === null || directory.trim() === "") {
    respondJson(response, 400, { error: "directory must be a non-empty string" })
    return
  }
  try {
    const registrations = await loadRegistry(nodeFileSystem, homeRoot)
    const registration = findRegistration(registrations, directory)
    respondJson(response, 200, { registration: registration ?? null })
  } catch (error) {
    respondJson(response, 500, { error: error instanceof Error ? error.message : "lookup failed" })
  }
}

async function handleBoard(url: URL, response: ServerResponse): Promise<void> {
  const slug = url.searchParams.get("slug")
  if (slug === null || slug.trim() === "") {
    respondJson(response, 400, { error: "slug must be a non-empty string" })
    return
  }
  try {
    const registrations = await loadRegistry(nodeFileSystem, homeRoot)
    if (!Object.hasOwn(registrations, slug)) {
      respondJson(response, 404, { error: `no first mate registered for slug ${slug}` })
      return
    }
    const backlog = await loadBacklog(nodeFileSystem, `${homeRoot}/projects/${slug}/backlog.md`)
    const archivedSessionIds = await loadArchivedSessionIds(nodeFileSystem, homeRoot, slug)
    const tasks = backlog.tasks.filter((task) => task.sessionId === undefined || !archivedSessionIds.has(task.sessionId))
    const workers = supervisionPoller.getBoardWorkers(slug, tasks)
    const deliveryError = supervisionPoller.getDeliveryError(slug)
    respondJson(response, 200, deliveryError === undefined ? { workers } : { workers, deliveryError })
  } catch (error) {
    respondJson(response, 500, { error: error instanceof Error ? error.message : "board read failed" })
  }
}

async function handleBacklog(url: URL, response: ServerResponse): Promise<void> {
  const slug = url.searchParams.get("slug")
  if (slug === null || slug.trim() === "") {
    respondJson(response, 400, { error: "slug must be a non-empty string" })
    return
  }
  try {
    const registrations = await loadRegistry(nodeFileSystem, homeRoot)
    if (!Object.hasOwn(registrations, slug)) {
      respondJson(response, 404, { error: `no first mate registered for slug ${slug}` })
      return
    }
    const backlog = await loadBacklog(nodeFileSystem, `${homeRoot}/projects/${slug}/backlog.md`)
    respondJson(response, 200, backlog)
  } catch (error) {
    respondJson(response, 500, { error: error instanceof Error ? error.message : "backlog read failed" })
  }
}

// Card actions resolve a worker by its session id inside a registered slug's
// backlog; unknown slugs and unknown sessions both answer 404.
type WorkerContext =
  | { kind: "unknown-slug" }
  | { kind: "unknown-task" }
  | { kind: "found"; registration: Registration; task: BacklogTask }

async function findProjectWorker(slug: string, sessionId: string): Promise<WorkerContext> {
  const registrations = await loadRegistry(nodeFileSystem, homeRoot)
  if (!Object.hasOwn(registrations, slug)) return { kind: "unknown-slug" }
  const registration = registrations[slug]
  const backlog = await loadBacklog(nodeFileSystem, `${homeRoot}/projects/${slug}/backlog.md`)
  const task = backlog.tasks.find((candidate) => candidate.sessionId === sessionId)
  return task === undefined ? { kind: "unknown-task" } : { kind: "found", registration, task }
}

function respondWorkerContextMissing(response: ServerResponse, context: WorkerContext, slug: string, sessionId: string): void {
  if (context.kind === "unknown-slug") {
    respondJson(response, 404, { error: `no first mate registered for slug ${slug}` })
    return
  }
  respondJson(response, 404, { error: `no worker with session id ${sessionId} on ${slug}'s backlog` })
}

// A failed relay answers with the error; a missing CLI answers 503 like
// /launch does.
function respondActionError(response: ServerResponse, error: unknown, fallback: string): void {
  if (error instanceof MissingCliError) {
    respondJson(response, 503, { error: error.message, code: "cli-missing" })
    return
  }
  respondJson(response, 500, { error: error instanceof Error ? error.message : fallback })
}

async function handleSteer(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const payload = await readJsonRecord(request)
  const slug = recordString(payload, "slug")
  const sessionId = recordString(payload, "sessionId")
  const text = recordString(payload, "text")
  if (slug === undefined || sessionId === undefined || text === undefined) {
    respondJson(response, 400, { error: "slug, sessionId, and text must be non-empty strings" })
    return
  }
  try {
    const context = await findProjectWorker(slug, sessionId)
    if (context.kind !== "found") {
      respondWorkerContextMissing(response, context, slug, sessionId)
      return
    }
    // An archived worker has left the board; steering blind is refused.
    const archivedSessionIds = await loadArchivedSessionIds(nodeFileSystem, homeRoot, slug)
    if (archivedSessionIds.has(sessionId)) {
      respondJson(response, 409, { error: `the worker with session id ${sessionId} is archived` })
      return
    }
    const outcome = await steerWorker({
      exec: nodeExec,
      worker: { sessionId, title: context.task.title },
      workerDirectory: context.registration.projectDirectory,
      coordinator: { sessionId: context.registration.coordinatorSessionId, directory: context.registration.homeDirectory },
      text,
    })
    // The steer reached the worker; the poller forwards its answer once.
    supervisionPoller.markSteered(slug, sessionId)
    if (outcome.coordinatorNotified) {
      respondJson(response, 200, { sent: true })
      return
    }
    respondJson(response, 200, {
      sent: true,
      warning: `steered the worker, but could not tell the coordinator: ${outcome.coordinatorError}`,
    })
  } catch (error) {
    respondActionError(response, error, "steer failed")
  }
}

async function handleRelaunch(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const payload = await readJsonRecord(request)
  const slug = recordString(payload, "slug")
  const sessionId = recordString(payload, "sessionId")
  const note = recordString(payload, "note")
  if (slug === undefined || sessionId === undefined || note === undefined) {
    respondJson(response, 400, { error: "slug, sessionId, and note must be non-empty strings" })
    return
  }
  try {
    const context = await findProjectWorker(slug, sessionId)
    if (context.kind !== "found") {
      respondWorkerContextMissing(response, context, slug, sessionId)
      return
    }
    // An archived worker has left the board; the coordinator relaunches from
    // its own record, not from a hidden card.
    const archivedSessionIds = await loadArchivedSessionIds(nodeFileSystem, homeRoot, slug)
    if (archivedSessionIds.has(sessionId)) {
      respondJson(response, 409, { error: `the worker with session id ${sessionId} is archived` })
      return
    }
    if (context.task.worktreeDirectory === undefined) {
      respondJson(response, 400, { error: `the worker "${context.task.title}" has no worktree directory recorded in the backlog` })
      return
    }
    await requestRelaunch({
      exec: nodeExec,
      worker: { sessionId, title: context.task.title },
      worktreeDirectory: context.task.worktreeDirectory,
      coordinator: { sessionId: context.registration.coordinatorSessionId, directory: context.registration.homeDirectory },
      note,
    })
    respondJson(response, 200, { requested: true })
  } catch (error) {
    respondActionError(response, error, "relaunch failed")
  }
}

// Interrupt is the gated workaround from ticket 08: no contract surface
// exposes stop/abort, so the service tries the managed opencode server's own
// session.abort discovered from the OpenChamber CLI's local settings. A host
// without that private path answers 501 — reported, never silently absorbed.
async function handleInterrupt(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const payload = await readJsonRecord(request)
  const slug = recordString(payload, "slug")
  const sessionId = recordString(payload, "sessionId")
  if (slug === undefined || sessionId === undefined) {
    respondJson(response, 400, { error: "slug and sessionId must be non-empty strings" })
    return
  }
  try {
    const context = await findProjectWorker(slug, sessionId)
    if (context.kind !== "found") {
      respondWorkerContextMissing(response, context, slug, sessionId)
      return
    }
    // An archived worker has left the board; there is no turn left to stop.
    const archivedSessionIds = await loadArchivedSessionIds(nodeFileSystem, homeRoot, slug)
    if (archivedSessionIds.has(sessionId)) {
      respondJson(response, 409, { error: `the worker with session id ${sessionId} is archived` })
      return
    }
    const support = await discoverSupport({ filesystem: nodeFileSystem, settingsPath: openchamberSettingsPath })
    const outcome = await interruptWorker({
      fetcher: nodeFetcher,
      support,
      sessionId,
      directory: context.registration.projectDirectory,
    })
    if (outcome.kind === "ok") {
      respondJson(response, 200, { interrupted: true })
      return
    }
    if (outcome.kind === "unsupported") {
      respondJson(response, 501, { error: "interrupt is not supported on this host", detail: outcome.reason })
      return
    }
    respondJson(response, 502, { error: "the abort call failed", detail: outcome.message })
  } catch (error) {
    respondJson(response, 500, { error: error instanceof Error ? error.message : "interrupt failed" })
  }
}

async function handleEnd(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const payload = await readJsonRecord(request)
  const slug = recordString(payload, "slug")
  const sessionId = recordString(payload, "sessionId")
  if (slug === undefined || sessionId === undefined) {
    respondJson(response, 400, { error: "slug and sessionId must be non-empty strings" })
    return
  }
  try {
    const context = await findProjectWorker(slug, sessionId)
    if (context.kind !== "found") {
      respondWorkerContextMissing(response, context, slug, sessionId)
      return
    }
    // Extension-owned archive: the card leaves the board and supervision, and
    // the session and worktree are left exactly as they are. Archiving an
    // already-archived worker is a no-op, not a duplicate entry.
    const archivedSessionIds = await loadArchivedSessionIds(nodeFileSystem, homeRoot, slug)
    if (!archivedSessionIds.has(sessionId)) {
      await archiveSession(nodeFileSystem, homeRoot, slug, {
        sessionId,
        title: context.task.title,
        archivedAt: new Date(clock.nowMs()).toISOString(),
      })
    }
    respondJson(response, 200, { archived: true })
  } catch (error) {
    respondJson(response, 500, { error: error instanceof Error ? error.message : "archive failed" })
  }
}

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!isAuthorized(request)) {
    respondJson(response, 401, { error: "unauthorized" })
    return
  }
  const url = new URL(request.url ?? "/", "http://127.0.0.1")
  const pathname = url.pathname
  if (request.method === "GET" && pathname === "/health") {
    respondJson(response, 200, { status: "ok" })
    return
  }
  if (request.method === "POST" && pathname === "/provision") {
    await handleProvision(request, response)
    return
  }
  if (request.method === "POST" && pathname === "/launch") {
    await handleLaunch(request, response)
    return
  }
  if (request.method === "GET" && pathname === "/registry") {
    await handleRegistryList(response)
    return
  }
  if (request.method === "GET" && pathname.startsWith("/registry/")) {
    const slug = decodeURIComponent(pathname.slice("/registry/".length))
    if (slug !== "") {
      await handleRegistryItem(slug, response)
      return
    }
  }
  if (request.method === "GET" && pathname === "/lookup") {
    await handleLookup(url, response)
    return
  }
  if (request.method === "GET" && pathname === "/backlog") {
    await handleBacklog(url, response)
    return
  }
  if (request.method === "GET" && pathname === "/board") {
    await handleBoard(url, response)
    return
  }
  if (request.method === "POST" && pathname === "/steer") {
    await handleSteer(request, response)
    return
  }
  if (request.method === "POST" && pathname === "/relaunch") {
    await handleRelaunch(request, response)
    return
  }
  if (request.method === "POST" && pathname === "/interrupt") {
    await handleInterrupt(request, response)
    return
  }
  if (request.method === "POST" && pathname === "/end") {
    await handleEnd(request, response)
    return
  }
  response.statusCode = 404
  response.end()
}

const server = createServer((request, response) => {
  handleRequest(request, response).catch(() => {
    if (!response.writableEnded) {
      respondJson(response, 500, { error: "internal error" })
    }
  })
})
server.listen(servicePort, "127.0.0.1")

const pollTimer = clock.startInterval(() => {
  void runSupervisionRound()
}, pollIntervalMs)

function stopService(): void {
  pollTimer.cancel()
  server.close(() => process.exit(0))
  // A lingering keep-alive connection must not keep the host's child alive.
  setTimeout(() => process.exit(0), 500).unref()
}
process.on("SIGTERM", stopService)
process.on("SIGINT", stopService)
