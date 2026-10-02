import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { spawn } from "node:child_process"
import { mkdir, readFile, readdir, rename, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { loadBacklog } from "./backlog"
import { composeInstructions } from "./compose"
import { createNodeClock } from "./clock"
import { MissingCliError, type ExecRunner } from "./control-client"
import type { FileSystemPort } from "./file-system"
import { deliverNotification } from "./forwarder"
import { launchFirstMate } from "./launch"
import { createSupervisionPoller } from "./poller"
import { provisionProject } from "./provision"
import { findRegistration, loadRegistry } from "./registry"

const rawServicePort = process.env.OPENCHAMBER_SERVICE_PORT
const serviceToken = process.env.OPENCHAMBER_SERVICE_TOKEN
const homeRoot = process.env.FIRSTMATE_HOME ?? path.join(homedir(), ".config", "firstmate")
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
    const workers = supervisionPoller.getBoardWorkers(slug, backlog.tasks)
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
