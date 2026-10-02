import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

// The /shipping endpoint only reads files, so this harness needs no CLI shim:
// a temp FIRSTMATE_HOME with a seeded registry, projects.md, and landings.md
// stands in for registered projects, and no real ~/.config path is touched.
const serviceToken = "test-token"

let tempRoot: string
let tempHome: string
let serviceProcess: ChildProcess | undefined
let servicePort = 0

beforeAll(async () => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "firstmate-shipping-test-"))
  tempHome = path.join(tempRoot, "home")
  const sunriseHome = path.join(tempHome, "projects", "sunrise")
  const drifterHome = path.join(tempHome, "projects", "drifter")
  mkdirSync(path.join(sunriseHome, "reports"), { recursive: true })
  mkdirSync(drifterHome, { recursive: true })
  writeFileSync(
    path.join(tempHome, "registry.json"),
    JSON.stringify({
      sunrise: {
        slug: "sunrise",
        projectDirectory: "/repos/sunrise",
        homeDirectory: sunriseHome,
        coordinatorSessionId: "ses_coord_1",
        createdAt: "2026-10-01T08:00:00Z",
      },
      drifter: {
        slug: "drifter",
        projectDirectory: "/repos/drifter",
        homeDirectory: drifterHome,
        coordinatorSessionId: "ses_coord_2",
        createdAt: "2026-10-01T08:00:00Z",
      },
    }),
  )
  writeFileSync(path.join(sunriseHome, "projects.md"), "mode: reviewed-PR+yolo\n")
  const landings: string[] = [
    "# Landings",
    "",
    "One landing per entry: a `- ` bullet with the task title, then indented `key: value` lines — commit, ci, mode, authorization, landed (ISO 8601).",
    "",
  ]
  for (let index = 1; index <= 21; index += 1) {
    landings.push(
      `- Task ${index}`,
      "  commit: 1a2b3c4d",
      "  ci: green",
      "  mode: reviewed-PR+yolo",
      "  authorization: +yolo",
      `  landed: 2026-10-01T10:${String(index).padStart(2, "0")}:00.000Z`,
    )
  }
  writeFileSync(path.join(sunriseHome, "reports", "landings.md"), `${landings.join("\n")}\n`)
  writeFileSync(path.join(drifterHome, "projects.md"), "mode: unset — ask the captain\n")

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

function fetchShipping(query: string, headers: Record<string, string> = { authorization: `Bearer ${serviceToken}` }): Promise<Response> {
  return fetch(`http://127.0.0.1:${servicePort}/shipping${query}`, { headers })
}

describe("GET /shipping", () => {
  test("answers the parsed mode and the recent landing records for a registered slug", async () => {
    const response = await fetchShipping("?slug=sunrise")
    expect(response.status).toBe(200)
    const body = (await response.json()) as {
      mode: string | null
      yolo: boolean
      landings: Array<{ task: string; commit: string; ci: string; mode: string; authorization: string; landedAt: string }>
    }
    expect(body.mode).toBe("reviewed-PR")
    expect(body.yolo).toBe(true)
    // The fixture seeds 21 landings and the endpoint keeps the last 20, so
    // Task 1 has already fallen off the front.
    expect(body.landings).toHaveLength(20)
    expect(body.landings[0]).toEqual({
      task: "Task 2",
      commit: "1a2b3c4d",
      ci: "green",
      mode: "reviewed-PR+yolo",
      authorization: "+yolo",
      landedAt: "2026-10-01T10:02:00.000Z",
    })
    expect(body.landings[19]).toEqual({
      task: "Task 21",
      commit: "1a2b3c4d",
      ci: "green",
      mode: "reviewed-PR+yolo",
      authorization: "+yolo",
      landedAt: "2026-10-01T10:21:00.000Z",
    })
  })

  test("keeps only the last 20 landing records", async () => {
    const response = await fetchShipping("?slug=sunrise")
    const body = (await response.json()) as { landings: Array<{ task: string }> }
    expect(body.landings).toHaveLength(20)
    expect(body.landings[0].task).toBe("Task 2")
    expect(body.landings[19].task).toBe("Task 21")
  })

  test("answers the unset result when projects.md keeps the template default", async () => {
    const response = await fetchShipping("?slug=drifter")
    expect(response.status).toBe(200)
    const body = (await response.json()) as { mode: string | null; yolo: boolean; landings: unknown[] }
    expect(body.mode).toBeNull()
    expect(body.yolo).toBe(false)
    expect(body.landings).toEqual([])
  })

  test("answers 404 for an unknown slug", async () => {
    const response = await fetchShipping("?slug=elsewhere")
    expect(response.status).toBe(404)
    expect(((await response.json()) as { error: string }).error).toContain("elsewhere")
  })

  test("answers 400 when the slug is missing", async () => {
    const response = await fetchShipping("")
    expect(response.status).toBe(400)
  })

  test("answers 401 without a token and with a wrong token", async () => {
    const noToken = await fetchShipping("?slug=sunrise", {})
    expect(noToken.status).toBe(401)
    const wrongToken = await fetchShipping("?slug=sunrise", { authorization: "Bearer wrong-token" })
    expect(wrongToken.status).toBe(401)
  })
})
