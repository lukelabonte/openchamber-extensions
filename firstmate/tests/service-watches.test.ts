import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

// The /watches endpoints end to end, plus the streak contract observed for
// real: the service discovers the watches, execs them (directly, shebang and
// exec bit — never via sh), and delivers to the coordinator through the
// openchamber CLI — a shim on PATH logs every call. Schedules are
// minute-granular, so a run happens at the next minute boundary; the streak
// test waits for two of them.

const serviceToken = "test-token"
const serviceRoot = path.join(import.meta.dir, "..")
const serviceEntry = path.join(serviceRoot, "service", "main.ts")
const projectDirectory = "/repos/sunrise"

let tempRoot: string
let tempHome: string
let shimLogPath: string
let serviceProcess: ChildProcess | undefined
let servicePort = 0

beforeAll(() => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "firstmate-watches-test-"))
  tempHome = path.join(tempRoot, "home")
  const shimBin = path.join(tempRoot, "bin")
  const projectHome = path.join(tempHome, "projects", "sunrise")
  mkdirSync(shimBin)
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

  shimLogPath = path.join(tempRoot, "shim.log")
  const shim = path.join(shimBin, "openchamber")
  writeFileSync(shim, `#!/bin/sh\necho "$@" >> "$OPENCHAMBER_SHIM_LOG"\nexit 0\n`)
  chmodSync(shim, 0o755)

  writeWatch(path.join(tempHome, "shared", "watches", "pr-watch"), "# schedule: */5 * * * *\n")
  // Fails on every run: the streak must be reported exactly once.
  writeWatch(path.join(projectHome, "watches", "nightly"), "# schedule: * * * * *\nexit 1\n")
  writeWatch(path.join(projectHome, "watches", "chatter"), `# schedule: * * * * *\necho "QUOTED — hello from the watch"\n`)

  servicePort = 0
  return startService()
}, 30_000)

afterAll(() => {
  serviceProcess?.kill()
  rmSync(tempRoot, { recursive: true, force: true })
})

function writeWatch(filePath: string, body: string): void {
  writeFileSync(filePath, `#!/bin/sh\n${body}`)
  chmodSync(filePath, 0o755)
}

function startService(): Promise<void> {
  return new Promise((resolve, reject) => {
    getFreePort().then((port) => {
      servicePort = port
      serviceProcess = spawn(process.execPath, [serviceEntry], {
        env: {
          ...process.env,
          OPENCHAMBER_SERVICE_PORT: String(port),
          OPENCHAMBER_SERVICE_TOKEN: serviceToken,
          FIRSTMATE_HOME: tempHome,
          FIRSTMATE_POLL_MS: "60000",
          FIRSTMATE_WATCH_MS: "1000",
          OPENCHAMBER_SHIM_LOG: shimLogPath,
          PATH: `${path.join(tempRoot, "bin")}:${process.env.PATH ?? ""}`,
        },
        stdio: ["ignore", "ignore", "ignore"],
      })
      waitUntilListening(port).then(resolve, reject)
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
      await fetch(`http://127.0.0.1:${servicePort}/health`)
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

function get(pathname: string, headers: Record<string, string> = authHeaders()): Promise<Response> {
  return fetch(`http://127.0.0.1:${servicePort}${pathname}`, { headers })
}

function post(pathname: string, body: unknown, headers: Record<string, string> = authHeaders()): Promise<Response> {
  return fetch(`http://127.0.0.1:${servicePort}${pathname}`, { method: "POST", headers, body: JSON.stringify(body) })
}

function shimLog(): string {
  return existsSync(shimLogPath) ? readFileSync(shimLogPath, "utf8") : ""
}

// Waits until the shim log satisfies the predicate (the service ticks once a
// second, but watch runs are minute-locked), or fails at the deadline.
async function waitForShim(predicate: (log: string) => boolean, description: string, deadlineMs: number): Promise<string> {
  const deadline = Date.now() + deadlineMs
  while (Date.now() < deadline) {
    const log = shimLog()
    if (predicate(log)) return log
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`the shim log never showed ${description} within ${deadlineMs} ms; last log: ${shimLog()}`)
}

const watchNames = (watches: unknown): string[] =>
  Array.isArray(watches) ? watches.map((watch) => (watch as { name?: string }).name ?? "") : []

describe("GET /watches", () => {
  test("lists shared and project watches with schedule and default-enabled switch", async () => {
    const response = await get("/watches?slug=sunrise")
    expect(response.status).toBe(200)
    const body = (await response.json()) as { watches: { name: string; source: string; schedule: string; enabled: boolean }[] }
    expect(watchNames(body.watches).sort()).toEqual(["chatter", "nightly", "pr-watch"])
    const nightly = body.watches.find((watch) => watch.name === "nightly")
    expect(nightly).toMatchObject({ source: "project", schedule: "* * * * *", enabled: true })
    const prWatch = body.watches.find((watch) => watch.name === "pr-watch")
    expect(prWatch).toMatchObject({ source: "shared", schedule: "*/5 * * * *", enabled: true })
  })

  test("answers 400 without a slug and 404 for an unknown slug", async () => {
    expect((await get("/watches")).status).toBe(400)
    expect((await get("/watches?slug=elsewhere")).status).toBe(404)
  })

  test("answers 401 without a token", async () => {
    expect((await get("/watches?slug=sunrise", { "content-type": "application/json" })).status).toBe(401)
  })
})

describe("POST /watches/toggle", () => {
  test("persists the switch per source in the project settings and the list reflects it", async () => {
    const off = await post("/watches/toggle", { slug: "sunrise", name: "chatter", source: "project", enabled: false })
    expect(off.status).toBe(200)

    const listed = (await (await get("/watches?slug=sunrise")).json()) as { watches: { name: string; enabled: boolean }[] }
    expect(listed.watches.find((watch) => watch.name === "chatter")?.enabled).toBe(false)
    const settings = JSON.parse(readFileSync(path.join(tempHome, "projects", "sunrise", "settings.json"), "utf8"))
    expect(settings.watches).toEqual({ project: { chatter: { enabled: false } } })

    const backOn = await post("/watches/toggle", { slug: "sunrise", name: "chatter", source: "project", enabled: true })
    expect(backOn.status).toBe(200)
    const relisted = (await (await get("/watches?slug=sunrise")).json()) as { watches: { name: string; enabled: boolean }[] }
    expect(relisted.watches.find((watch) => watch.name === "chatter")?.enabled).toBe(true)
  })

  test("answers 404 for an unknown watch and an unknown slug", async () => {
    expect((await post("/watches/toggle", { slug: "sunrise", name: "absent", enabled: false })).status).toBe(404)
    expect((await post("/watches/toggle", { slug: "sunrise", name: "nightly", source: "shared", enabled: false })).status).toBe(404)
    expect((await post("/watches/toggle", { slug: "elsewhere", name: "nightly", enabled: false })).status).toBe(404)
  })

  test("answers 400 for bad input", async () => {
    expect((await post("/watches/toggle", { slug: "sunrise", name: "nightly", enabled: "yes" })).status).toBe(400)
    expect((await post("/watches/toggle", { slug: "sunrise", enabled: false })).status).toBe(400)
    expect((await post("/watches/toggle", { slug: "sunrise", name: "nightly", source: "everywhere", enabled: false })).status).toBe(400)
  })
})

// Two minute boundaries: the failing watch reports once per streak, the
// chatty watch delivers its non-empty stdout as one message per run.
describe("watch execution end to end", () => {
  test("a failing watch notifies the coordinator once per streak and stdout arrives as one message", async () => {
    const log = await waitForShim(
      (current) => current.split("\n").filter((line) => line.includes("watch chatter:")).length >= 2,
      "two runs of the chatty watch",
      150_000,
    )

    const sends = log.split("\n").filter((line) => line.includes("session") && line.includes("send"))
    const chatterSends = sends.filter((line) => line.includes("watch chatter:"))
    expect(chatterSends.length).toBe(2)
    expect(chatterSends[0]).toContain(`--dir ${projectHomeOf("sunrise")}`)
    expect(chatterSends[0]).toContain("--session ses_coord_1")
    expect(chatterSends[0]).toContain("FirstMate (sunrise) watch chatter:")
    // The message's own newline splits the log entry across physical lines,
    // so the quoted tail is asserted against the whole log.
    expect(log).toContain("QUOTED — hello from the watch")

    // Two failed nightly runs, one streak, exactly one failure notification.
    const nightlyFailures = sends.filter((line) => line.includes("watch nightly failed"))
    expect(nightlyFailures.length).toBe(1)
  }, 160_000)
})

function projectHomeOf(slug: string): string {
  return path.join(tempHome, "projects", slug)
}
