import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

// The /backlog endpoint only reads files, so this harness needs no CLI shim:
// a temp FIRSTMATE_HOME with a seeded registry and backlog stands in for a
// registered project, and no real ~/.config path is ever touched.
const serviceToken = "test-token"

let tempRoot: string
let tempHome: string
let serviceProcess: ChildProcess | undefined
let servicePort = 0

beforeAll(async () => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "firstmate-backlog-test-"))
  tempHome = path.join(tempRoot, "home")
  const projectHome = path.join(tempHome, "projects", "sunrise")
  mkdirSync(projectHome, { recursive: true })
  writeFileSync(
    path.join(tempHome, "registry.json"),
    JSON.stringify({
      sunrise: {
        slug: "sunrise",
        projectDirectory: "/repos/sunrise",
        homeDirectory: projectHome,
        coordinatorSessionId: "ses_coord_1",
        createdAt: "2026-10-01T08:00:00Z",
      },
    }),
  )
  writeFileSync(
    path.join(projectHome, "backlog.md"),
    [
      "# Backlog",
      "",
      "- Fix flaky login test",
      "  state: Done",
      "  session: ses_11bb",
      "  pr: https://github.com/example/sunrise/pull/11",
      "  created: 2026-10-01T09:30:00Z",
      "  updated: 2026-10-01T09:45:00Z",
      "",
      "- Mystery task",
      "  state: Woking",
      "",
    ].join("\n"),
  )

  servicePort = await getFreePort()
  serviceProcess = spawn(process.execPath, [path.join(import.meta.dir, "..", "service", "main.ts")], {
    env: {
      ...process.env,
      OPENCHAMBER_SERVICE_PORT: String(servicePort),
      OPENCHAMBER_SERVICE_TOKEN: serviceToken,
      FIRSTMATE_HOME: tempHome,
    },
    stdio: ["ignore", "ignore", "ignore"],
  })
  await waitUntilListening(servicePort)
})

afterAll(() => {
  serviceProcess?.kill()
  rmSync(tempRoot, { recursive: true, force: true })
})

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address !== null && typeof address === "object") {
        const port = address.port
        server.close(() => resolve(port))
        return
      }
      server.close()
      reject(new Error("could not determine a free port"))
    })
    server.on("error", reject)
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

function fetchBacklog(query: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${servicePort}/backlog${query}`, {
    headers: { authorization: `Bearer ${serviceToken}` },
  })
}

describe("GET /backlog", () => {
  test("answers the parsed backlog for a registered slug", async () => {
    const response = await fetchBacklog("?slug=sunrise")
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      tasks: Array<Record<string, unknown>>
      errors: Array<{ line: number; message: string }>
    }
    expect(body.tasks).toEqual([
      {
        title: "Fix flaky login test",
        state: "Done",
        sessionId: "ses_11bb",
        prUrl: "https://github.com/example/sunrise/pull/11",
        createdAt: "2026-10-01T09:30:00Z",
        updatedAt: "2026-10-01T09:45:00Z",
      },
    ])
    expect(body.errors).toHaveLength(1)
    expect(body.errors[0].message).toContain("Mystery task")
  })

  test("answers 404 for an unknown slug", async () => {
    const response = await fetchBacklog("?slug=elsewhere")
    expect(response.status).toBe(404)
    expect(((await response.json()) as { error: string }).error).toContain("elsewhere")
  })

  test("answers 400 when the slug is missing", async () => {
    const response = await fetchBacklog("")
    expect(response.status).toBe(400)
  })

  test("answers 404 for a prototype-name slug", async () => {
    const response = await fetchBacklog("?slug=constructor")
    expect(response.status).toBe(404)
  })

  test("answers 404 for an escape-attempting slug", async () => {
    const response = await fetchBacklog(`?slug=${encodeURIComponent("../..")}`)
    expect(response.status).toBe(404)
  })

  test("answers 401 without a token and with a wrong token", async () => {
    const noToken = await fetch(`http://127.0.0.1:${servicePort}/backlog?slug=sunrise`)
    expect(noToken.status).toBe(401)
    const wrongToken = await fetch(`http://127.0.0.1:${servicePort}/backlog?slug=sunrise`, {
      headers: { authorization: "Bearer wrong-token" },
    })
    expect(wrongToken.status).toBe(401)
  })
})
