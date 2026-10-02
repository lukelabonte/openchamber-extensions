import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

// The supervision loop runs on a fast poll interval against a shim CLI: no
// test ever touches the real openchamber binary or the real ~/.config. The
// shim reports every call to a log so the tests can assert what the poller
// sent to the coordinator.
const serviceToken = "test-token"
const pollIntervalMs = 50

let tempRoot: string
let tempHome: string
let shimDirectory: string
let shimLogPath: string
let serviceProcess: ChildProcess | undefined
let servicePort = 0

beforeAll(async () => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "firstmate-board-test-"))
  tempHome = path.join(tempRoot, "home")
  shimDirectory = path.join(tempRoot, "shim")
  shimLogPath = path.join(tempRoot, "shim-calls.log")
  mkdirSync(shimDirectory)
  writeFileSync(
    path.join(shimDirectory, "openchamber"),
    [
      "#!/bin/sh",
      'printf \'%s\\n\' "$*" >> "$FIRSTMATE_SHIM_LOG"',
      '# args: session <subcommand> --session <id> --dir <path> ... — so the',
      '# subcommand is $2 and the session id is $4.',
      'case "$2" in',
      "  status)",
      '    case "$4" in',
      "      ses_fail) echo 'no such session' >&2; exit 1 ;;",
      "      *) echo '{\"type\":\"waiting-question\"}' ;;",
      "    esac ;;",
      "  messages) echo '{\"text\":\"Stuck on: which test runner?\"}' ;;",
      "  send)",
      '    case "$*" in',
      "      *projects/storm*) echo 'no such session' >&2; exit 1 ;;",
      "      *) echo '{\"ok\":true}' ;;",
      "    esac ;;",
      "  *) echo '{}' ;;",
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
      storm: {
        slug: "storm",
        projectDirectory: "/repos/storm",
        homeDirectory: path.join(tempHome, "projects", "storm"),
        coordinatorSessionId: "ses_coord_2",
        createdAt: "2026-10-01T08:00:00Z",
      },
    }),
  )
  writeFileSync(
    path.join(sunriseHome, "backlog.md"),
    [
      "- Fix flaky login test",
      "  state: Working",
      "  session: ses_11bb",
      "  branch: fm/login-fix",
      "  pr: https://github.com/example/sunrise/pull/11",
      "",
      "- Broken worker",
      "  state: Working",
      "  session: ses_fail",
      "",
      "- Not dispatched yet",
      "  state: Queued",
      "",
    ].join("\n"),
  )
  const stormHome = path.join(tempHome, "projects", "storm")
  mkdirSync(stormHome, { recursive: true })
  writeFileSync(
    path.join(stormHome, "backlog.md"),
    ["- Storm worker", "  state: Working", "  session: ses_77"].join("\n"),
  )

  servicePort = await getFreePort()
  serviceProcess = spawn(process.execPath, [path.join(import.meta.dir, "..", "service", "main.ts")], {
    env: {
      ...process.env,
      OPENCHAMBER_SERVICE_PORT: String(servicePort),
      OPENCHAMBER_SERVICE_TOKEN: serviceToken,
      FIRSTMATE_HOME: tempHome,
      FIRSTMATE_POLL_MS: String(pollIntervalMs),
      FIRSTMATE_SHIM_LOG: shimLogPath,
      PATH: `${shimDirectory}:${process.env.PATH ?? ""}`,
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

async function waitUntilShimSendsToCoordinator(): Promise<void> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (shimSendsToCoordinator() >= 1) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("the poller never sent a notification to the coordinator")
}

function shimLogLines(): string[] {
  try {
    return readFileSync(shimLogPath, "utf8").split("\n")
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error
    // The log does not exist until the first poll round calls the shim; that
    // is zero sends, not a failure.
    return []
  }
}

function shimSendsToCoordinator(): number {
  return shimLogLines().filter((line) => line.includes("session send --session ses_coord_1")).length
}

function shimNotification(): string {
  const log = readFileSync(shimLogPath, "utf8")
  const start = log.indexOf("session send --session ses_coord_1")
  const rest = log.slice(start)
  const nextCall = rest.indexOf("\nsession ", 1)
  return nextCall === -1 ? rest : rest.slice(0, nextCall)
}

function fetchBoard(query: string, headers: Record<string, string> = { authorization: `Bearer ${serviceToken}` }): Promise<Response> {
  return fetch(`http://127.0.0.1:${servicePort}/board${query}`, { headers })
}

interface BoardWorkerBody {
  title: string
  state: string
  blockedReason?: string
  lastWord?: string
  prUrl?: string
  sessionId?: string
  worktree?: string
  branch?: string
  lastPollError?: string
}

describe("GET /board", () => {
  test("answers the supervised workers with refined states, last words, and poll errors", async () => {
    await waitUntilShimSendsToCoordinator()

    const response = await fetchBoard("?slug=sunrise")
    expect(response.status).toBe(200)
    const body = (await response.json()) as { workers: BoardWorkerBody[] }
    expect(body.workers).toEqual([
      {
        title: "Fix flaky login test",
        state: "Blocked",
        blockedReason: "question",
        lastWord: "Stuck on: which test runner?",
        prUrl: "https://github.com/example/sunrise/pull/11",
        sessionId: "ses_11bb",
        branch: "fm/login-fix",
      },
      {
        title: "Broken worker",
        state: "Working",
        sessionId: "ses_fail",
        lastPollError: expect.stringContaining("no such session"),
      },
      { title: "Not dispatched yet", state: "Queued" },
    ])
  })

  test("one message per worker per transition: several polls, still exactly one send", async () => {
    await waitUntilShimSendsToCoordinator()
    const sendsAfterFirstRound = shimSendsToCoordinator()
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs * 6))

    expect(shimSendsToCoordinator()).toBe(sendsAfterFirstRound)
  })

  test("the coordinator notification carries the worker events as one message", async () => {
    await waitUntilShimSendsToCoordinator()

    // The shim logs the send arguments verbatim; the prompt's newlines split
    // the entry across log lines, so the whole entry is inspected.
    const notification = shimNotification()
    expect(notification).toContain("--dir")
    expect(notification).toContain("worker update")
    expect(notification).toContain('"Fix flaky login test"')
    expect(notification).toContain("waiting on a question")
  })

  test("a failed coordinator delivery is surfaced in the board data", async () => {
    await waitUntilShimSendsToCoordinator()

    const response = await fetchBoard("?slug=storm")
    expect(response.status).toBe(200)
    const body = (await response.json()) as { workers: BoardWorkerBody[]; deliveryError?: string }
    expect(body.deliveryError).toContain("no such session")
  })

  test("answers 404 for an unknown slug", async () => {
    const response = await fetchBoard("?slug=elsewhere")
    expect(response.status).toBe(404)
    expect(((await response.json()) as { error: string }).error).toContain("elsewhere")
  })

  test("answers 401 without a token", async () => {
    const response = await fetchBoard("?slug=sunrise", {})
    expect(response.status).toBe(401)
  })
})
