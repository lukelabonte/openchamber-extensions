import { createServer, type IncomingMessage, type ServerResponse } from "node:http"
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { composeInstructions } from "./compose"
import type { FileSystemPort } from "./file-system"
import { provisionProject } from "./provision"

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
  listDirectories: async (directoryPath) => {
    try {
      const entries = await readdir(directoryPath, { withFileTypes: true })
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    } catch {
      return []
    }
  },
}

const templateReader = (templateName: string): Promise<string> =>
  readFile(path.join(templatesDirectory, templateName), "utf8")

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

async function handleProvision(request: IncomingMessage, response: ServerResponse): Promise<void> {
  let payload: unknown
  try {
    payload = await readJsonBody(request)
  } catch {
    respondJson(response, 400, { error: "request body must be JSON" })
    return
  }
  const projectDirectory = isRecord(payload) ? payload.projectDirectory : undefined
  if (typeof projectDirectory !== "string" || projectDirectory.trim() === "") {
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

async function handleRequest(request: IncomingMessage, response: ServerResponse): Promise<void> {
  if (!isAuthorized(request)) {
    respondJson(response, 401, { error: "unauthorized" })
    return
  }
  const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname
  if (request.method === "GET" && pathname === "/health") {
    respondJson(response, 200, { status: "ok" })
    return
  }
  if (request.method === "POST" && pathname === "/provision") {
    await handleProvision(request, response)
    return
  }
  response.statusCode = 404
  response.end()
}

createServer((request, response) => {
  handleRequest(request, response).catch(() => {
    if (!response.writableEnded) {
      respondJson(response, 500, { error: "internal error" })
    }
  })
}).listen(servicePort, "127.0.0.1")
