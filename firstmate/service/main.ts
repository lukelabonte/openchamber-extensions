import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { spawn } from "node:child_process"
import { access, chmod, mkdir, readFile, readdir, rename, stat, writeFile, appendFile, constants as fsConstants } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { requestRelaunch, sendCoordinatorMessage, steerWorker } from "./actions"
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
import { loadLandingRecords } from "./landing-record"
import { parseShippingMode } from "./shipping-mode"
import { loadSuggestions, removeSuggestion, sendSuggestion, suggestionsPath, type Suggestion } from "./suggestions"
import { parseCronExpression } from "./watch-schedule"
import { createWatchRunner, type WatchExecPort } from "./watches"

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
  createDirectory: async (directoryPath) => {
    // Recursive mkdir reports the first directory it created; the port wants void.
    await mkdir(directoryPath, { recursive: true })
  },
  rename: (fromPath, toPath) => rename(fromPath, toPath),
  listDirectories: async (directoryPath) => {
    try {
      const entries = await readdir(directoryPath, { withFileTypes: true })
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch {
      return []
    }
  },
  listExecutableFiles: async (directoryPath) => {
    const names: string[] = []
    let entries
    try {
      entries = await readdir(directoryPath, { withFileTypes: true })
    } catch {
      return []
    }
    for (const entry of entries) {
      if (!entry.isFile()) continue
      try {
        await access(path.join(directoryPath, entry.name), fsConstants.X_OK)
        names.push(entry.name)
      } catch {
        // Not executable → not a watch.
      }
    }
    return names
  },
  setExecutable: (filePath) => chmod(filePath, 0o755),
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

// Watch scripts run as the executables they are (shebangs, user-owned), with
// the project home as their working directory, the env contract from the
// spec, a hard timeout, and a stdout cap. The runner owns the timeout value;
// this port honors whatever it is passed. The byte cap keeps the TAIL of the
// output — the newest lines — and says how much head was dropped, so the
// truncation marker the coordinator sees is honest about the full output.
const watchOutputCapBytes = 256 * 1024

const nodeWatchExec: WatchExecPort = ({ scriptPath, cwd, env, timeoutMs }) =>
  new Promise((resolve, reject) => {
    const child = spawn(scriptPath, [], { cwd, env: { ...process.env, ...env }, stdio: ["ignore", "pipe", "pipe"] })
    const stdoutChunks: Buffer[] = []
    let totalBytes = 0
    let tailBytes = 0
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill()
    }, timeoutMs)
    child.stdout.on("data", (chunk: Buffer) => {
      totalBytes += chunk.length
      stdoutChunks.push(chunk)
      tailBytes += chunk.length
      while (tailBytes > watchOutputCapBytes) {
        const overflow = tailBytes - watchOutputCapBytes
        const first = stdoutChunks[0]
        if (first.length <= overflow) {
          stdoutChunks.shift()
          tailBytes -= first.length
        } else {
          stdoutChunks[0] = first.subarray(overflow)
          tailBytes -= overflow
        }
      }
    })
    child.on("error", (error) => {
      clearTimeout(timer)
      reject(error)
    })
    child.on("close", (code) => {
      clearTimeout(timer)
      const droppedHeadBytes = totalBytes - tailBytes
      const kept = Buffer.concat(stdoutChunks).toString("utf8")
      resolve({
        stdout: droppedHeadBytes > 0 ? `…[truncated ${droppedHeadBytes} bytes]\n${kept}` : kept,
        exitCode: code,
        timedOut,
      })
    })
  })

const templateReader = (templateName: string): Promise<string> =>
  readFile(path.join(templatesDirectory, templateName), "utf8")

const defaultPollIntervalMs = 15_000
const defaultWatchIntervalMs = 60_000

function readIntervalMs(env: string | undefined, fallback: number, name: string): number {
  const raw = process.env[env]
  if (raw === undefined || raw.trim() === "") return fallback
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`)
  }
  return value
}

function readPollIntervalMs(): number {
  return readIntervalMs("FIRSTMATE_POLL_MS", defaultPollIntervalMs, "FIRSTMATE_POLL_MS")
}

// Watch ticks are cheap discovery+due checks; the schedule granularity itself
// is minutes. The override exists so tests can tick faster.
function readWatchIntervalMs(): number {
  return readIntervalMs("FIRSTMATE_WATCH_MS", defaultWatchIntervalMs, "FIRSTMATE_WATCH_MS")
}

const pollIntervalMs = readPollIntervalMs()
const watchIntervalMs = readWatchIntervalMs()
const clock = createNodeClock()
const supervisionPoller = createSupervisionPoller({
  filesystem: nodeFileSystem,
  exec: nodeExec,
  homeRoot,
  fetcher: nodeFetcher,
  resolveSupport: () => discoverSupport({ filesystem: nodeFileSystem, settingsPath: openchamberSettingsPath }),
})
const watchRunner = createWatchRunner({
  filesystem: nodeFileSystem,
  exec: nodeWatchExec,
  clock,
  homeRoot,
  fetcher: nodeFetcher,
  resolveSupport: () => discoverSupport({ filesystem: nodeFileSystem, settingsPath: openchamberSettingsPath }),
})

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

// One watch round: run every due watch, then deliver its notifications to the
// project's coordinator. Like the supervision round, rounds never overlap and
// a failed delivery is absorbed — the coordinator's answer (or the board's
// delivery error slot) is where a lost watch message would surface from.
let watchRoundInFlight = false

async function runWatchRound(): Promise<void> {
  if (watchRoundInFlight) return
  watchRoundInFlight = true
  try {
    const round = await watchRunner.tick()
    for (const notification of round.notifications) {
      try {
        await deliverNotification({ exec: nodeExec, clock, notification })
      } catch {
        // Never thrown into the interval; the next due run re-reports.
      }
    }
  } catch {
    // A tick must never reject into the interval — an unhandled rejection
    // would kill the service. The round is skipped; the next one re-reads.
  } finally {
    watchRoundInFlight = false
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

// The optional watch-source discriminator on toggle/schedule requests: absent
// means "resolve by name", anything but the two canonical values is refused.
function isWatchSource(value: unknown): value is "shared" | "project" | undefined {
  return value === undefined || value === "shared" || value === "project"
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
    // Auto-accept is discovered per launch like the interrupt fallback: the
    // coordinator session is switched to auto-approve permissions, and a host
    // without that surface simply launches without it.
    const support = await discoverSupport({ filesystem: nodeFileSystem, settingsPath: openchamberSettingsPath })
    const { registration } = await launchFirstMate({
      filesystem: nodeFileSystem,
      exec: nodeExec,
      templateReader,
      homeRoot,
      projectDirectory,
      fetcher: nodeFetcher,
      support,
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
    if (outcome.coordinatorNotified === false) {
      respondJson(response, 200, {
        sent: true,
        warning: `steered the worker, but could not tell the coordinator: ${outcome.coordinatorError}`,
      })
      return
    }
    respondJson(response, 200, { sent: true })
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

// Watches: the card lists every watch of a registered project (shared ones
// included, keyed per project for their enabled switch); toggling persists to
// the project's settings.json.
async function handleWatchesList(url: URL, response: ServerResponse): Promise<void> {
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
    const watches = await watchRunner.listWatches(slug)
    respondJson(response, 200, { watches })
  } catch (error) {
    respondJson(response, 500, { error: error instanceof Error ? error.message : "watches read failed" })
  }
}

async function handleWatchesToggle(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const payload = await readJsonRecord(request)
  const slug = recordString(payload, "slug")
  const name = recordString(payload, "name")
  const enabled = payload?.enabled
  const source = payload?.source
  if (slug === undefined || name === undefined || typeof enabled !== "boolean") {
    respondJson(response, 400, { error: "slug and name must be non-empty strings and enabled a boolean" })
    return
  }
  if (!isWatchSource(source)) {
    respondJson(response, 400, { error: `source must be "shared" or "project" when given` })
    return
  }
  try {
    const registrations = await loadRegistry(nodeFileSystem, homeRoot)
    if (!Object.hasOwn(registrations, slug)) {
      respondJson(response, 404, { error: `no first mate registered for slug ${slug}` })
      return
    }
    const result = await watchRunner.setEnabled(slug, source, name, enabled)
    if (result === "unknown-watch") {
      respondJson(response, 404, { error: `no watch named ${name} for slug ${slug}` })
      return
    }
    if (result === "ambiguous-watch") {
      respondJson(response, 409, {
        error: `the watch name ${name} matches both a shared and a project watch for ${slug}; pass source "shared" or "project"`,
      })
      return
    }
    respondJson(response, 200, { toggled: true, name, enabled })
  } catch (error) {
    respondJson(response, 500, { error: error instanceof Error ? error.message : "watch toggle failed" })
  }
}

// Schedule edits and creation join the toggle: the watch is resolved by name
// among the project's listed watches (shared ones included, an optional
// source narrows it like the toggle), and the schedule itself is validated by
// the service-side parser — its own message names the expression and the
// offending field, exactly the 400 body the captain needs to fix the input.
function scheduleValidOrRespond(response: ServerResponse, schedule: string): boolean {
  try {
    parseCronExpression(schedule)
    return true
  } catch (error) {
    respondJson(response, 400, { error: error instanceof Error ? error.message : "invalid watch schedule" })
    return false
  }
}

async function handleWatchSchedule(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const payload = await readJsonRecord(request)
  const slug = recordString(payload, "slug")
  const name = recordString(payload, "name")
  const schedule = recordString(payload, "schedule")
  const source = payload?.source
  if (slug === undefined || name === undefined || schedule === undefined) {
    respondJson(response, 400, { error: "slug, name, and schedule must be non-empty strings" })
    return
  }
  if (!isWatchSource(source)) {
    respondJson(response, 400, { error: `source must be "shared" or "project" when given` })
    return
  }
  if (!scheduleValidOrRespond(response, schedule)) return
  try {
    const registrations = await loadRegistry(nodeFileSystem, homeRoot)
    if (!Object.hasOwn(registrations, slug)) {
      respondJson(response, 404, { error: `no first mate registered for slug ${slug}` })
      return
    }
    const result = await watchRunner.setSchedule(slug, source, name, schedule)
    if (result === "unknown-watch") {
      respondJson(response, 404, { error: `no watch named ${name} for slug ${slug}` })
      return
    }
    if (result === "ambiguous-watch") {
      respondJson(response, 409, {
        error: `the watch name ${name} matches both a shared and a project watch for ${slug}; pass source "shared" or "project"`,
      })
      return
    }
    respondJson(response, 200, { updated: true, schedule })
  } catch (error) {
    respondJson(response, 500, { error: error instanceof Error ? error.message : "watch schedule update failed" })
  }
}

// Created watch names become file names under the project's watches/
// directory — lowercase letters, digits, and dashes only, so no traversal,
// slashes, or spaces can reach the path.
const watchNamePattern = /^[a-z0-9][a-z0-9-]{0,39}$/
const watchCommandMaxLength = 2000

async function handleWatchCreate(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const payload = await readJsonRecord(request)
  const slug = recordString(payload, "slug")
  const name = recordString(payload, "name")
  const schedule = recordString(payload, "schedule")
  const command = recordString(payload, "command")
  if (slug === undefined || name === undefined || schedule === undefined || command === undefined) {
    respondJson(response, 400, { error: "slug, name, schedule, and command must be non-empty strings" })
    return
  }
  if (!watchNamePattern.test(name)) {
    respondJson(response, 400, {
      error: "name must be at most 40 characters of lowercase letters, digits, and dashes, starting with a letter or digit",
    })
    return
  }
  if (!scheduleValidOrRespond(response, schedule)) return
  if (command.length > watchCommandMaxLength) {
    respondJson(response, 400, { error: `command must be at most ${watchCommandMaxLength} characters` })
    return
  }
  try {
    const registrations = await loadRegistry(nodeFileSystem, homeRoot)
    if (!Object.hasOwn(registrations, slug)) {
      respondJson(response, 404, { error: `no first mate registered for slug ${slug}` })
      return
    }
    const result = await watchRunner.createWatch(slug, name, schedule, command)
    if (result === "duplicate-watch") {
      respondJson(response, 409, { error: `a watch named ${name} already exists for slug ${slug}` })
      return
    }
    respondJson(response, 200, { created: true, name })
  } catch (error) {
    respondJson(response, 500, { error: error instanceof Error ? error.message : "watch creation failed" })
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

// Shipping: the mode parsed from the project's projects.md (the record; the
// coordinator reads it itself, this endpoint feeds the panel) plus all of
// the project's landing records.
async function handleShipping(url: URL, response: ServerResponse): Promise<void> {
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
    const projectsMdPath = `${homeRoot}/projects/${slug}/projects.md`
    const shipping = (await nodeFileSystem.exists(projectsMdPath))
      ? parseShippingMode(await nodeFileSystem.readFile(projectsMdPath))
      : { mode: null, yolo: false }
    const landings = await loadLandingRecords(nodeFileSystem, homeRoot, slug)
    respondJson(response, 200, {
      mode: shipping.mode,
      yolo: shipping.yolo,
      landings: landings.records,
      landingErrors: landings.errors.map((error) => `line ${error.line}: ${error.message}`),
    })
  } catch (error) {
    respondJson(response, 500, { error: error instanceof Error ? error.message : "shipping read failed" })
  }
}

// Suggestions: the coordinator keeps suggestions.md (one
// `- <label> :: <what to send>` per line); the panel renders each as a
// button. Sending relays the suggestion's text to the coordinator verbatim
// and then removes the line; dismissing removes it without sending. A failed
// send leaves the line on disk — the captain can press again.
async function resolveSuggestion(
  slug: string,
  label: string,
): Promise<
  | { kind: "unknown-slug" }
  | { kind: "unknown-label" }
  | { kind: "duplicate-label" }
  | { kind: "found"; registration: Registration; suggestion: Suggestion }
> {
  const registrations = await loadRegistry(nodeFileSystem, homeRoot)
  if (!Object.hasOwn(registrations, slug)) return { kind: "unknown-slug" }
  const suggestions = await loadSuggestions(nodeFileSystem, suggestionsPath(homeRoot, slug))
  const matches = suggestions.filter((candidate) => candidate.label === label)
  if (matches.length === 0) return { kind: "unknown-label" }
  // An ambiguous label must never resolve to "whichever entry came first";
  // both lines stay and the action is refused.
  if (matches.length > 1) return { kind: "duplicate-label" }
  const suggestion = matches[0]
  return suggestion === undefined
    ? { kind: "unknown-label" }
    : { kind: "found", registration: registrations[slug], suggestion }
}

async function handleSuggestions(url: URL, response: ServerResponse): Promise<void> {
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
    const suggestions = await loadSuggestions(nodeFileSystem, suggestionsPath(homeRoot, slug))
    respondJson(response, 200, { suggestions })
  } catch (error) {
    respondJson(response, 500, { error: error instanceof Error ? error.message : "suggestions read failed" })
  }
}

// One suggestion action per project at a time, shared by send and dismiss and
// taken before the async resolve: a second action while one is in flight is
// refused with 409 instead of double-sending or racing the file rewrite.
// Projects are independent, the map entry lives only for the action's flight,
// and the guard only serializes this service's own actions — an external
// writer (the coordinator) can still rewrite suggestions.md between the
// service's read and its write, and no internal lock removes that race.
const busySuggestionProjects = new Set<string>()

function acquireSuggestionProject(slug: string): boolean {
  if (busySuggestionProjects.has(slug)) return false
  busySuggestionProjects.add(slug)
  return true
}

async function handleSuggestionAction(request: IncomingMessage, response: ServerResponse, action: "send" | "dismiss"): Promise<void> {
  const payload = await readJsonRecord(request)
  const slug = recordString(payload, "slug")
  const label = recordString(payload, "label")
  if (slug === undefined || label === undefined) {
    respondJson(response, 400, { error: "slug and label must be non-empty strings" })
    return
  }
  if (!acquireSuggestionProject(slug)) {
    respondJson(response, 409, { error: `another suggestion action for ${slug} is still in flight` })
    return
  }
  try {
    const context = await resolveSuggestion(slug, label)
    if (context.kind === "unknown-slug") {
      respondJson(response, 404, { error: `no first mate registered for slug ${slug}` })
      return
    }
    if (context.kind === "unknown-label") {
      respondJson(response, 404, { error: `no suggestion labeled "${label}" on ${slug}'s suggestions.md` })
      return
    }
    if (context.kind === "duplicate-label") {
      respondJson(response, 409, { error: `the label "${label}" appears more than once in ${slug}'s suggestions.md` })
      return
    }
    if (action === "send") {
      // The send-then-remove composition lives in suggestions.ts: a failed send
      // throws unchanged (the line stays ready to press again), while a failed
      // removal after a successful send is answered as a warning, not an error
      // — the coordinator already has the message.
      const outcome = await sendSuggestion(nodeFileSystem, suggestionsPath(homeRoot, slug), context.suggestion, (text) =>
        sendCoordinatorMessage({
          exec: nodeExec,
          coordinator: {
            sessionId: context.registration.coordinatorSessionId,
            directory: context.registration.homeDirectory,
          },
          text,
        }),
      )
      respondJson(response, 200, outcome)
      return
    }
    await removeSuggestion(nodeFileSystem, suggestionsPath(homeRoot, slug), label)
    respondJson(response, 200, { dismissed: true })
  } catch (error) {
    if (action === "send") {
      respondActionError(response, error, "suggestion send failed")
      return
    }
    respondJson(response, 500, { error: error instanceof Error ? error.message : "suggestion dismiss failed" })
  } finally {
    busySuggestionProjects.delete(slug)
  }
}

async function handleSuggestionSend(request: IncomingMessage, response: ServerResponse): Promise<void> {
  await handleSuggestionAction(request, response, "send")
}

async function handleSuggestionDismiss(request: IncomingMessage, response: ServerResponse): Promise<void> {
  await handleSuggestionAction(request, response, "dismiss")
}

// /bearings and /ahoy: the panel composes nothing — the command word is
// relayed to the coordinator as the message, verbatim; the variant that also
// writes a dated report into reports/ is spelled "bearings-file" on the wire.
const commandPrompts: Record<string, string> = {
  bearings: "/bearings",
  "bearings-file": "/bearings file",
  ahoy: "/ahoy",
}

async function handleCommand(request: IncomingMessage, response: ServerResponse): Promise<void> {
  const payload = await readJsonRecord(request)
  const slug = recordString(payload, "slug")
  const command = recordString(payload, "command")
  if (slug === undefined || command === undefined) {
    respondJson(response, 400, { error: "slug and command must be non-empty strings" })
    return
  }
  const prompt = commandPrompts[command]
  if (prompt === undefined) {
    respondJson(response, 400, { error: `unknown command "${command}"` })
    return
  }
  try {
    const registrations = await loadRegistry(nodeFileSystem, homeRoot)
    if (!Object.hasOwn(registrations, slug)) {
      respondJson(response, 404, { error: `no first mate registered for slug ${slug}` })
      return
    }
    const registration = registrations[slug]
    await sendCoordinatorMessage({
      exec: nodeExec,
      coordinator: { sessionId: registration.coordinatorSessionId, directory: registration.homeDirectory },
      text: prompt,
    })
    respondJson(response, 200, { sent: true })
  } catch (error) {
    respondActionError(response, error, "command send failed")
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
  if (request.method === "GET" && pathname === "/watches") {
    await handleWatchesList(url, response)
    return
  }
  if (request.method === "GET" && pathname === "/shipping") {
    await handleShipping(url, response)
    return
  }
  if (request.method === "GET" && pathname === "/suggestions") {
    await handleSuggestions(url, response)
    return
  }
  if (request.method === "POST" && pathname === "/suggestion/send") {
    await handleSuggestionSend(request, response)
    return
  }
  if (request.method === "POST" && pathname === "/suggestion/dismiss") {
    await handleSuggestionDismiss(request, response)
    return
  }
  if (request.method === "POST" && pathname === "/command") {
    await handleCommand(request, response)
    return
  }
  if (request.method === "POST" && pathname === "/watches/toggle") {
    await handleWatchesToggle(request, response)
    return
  }
  if (request.method === "POST" && pathname === "/watch/schedule") {
    await handleWatchSchedule(request, response)
    return
  }
  if (request.method === "POST" && pathname === "/watch/create") {
    await handleWatchCreate(request, response)
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

const watchTimer = clock.startInterval(() => {
  void runWatchRound()
}, watchIntervalMs)

function stopService(): void {
  pollTimer.cancel()
  watchTimer.cancel()
  server.close(() => process.exit(0))
  // A lingering keep-alive connection must not keep the host's child alive.
  setTimeout(() => process.exit(0), 500).unref()
}
process.on("SIGTERM", stopService)
process.on("SIGINT", stopService)
