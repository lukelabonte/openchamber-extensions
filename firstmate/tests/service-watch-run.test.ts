import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

// POST /watch/run end to end against a private spawned service: a temp
// FIRSTMATE_HOME, a shim `openchamber` CLI on PATH (every send is logged, a
// mode file makes sends fail or answer busy — never a real host or session),
// and an absent FIRSTMATE_OPENCHAMBER_SETTINGS so no desktop notification
// leaves the machine. Every fixture watch's schedule is `5 4 29 2 *` —
// valid, but next due on a Feb 29 night years away — so nothing runs on the
// scheduler's own tick and a run-now response proves the manual path needs
// no cron-minute wait.

const serviceToken = "test-token"
const serviceRoot = path.join(import.meta.dir, "..")
const serviceEntry = path.join(serviceRoot, "service", "main.ts")
const projectDirectory = "/repos/sunrise"
// A valid expression whose first fire is far outside any test's lifetime.
const neverDueSchedule = "5 4 29 2 *"

let tempRoot: string
let tempHome: string
let projectHome: string
let markersDirectory: string
let releaseFilePath: string
let sendModePath: string
let shimLogPath: string
let serviceProcess: ChildProcess | undefined
let servicePort = 0

beforeAll(async () => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "firstmate-watch-run-test-"))
  tempHome = path.join(tempRoot, "home")
  const shimBin = path.join(tempRoot, "bin")
  projectHome = path.join(tempHome, "projects", "sunrise")
  markersDirectory = path.join(tempRoot, "markers")
  releaseFilePath = path.join(tempRoot, "release")
  sendModePath = path.join(tempRoot, "send-mode")
  shimLogPath = path.join(tempRoot, "shim.log")
  mkdirSync(shimBin)
  mkdirSync(markersDirectory)
  mkdirSync(path.join(tempHome, "shared", "watches"), { recursive: true })
  mkdirSync(path.join(projectHome, "watches"), { recursive: true })

  writeFileSync(
    path.join(tempHome, "registry.json"),
    JSON.stringify({
      sunrise: {
        slug: "sunrise",
        projectDirectory,
        homeDirectory: projectHome,
        coordinatorSessionId: "ses_coord_1",
        createdAt: "2026-10-01T08:00:00Z",
      },
    }),
  )

  // The shim logs every invocation; a `session send` fails while the mode
  // file exists — with busy wording when the file says "busy", so the
  // service's SessionBusyError classification is exercised too.
  const shim = path.join(shimBin, "openchamber")
  writeFileSync(
    shim,
    `#!/bin/sh
echo "$@" >> "$OPENCHAMBER_SHIM_LOG"
case " $* " in
  *" send "*)
    if [ -f "$OPENCHAMBER_SEND_MODE" ]; then
      if [ "$(cat "$OPENCHAMBER_SEND_MODE")" = "busy" ]; then
        echo "the session is busy and cannot accept a message right now" >&2
      else
        echo "session send failed for the test" >&2
      fi
      exit 1
    fi
    ;;
esac
exit 0
`,
  )
  chmodSync(shim, 0o755)

  writeWatch(path.join(projectHome, "watches", "flaky"), `echo "partial signal"\ntouch "${path.join(markersDirectory, "flaky")}"\nexit 3\n`)
  writeWatch(path.join(tempHome, "shared", "watches", "twin"), `echo "shared twin ran"\ntouch "${path.join(markersDirectory, "twin-shared")}"\n`)
  writeWatch(path.join(projectHome, "watches", "twin"), `echo "project twin ran"\ntouch "${path.join(markersDirectory, "twin-project")}"\n`)
  writeWatch(path.join(projectHome, "watches", "broken"), "", "# schedule: 0 25 * * *\n")
  writeWatch(
    path.join(projectHome, "watches", "slow"),
    `touch "${path.join(markersDirectory, "slow-start")}"\ni=0\nwhile [ "$i" -lt 300 ] && [ ! -f "${releaseFilePath}" ]; do\n  sleep 0.01\n  i=$((i+1))\ndone\necho "slow finished"\ntouch "${path.join(markersDirectory, "slow-done")}"\n`,
  )
  writeWatch(path.join(projectHome, "watches", "notify"), `echo "notify ran"\ntouch "${path.join(markersDirectory, "notify")}"\n`)
  writeWatch(path.join(projectHome, "watches", "other"), `echo "other ran"\ntouch "${path.join(markersDirectory, "other")}"\n`)

  servicePort = await startService()
}, 30_000)

afterAll(() => {
  serviceProcess?.kill()
  rmSync(tempRoot, { recursive: true, force: true })
})

function writeWatch(filePath: string, body: string, scheduleComment = `# schedule: ${neverDueSchedule}\n`): void {
  writeFileSync(filePath, `#!/bin/sh\n${scheduleComment}${body}`)
  chmodSync(filePath, 0o755)
}

function startService(): Promise<number> {
  return new Promise((resolve, reject) => {
    getFreePort().then((port) => {
      serviceProcess = spawn(process.execPath, [serviceEntry], {
        env: {
          ...process.env,
          OPENCHAMBER_SERVICE_PORT: String(port),
          OPENCHAMBER_SERVICE_TOKEN: serviceToken,
          FIRSTMATE_HOME: tempHome,
          FIRSTMATE_POLL_MS: "60000",
          FIRSTMATE_WATCH_MS: "1000",
          // The settings read points at a file that does not exist, so the
          // desktop notification host resolves as unsupported and nothing
          // ever reaches the developer's real desktop server.
          FIRSTMATE_OPENCHAMBER_SETTINGS: path.join(tempRoot, "absent-settings.json"),
          OPENCHAMBER_SHIM_LOG: shimLogPath,
          OPENCHAMBER_SEND_MODE: sendModePath,
          PATH: `${path.join(tempRoot, "bin")}:${process.env.PATH ?? ""}`,
        },
        stdio: ["ignore", "ignore", "ignore"],
      })
      waitUntilListening(port).then(() => resolve(port), reject)
    }, reject)
  })
}

function getFreePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = net.createServer()
    probe.listen(0, "127.0.0.1", () => {
      const address = probe.address()
      probe.close(() => {
        if (address !== null && typeof address === "object") resolve(address.port)
        else reject(new Error("could not determine a free port"))
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

// Bounded polling for fixture-side readiness signals (a marker a script
// writes when it starts), mirroring waitForShim's deadline discipline.
async function waitFor(predicate: () => boolean, description: string, deadlineMs = 5000): Promise<void> {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(`timed out waiting for ${description}`)
}

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${serviceToken}`, "content-type": "application/json" }
}

function get(pathname: string, headers: Record<string, string> = authHeaders()): Promise<Response> {
  return fetch(`http://127.0.0.1:${servicePort}${pathname}`, { headers })
}

function post(pathname: string, body: unknown, headers: Record<string, string> = authHeaders()): Promise<Response> {
  return fetch(`http://127.0.0.1:${servicePort}${pathname}`, { method: "POST", headers, body: JSON.stringify(body) })
}

function shimLog(): string {
  return existsSync(shimLogPath) ? readFileSync(shimLogPath, "utf8") : ""
}

function sendLines(containing: string): string[] {
  return shimLog()
    .split("\n")
    .filter((line) => line.includes("session") && line.includes("send") && line.includes(containing))
}

interface RunResponse {
  ran?: boolean
  name?: string
  source?: string
  lastOutcome?: string
  lastError?: string
  deliveryError?: string
  error?: string
}

interface WatchesResponse {
  watches: Array<{ name: string; deliveryError?: string; lastOutcome?: string; lastError?: string; lastOutput?: string }>
  deliveryError?: string
}

function setSendMode(mode: string | undefined): void {
  if (mode === undefined) {
    if (existsSync(sendModePath)) rmSync(sendModePath)
    return
  }
  writeFileSync(sendModePath, mode)
}

describe("POST /watch/run resolution", () => {
  test("a failing script is a completed run: 200 with a failed lastOutcome and its reason", async () => {
    const response = await post("/watch/run", { slug: "sunrise", name: "flaky" })
    expect(response.status).toBe(200)
    const body = (await response.json()) as RunResponse
    expect(body.ran).toBe(true)
    expect(body.name).toBe("flaky")
    expect(body.source).toBe("project")
    expect(body.lastOutcome).toBe("failed")
    expect(body.lastError).toBe("exited with code 3")
    expect(body.deliveryError).toBeUndefined()
    expect(existsSync(path.join(markersDirectory, "flaky"))).toBe(true)

    const listed = (await (await get("/watches?slug=sunrise")).json()) as WatchesResponse
    const row = listed.watches.find((watch) => watch.name === "flaky")
    expect(row).toMatchObject({ lastOutcome: "failed", lastError: "exited with code 3", lastOutput: "partial signal" })
    // The failure notification reached the coordinator through the shim.
    expect(sendLines("watch flaky failed: exited with code 3")).toHaveLength(1)
  })

  test("answers 400 for bad input", async () => {
    expect((await post("/watch/run", { slug: "sunrise" })).status).toBe(400)
    expect((await post("/watch/run", { slug: "sunrise", name: "" })).status).toBe(400)
    expect((await post("/watch/run", { slug: "sunrise", name: "twin", source: "everywhere" })).status).toBe(400)
  })

  test("answers 401 without a token and executes nothing", async () => {
    const noToken = await post("/watch/run", { slug: "sunrise", name: "slow" }, { "content-type": "application/json" })
    expect(noToken.status).toBe(401)
    const wrongToken = await post("/watch/run", { slug: "sunrise", name: "slow" }, {
      authorization: "Bearer wrong-token",
      "content-type": "application/json",
    })
    expect(wrongToken.status).toBe(401)
    expect(existsSync(path.join(markersDirectory, "slow-start"))).toBe(false)
  })

  test("answers 404 for unknown slugs, unknown names, and traversal-shaped names without executing anything", async () => {
    expect((await post("/watch/run", { slug: "elsewhere", name: "twin" })).status).toBe(404)
    expect((await post("/watch/run", { slug: "sunrise", name: "absent" })).status).toBe(404)
    // The name is matched against discovered watches, never used to build a
    // path: a traversal shape matches nothing and runs nothing.
    const traversal = await post("/watch/run", { slug: "sunrise", name: "../twin" })
    expect(traversal.status).toBe(404)
    expect(existsSync(path.join(markersDirectory, "twin-shared"))).toBe(false)
    expect(existsSync(path.join(markersDirectory, "twin-project"))).toBe(false)
    expect(sendLines("../twin")).toEqual([])
  })

  test("answers 400 with the parser's reason for a broken-schedule watch", async () => {
    const response = await post("/watch/run", { slug: "sunrise", name: "broken" })
    expect(response.status).toBe(400)
    expect(((await response.json()) as RunResponse).error).toContain(`invalid watch schedule "0 25 * * *"`)
  })

  test("answers 409 when the name matches a shared and a project watch without a source", async () => {
    const response = await post("/watch/run", { slug: "sunrise", name: "twin" })
    expect(response.status).toBe(409)
    expect(((await response.json()) as RunResponse).error).toContain('pass source "shared" or "project"')
  })

  test("runs the distinct same-name watch for each source", async () => {
    const shared = await post("/watch/run", { slug: "sunrise", name: "twin", source: "shared" })
    expect(shared.status).toBe(200)
    expect((await shared.json()) as RunResponse).toMatchObject({ ran: true, name: "twin", source: "shared", lastOutcome: "ok" })
    expect(existsSync(path.join(markersDirectory, "twin-shared"))).toBe(true)
    expect(existsSync(path.join(markersDirectory, "twin-project"))).toBe(false)
    expect(shimLog()).toContain("shared twin ran")

    const project = await post("/watch/run", { slug: "sunrise", name: "twin", source: "project" })
    expect(project.status).toBe(200)
    expect((await project.json()) as RunResponse).toMatchObject({ ran: true, name: "twin", source: "project", lastOutcome: "ok" })
    expect(existsSync(path.join(markersDirectory, "twin-project"))).toBe(true)
    expect(shimLog()).toContain("project twin ran")
  })
})

describe("POST /watch/run concurrency", () => {
  test("answers 409 while the watch is already running, then the first run completes", async () => {
    const first = post("/watch/run", { slug: "sunrise", name: "slow" })
    await waitFor(() => existsSync(path.join(markersDirectory, "slow-start")), "the slow watch to start executing")

    const second = await post("/watch/run", { slug: "sunrise", name: "slow" })
    expect(second.status).toBe(409)
    expect(((await second.json()) as RunResponse).error).toContain("already running")

    writeFileSync(releaseFilePath, "go\n")
    const firstResponse = await first
    expect(firstResponse.status).toBe(200)
    const body = (await firstResponse.json()) as RunResponse
    expect(body).toMatchObject({ ran: true, name: "slow", lastOutcome: "ok" })
    expect(existsSync(path.join(markersDirectory, "slow-done"))).toBe(true)
  }, 15_000)
})

describe("watch delivery errors", () => {
  test("a failed send settles the run-now promptly with the per-watch error, the row, and the summary", async () => {
    setSendMode("fail")
    const started = Date.now()
    const response = await post("/watch/run", { slug: "sunrise", name: "notify" })
    const elapsedMs = Date.now() - started
    expect(response.status).toBe(200)
    const body = (await response.json()) as RunResponse
    // One immediate attempt, no busy backoff: the run settles long before a
    // retry loop could, with the delivery failure riding the response.
    expect(elapsedMs).toBeLessThan(5000)
    expect(body.ran).toBe(true)
    expect(body.lastOutcome).toBe("ok")
    expect(body.deliveryError).toContain("session send failed for the test")

    const listed = (await (await get("/watches?slug=sunrise")).json()) as WatchesResponse
    expect(listed.watches.find((watch) => watch.name === "notify")?.deliveryError).toContain("session send failed for the test")
    expect(listed.deliveryError).toBe("watch notification delivery failed for: notify")
    // Exactly one attempt was made for this watch — no retry loop.
    expect(sendLines("watch notify:")).toHaveLength(1)
    setSendMode(undefined)
  })

  test("an unrelated successful delivery cannot clear the failing watch's error; the same watch's success clears it", async () => {
    setSendMode("fail")
    const failing = await post("/watch/run", { slug: "sunrise", name: "notify" })
    expect(failing.status).toBe(200)

    setSendMode(undefined)
    const unrelated = await post("/watch/run", { slug: "sunrise", name: "other" })
    expect(unrelated.status).toBe(200)
    expect(((await unrelated.json()) as RunResponse).deliveryError).toBeUndefined()

    const afterUnrelated = (await (await get("/watches?slug=sunrise")).json()) as WatchesResponse
    expect(afterUnrelated.watches.find((watch) => watch.name === "notify")?.deliveryError).toContain("session send failed for the test")
    expect(afterUnrelated.watches.find((watch) => watch.name === "other")?.deliveryError).toBeUndefined()
    expect(afterUnrelated.deliveryError).toBe("watch notification delivery failed for: notify")

    const clearing = await post("/watch/run", { slug: "sunrise", name: "notify" })
    expect(clearing.status).toBe(200)
    expect(((await clearing.json()) as RunResponse).deliveryError).toBeUndefined()
    const afterClearing = (await (await get("/watches?slug=sunrise")).json()) as WatchesResponse
    expect(afterClearing.watches.find((watch) => watch.name === "notify")?.deliveryError).toBeUndefined()
    expect(afterClearing.deliveryError).toBeUndefined()
  })

  test("a busy coordinator is recorded the same way and still settles promptly", async () => {
    setSendMode("busy")
    const started = Date.now()
    const response = await post("/watch/run", { slug: "sunrise", name: "notify" })
    expect(Date.now() - started).toBeLessThan(5000)
    expect(response.status).toBe(200)
    const body = (await response.json()) as RunResponse
    expect(body.deliveryError).toContain("busy")

    const listed = (await (await get("/watches?slug=sunrise")).json()) as WatchesResponse
    expect(listed.watches.find((watch) => watch.name === "notify")?.deliveryError).toContain("busy")
    expect(listed.deliveryError).toBe("watch notification delivery failed for: notify")

    setSendMode(undefined)
    const clearing = await post("/watch/run", { slug: "sunrise", name: "notify" })
    expect(clearing.status).toBe(200)
    const afterClearing = (await (await get("/watches?slug=sunrise")).json()) as WatchesResponse
    expect(afterClearing.deliveryError).toBeUndefined()
  })

  test("a deleted watch prunes its recorded error and the stale summary", async () => {
    setSendMode("fail")
    const failing = await post("/watch/run", { slug: "sunrise", name: "notify" })
    expect(failing.status).toBe(200)
    const before = (await (await get("/watches?slug=sunrise")).json()) as WatchesResponse
    expect(before.deliveryError).toContain("notify")

    rmSync(path.join(projectHome, "watches", "notify"))
    const after = (await (await get("/watches?slug=sunrise")).json()) as WatchesResponse
    expect(after.watches.some((watch) => watch.name === "notify")).toBe(false)
    expect(after.deliveryError).toBeUndefined()
    setSendMode(undefined)
  })
})
