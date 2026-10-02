import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { createServer, type Server } from "node:http"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

// The /interrupt endpoint end to end: the service discovers the managed
// opencode server from the OpenChamber settings file (a private-surface
// workaround — no contract surface exposes abort) and calls session.abort
// through a stub HTTP server standing in for that server.

const serviceToken = "test-token"
const serviceRoot = path.join(import.meta.dir, "..")
const serviceEntry = path.join(serviceRoot, "service", "main.ts")

let tempRoot: string
let tempHome: string
let settingsPath: string
let serviceProcess: ChildProcess | undefined
let servicePort = 0

let abortServer: Server
let abortPort = 0
let abortCalls: { method: string; url: string | undefined; authorization: string | undefined }[] = []
let abortStatus = 200

beforeAll(async () => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "firstmate-interrupt-test-"))
  tempHome = path.join(tempRoot, "home")
  settingsPath = path.join(tempRoot, "openchamber-settings.json")
  mkdirSync(path.join(tempHome, "projects", "sunrise"), { recursive: true })
  writeFileSync(
    path.join(tempHome, "registry.json"),
    JSON.stringify({
      sunrise: {
        slug: "sunrise",
        projectDirectory: "/repos/sunrise",
        homeDirectory: path.join(tempHome, "projects", "sunrise"),
        coordinatorSessionId: "ses_coord_1",
        createdAt: "2026-10-01T08:00:00Z",
      },
    }),
  )
  writeFileSync(
    path.join(tempHome, "projects", "sunrise", "backlog.md"),
    ["- Fix flaky login test", "  state: Working", "  session: ses_11bb", ""].join("\n"),
  )

  abortServer = createServer((request, response) => {
    abortCalls.push({ method: request.method ?? "", url: request.url, authorization: request.headers.authorization })
    response.statusCode = abortStatus
    response.setHeader("content-type", "application/json")
    response.end("{}")
  })
  abortPort = await listenOnFreePort(abortServer)

  writeValidSettings()
  await startService(await getFreePort())
})

afterAll(() => {
  serviceProcess?.kill()
  abortServer.close()
  rmSync(tempRoot, { recursive: true, force: true })
})

beforeEach(() => {
  abortCalls = []
  abortStatus = 200
  writeValidSettings()
})

function writeValidSettings(): void {
  writeFileSync(settingsPath, JSON.stringify({ desktopLocalPort: abortPort, desktopLocalClientToken: "tok_local" }))
}

function listenOnFreePort(server: Server): Promise<number> {
  return new Promise((resolve, reject) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address !== null && typeof address === "object") {
        resolve(address.port)
        return
      }
      reject(new Error("could not determine the stub server port"))
    })
    server.on("error", reject)
  })
}

function startService(port: number): Promise<void> {
  serviceProcess?.kill()
  servicePort = port
  serviceProcess = spawn(process.execPath, [serviceEntry], {
    env: {
      ...process.env,
      OPENCHAMBER_SERVICE_PORT: String(port),
      OPENCHAMBER_SERVICE_TOKEN: serviceToken,
      FIRSTMATE_HOME: tempHome,
      FIRSTMATE_POLL_MS: "60000",
      FIRSTMATE_OPENCHAMBER_SETTINGS: settingsPath,
    },
    stdio: ["ignore", "ignore", "ignore"],
  })
  return waitUntilListening(port)
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      probe.close(() => {
        if (address !== null && typeof address === "object") {
          resolve(address.port)
          return
        }
        reject(new Error("could not determine a free port"))
      })
    })
    probe.on("error", reject)
  })
}

async function waitUntilListening(port: number): Promise<void> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try {
      await fetch(`http://127.0.0.1:${port}/health`)
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new Error("service did not start listening within 5 seconds")
}

async function post(pathname: string, body: unknown, headers: Record<string, string> = authHeaders()): Promise<Response> {
  return fetch(`http://127.0.0.1:${servicePort}${pathname}`, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  })
}

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${serviceToken}`, "content-type": "application/json" }
}

describe("POST /interrupt", () => {
  test("aborts the worker session on the managed opencode server", async () => {
    const response = await post("/interrupt", { slug: "sunrise", sessionId: "ses_11bb" })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ interrupted: true })
    expect(abortCalls).toHaveLength(1)
    expect(abortCalls[0].method).toBe("POST")
    expect(abortCalls[0].url).toBe(`/api/session/ses_11bb/abort?directory=${encodeURIComponent("/repos/sunrise")}`)
    expect(abortCalls[0].authorization).toBe("Bearer tok_local")
  })

  test("answers 502 when the abort call fails", async () => {
    abortStatus = 500

    const response = await post("/interrupt", { slug: "sunrise", sessionId: "ses_11bb" })

    expect(response.status).toBe(502)
    const body = (await response.json()) as { error?: string; detail?: string }
    expect(body.error).toBe("the abort call failed")
    expect(typeof body.detail).toBe("string")
  })

  test("answers 501 when the host offers no fallback path", async () => {
    writeFileSync(settingsPath, "this is not json")

    const response = await post("/interrupt", { slug: "sunrise", sessionId: "ses_11bb" })

    expect(response.status).toBe(501)
    const body = (await response.json()) as { error?: string; detail?: string }
    expect(body.error).toBe("interrupt is not supported on this host")
    expect(typeof body.detail).toBe("string")
  })

  test("answers 404 for an unknown slug and an unknown session", async () => {
    const unknownSlug = await post("/interrupt", { slug: "elsewhere", sessionId: "ses_11bb" })
    expect(unknownSlug.status).toBe(404)
    const unknownSession = await post("/interrupt", { slug: "sunrise", sessionId: "ses_absent" })
    expect(unknownSession.status).toBe(404)
  })

  test("answers 401 without a token", async () => {
    const response = await post("/interrupt", { slug: "sunrise", sessionId: "ses_11bb" }, { "content-type": "application/json" })
    expect(response.status).toBe(401)
  })
})

describe("archived workers refuse interrupt", () => {
  test("answers 409 for an archived session", async () => {
    const end = await post("/end", { slug: "sunrise", sessionId: "ses_11bb" })
    expect(end.status).toBe(200)

    const response = await post("/interrupt", { slug: "sunrise", sessionId: "ses_11bb" })
    expect(response.status).toBe(409)
    expect(((await response.json()) as { error: string }).error).toContain("archived")
  })
})
