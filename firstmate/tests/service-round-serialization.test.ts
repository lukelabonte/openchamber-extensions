import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

// Regression test for round serialization: the service's poll interval must
// never start a round while a previous one is still in flight. A shim status
// call blocks on a gate file, holding the first round open across several
// interval ticks; without the in-flight guard, the ticks that overlap it poll
// the same not-yet-recorded transition and the coordinator receives the same
// notification once per overlapping round. No real CLI or ~/.config is touched.
const serviceToken = "test-token"
const pollIntervalMs = 30

let tempRoot: string
let tempHome: string
let shimDirectory: string
let shimLogPath: string
let statusGatePath: string
let serviceProcess: ChildProcess | undefined
let servicePort = 0

beforeAll(async () => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "firstmate-round-test-"))
  tempHome = path.join(tempRoot, "home")
  shimDirectory = path.join(tempRoot, "shim")
  shimLogPath = path.join(tempRoot, "shim-calls.log")
  statusGatePath = path.join(tempRoot, "status-gate")
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
      "      ses_slow)",
      '        while [ ! -f "$FIRSTMATE_STATUS_GATE" ]; do sleep 0.05; done',
      "        echo '{\"type\":\"waiting-question\"}' ;;",
      "      *) echo '{\"type\":\"waiting-question\"}' ;;",
      "    esac ;;",
      "  messages) echo '{\"text\":\"the last word\"}' ;;",
      "  send) echo '{\"ok\":true}' ;;",
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
    }),
  )
  // One worker only: with every round blocked on its status, no round can
  // report a different worker's transition ahead of the blocked one.
  writeFileSync(
    path.join(sunriseHome, "backlog.md"),
    ["- Slow worker", "  state: Working", "  session: ses_slow"].join("\n"),
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
      FIRSTMATE_STATUS_GATE: statusGatePath,
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

function shimLogLines(): string[] {
  try {
    return readFileSync(shimLogPath, "utf8").split("\n")
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error
    return []
  }
}

function shimSendsToCoordinator(): number {
  return shimLogLines().filter((line) => line.includes("session send --session ses_coord_1")).length
}

async function waitUntil(predicate: () => boolean, failure: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(failure)
}

describe("supervision round serialization", () => {
  test("one send per transition even while a delivery is slow enough for other ticks to fire", async () => {
    // Round one is now in flight, blocked on the slow status call.
    await waitUntil(
      () => shimLogLines().some((line) => line.includes("session status --session ses_slow")),
      "the first poll round never reached the slow worker",
    )

    // Several interval ticks fire while round one is still blocked.
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs * 5))

    // Release the blocked status and let the round finish, plus a few more
    // ticks so any duplicate round would have sent its own copy.
    writeFileSync(statusGatePath, "go")
    await waitUntil(() => shimSendsToCoordinator() >= 1, "the poller never sent a notification to the coordinator")
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs * 5))

    expect(shimSendsToCoordinator()).toBe(1)
  })
})
