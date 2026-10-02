import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

// Card actions end to end: the service relays Steer/Relaunch over the control
// CLI and archives End state in the project home. A shim CLI stands in for the
// real openchamber binary and logs every call, so the tests assert what the
// service actually sent — and what it never sent (End touches nothing).
const serviceToken = "test-token"
const pollIntervalMs = 50
const serviceRoot = path.join(import.meta.dir, "..")
const serviceEntry = path.join(serviceRoot, "service", "main.ts")

let tempRoot: string
let tempHome: string
let shimDirectory: string
let shimLogPath: string
let backlogPath: string
let backlogOnDisk: string
let serviceProcess: ChildProcess | undefined
let servicePort = 0

beforeAll(async () => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "firstmate-actions-test-"))
  tempHome = path.join(tempRoot, "home")
  shimDirectory = path.join(tempRoot, "shim")
  shimLogPath = path.join(tempRoot, "shim-calls.log")
  mkdirSync(shimDirectory)
  writeFileSync(
    path.join(shimDirectory, "openchamber"),
    [
      "#!/bin/sh",
      'printf \'%s\\n\' "$*" >> "$FIRSTMATE_SHIM_LOG"',
      'case "$2" in',
      "  status) echo '{\"type\":\"waiting-question\"}' ;;",
      "  messages) echo '{\"text\":\"Stuck on: which test runner?\"}' ;;",
      "  send)",
      '    case "$*" in',
      "      *ses_coord_1*FAILCOORD*) echo 'no such session' >&2; exit 1 ;;",
      "      *) echo '{\"ok\":true}' ;;",
      "    esac ;;",
      "  *) echo '{\"ok\":true}' ;;",
      "esac",
      "",
    ].join("\n"),
  )
  chmodSync(path.join(shimDirectory, "openchamber"), 0o755)

  const sunriseHome = path.join(tempHome, "projects", "sunrise")
  mkdirSync(sunriseHome, { recursive: true })
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
    }),
  )
  backlogPath = path.join(sunriseHome, "backlog.md")
  backlogOnDisk = [
    "- Fix flaky login test",
    "  state: Working",
    "  session: ses_11bb",
    "  worktree: /repos/sunrise/.worktrees/fm/login-fix",
    "",
    "- No worktree worker",
    "  state: Working",
    "  session: ses_nw",
    "",
    "- Third worker",
    "  state: Working",
    "  session: ses_33",
    "  worktree: /repos/sunrise/.worktrees/fm/third",
    "",
    "- Not dispatched yet",
    "  state: Queued",
    "",
  ].join("\n")
  writeFileSync(backlogPath, backlogOnDisk)

  await startService(await getFreePort())
})

afterAll(() => {
  serviceProcess?.kill()
  rmSync(tempRoot, { recursive: true, force: true })
})

function startService(port: number): Promise<void> {
  serviceProcess?.kill()
  servicePort = port
  serviceProcess = spawn(process.execPath, [serviceEntry], {
    env: {
      ...process.env,
      OPENCHAMBER_SERVICE_PORT: String(port),
      OPENCHAMBER_SERVICE_TOKEN: serviceToken,
      FIRSTMATE_HOME: tempHome,
      FIRSTMATE_POLL_MS: String(pollIntervalMs),
      FIRSTMATE_SHIM_LOG: shimLogPath,
      PATH: `${shimDirectory}:${process.env.PATH ?? ""}`,
    },
    stdio: ["ignore", "ignore", "ignore"],
  })
  return waitUntilListening(port)
}

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

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${serviceToken}`, "content-type": "application/json" }
}

async function post(pathname: string, body: unknown, headers: Record<string, string> = authHeaders()): Promise<Response> {
  return fetch(`http://127.0.0.1:${servicePort}${pathname}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

async function boardWorkers(): Promise<{ title: string; sessionId?: string }[]> {
  const response = await fetch(`http://127.0.0.1:${servicePort}/board?slug=sunrise`, {
    headers: { authorization: `Bearer ${serviceToken}` },
  })
  expect(response.status).toBe(200)
  return ((await response.json()) as { workers: { title: string; sessionId?: string }[] }).workers
}

function shimLogLines(): string[] {
  try {
    return readFileSync(shimLogPath, "utf8").split("\n")
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error
    return []
  }
}

function shimSendsTo(sessionId: string): string[] {
  return shimLogLines().filter((line) => line.includes(`session send --session ${sessionId}`))
}

// Coordinator notifications are matched by their content, not by log position:
// steers, relaunches, and poller updates all land in one shared log.
function shimCoordinatorSendsContaining(substring: string): string[] {
  return shimSendsTo("ses_coord_1").filter((line) => line.includes(substring))
}

function shimStatusPolls(sessionId: string): number {
  return shimLogLines().filter((line) => line.includes(`session status --session ${sessionId}`)).length
}

async function waitUntil(condition: () => boolean, what: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`${what} never happened within 5 seconds`)
}

describe("POST /steer", () => {
  test("sends the captain's text to the worker and tells the coordinator", async () => {
    const response = await post("/steer", { slug: "sunrise", sessionId: "ses_11bb", text: "focus on the flake first" })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ sent: true })
    await waitUntil(() => shimCoordinatorSendsContaining("steered worker").length >= 1, "the coordinator notification")
    const toWorker = shimSendsTo("ses_11bb")
    expect(toWorker.length).toBeGreaterThanOrEqual(1)
    expect(toWorker[toWorker.length - 1]).toContain("--dir /repos/sunrise")
    expect(toWorker[toWorker.length - 1]).toContain("--prompt focus on the flake first")
    const notification = shimCoordinatorSendsContaining("focus on the flake first")[0]
    expect(notification).toContain("--dir")
    expect(notification).toContain("steered worker")
    expect(notification).toContain("Fix flaky login test")
  })

  test("a failed coordinator notify still answers 200 with a warning", async () => {
    // The shim fails coordinator sends whose prompt carries the FAILCOORD marker.
    const response = await post("/steer", { slug: "sunrise", sessionId: "ses_11bb", text: "FAILCOORD do the thing" })

    expect(response.status).toBe(200)
    const body = (await response.json()) as { sent?: boolean; warning?: string }
    expect(body.sent).toBe(true)
    expect(body.warning).toContain("steered the worker, but could not tell the coordinator")
    expect(body.warning).toContain("no such session")
  })

  test("answers 400 on a missing or blank field", async () => {
    for (const body of [
      { slug: "sunrise", sessionId: "ses_11bb" },
      { slug: "sunrise", sessionId: "ses_11bb", text: "   " },
      { sessionId: "ses_11bb", text: "hi" },
      "not an object",
    ]) {
      const response = await post("/steer", body)
      expect(response.status).toBe(400)
    }
  })

  test("answers 404 for an unknown slug and an unknown session", async () => {
    const unknownSlug = await post("/steer", { slug: "elsewhere", sessionId: "ses_11bb", text: "hi" })
    expect(unknownSlug.status).toBe(404)
    const unknownSession = await post("/steer", { slug: "sunrise", sessionId: "ses_absent", text: "hi" })
    expect(unknownSession.status).toBe(404)
  })

  test("answers 401 without a token", async () => {
    const response = await post("/steer", { slug: "sunrise", sessionId: "ses_11bb", text: "hi" }, { "content-type": "application/json" })
    expect(response.status).toBe(401)
  })
})

describe("POST /relaunch", () => {
  test("relays the worker, its worktree, and the note to the coordinator without touching the backlog", async () => {
    const response = await post("/relaunch", {
      slug: "sunrise",
      sessionId: "ses_11bb",
      note: "start over with a clean brief",
    })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ requested: true })
    const relays = shimCoordinatorSendsContaining("relaunch")
    expect(relays.length).toBeGreaterThanOrEqual(1)
    const relay = relays[relays.length - 1]
    expect(relay).toContain("Fix flaky login test")
    expect(relay).toContain("/repos/sunrise/.worktrees/fm/login-fix")
    expect(relay).toContain("start over with a clean brief")
    // Backlog writes are the coordinator's job; the service only relays.
    expect(readFileSync(backlogPath, "utf8")).toBe(backlogOnDisk)
  })

  test("answers 400 when the worker has no worktree directory recorded", async () => {
    const response = await post("/relaunch", { slug: "sunrise", sessionId: "ses_nw", note: "again" })
    expect(response.status).toBe(400)
  })

  test("answers 400 on bad input and 404 for an unknown slug or session", async () => {
    const missingNote = await post("/relaunch", { slug: "sunrise", sessionId: "ses_11bb" })
    expect(missingNote.status).toBe(400)
    const unknownSlug = await post("/relaunch", { slug: "elsewhere", sessionId: "ses_11bb", note: "n" })
    expect(unknownSlug.status).toBe(404)
    const unknownSession = await post("/relaunch", { slug: "sunrise", sessionId: "ses_absent", note: "n" })
    expect(unknownSession.status).toBe(404)
  })
})

describe("POST /end", () => {
  test("archives the card, excludes it from the board, and leaves backlog, session, and worktree untouched", async () => {
    await waitUntil(() => shimStatusPolls("ses_11bb") >= 1, "the first poll of the worker")

    const response = await post("/end", { slug: "sunrise", sessionId: "ses_11bb" })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ archived: true })
    expect((await boardWorkers()).map((worker) => worker.title)).toEqual([
      "No worktree worker",
      "Third worker",
      "Not dispatched yet",
    ])

    const archive = readFileSync(path.join(tempHome, "projects", "sunrise", "reports", "archive.jsonl"), "utf8")
    expect(archive).toContain("ses_11bb")
    expect(readFileSync(backlogPath, "utf8")).toBe(backlogOnDisk)
    // No session or worktree command ever targets the ended worker beyond the
    // ordinary status/messages polling that happened before the archive.
    expect(shimLogLines().some((line) => line.includes("delete"))).toBe(false)
  })

  test("archiving twice does not duplicate the entry", async () => {
    const response = await post("/end", { slug: "sunrise", sessionId: "ses_11bb" })
    expect(response.status).toBe(200)
    const archive = readFileSync(path.join(tempHome, "projects", "sunrise", "reports", "archive.jsonl"), "utf8")
    expect(archive.split("\n").filter((line) => line.includes("ses_11bb"))).toHaveLength(1)
  })

  test("the poller stops polling the archived worker", async () => {
    const pollsAtEnd = shimStatusPolls("ses_11bb")
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs * 6))
    expect(shimStatusPolls("ses_11bb")).toBe(pollsAtEnd)
  })

  test("answers 400 on bad input and 404 for an unknown slug or session", async () => {
    const missingSession = await post("/end", { slug: "sunrise" })
    expect(missingSession.status).toBe(400)
    const unknownSlug = await post("/end", { slug: "elsewhere", sessionId: "ses_11bb" })
    expect(unknownSlug.status).toBe(404)
    const unknownSession = await post("/end", { slug: "sunrise", sessionId: "ses_absent" })
    expect(unknownSession.status).toBe(404)
  })

  test("archived state survives a service restart", async () => {
    serviceProcess?.kill()
    await startService(await getFreePort())

    expect((await boardWorkers()).map((worker) => worker.title)).toEqual([
      "No worktree worker",
      "Third worker",
      "Not dispatched yet",
    ])

    // Supervision stays off the archived worker after the restart too.
    const pollsAfterRestart = shimStatusPolls("ses_11bb")
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs * 6))
    expect(shimStatusPolls("ses_11bb")).toBe(pollsAfterRestart)
  })
})

describe("archived workers refuse steer and relaunch", () => {
  test("POST /steer and /relaunch answer 409 for an archived session", async () => {
    const end = await post("/end", { slug: "sunrise", sessionId: "ses_33" })
    expect(end.status).toBe(200)

    const steer = await post("/steer", { slug: "sunrise", sessionId: "ses_33", text: "hello" })
    expect(steer.status).toBe(409)
    expect(((await steer.json()) as { error: string }).error).toContain("archived")

    const relaunch = await post("/relaunch", { slug: "sunrise", sessionId: "ses_33", note: "again" })
    expect(relaunch.status).toBe(409)
  })
})
