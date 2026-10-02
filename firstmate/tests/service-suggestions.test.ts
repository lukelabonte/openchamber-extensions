import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

// Suggestion buttons and the /bearings–/ahoy commands end to end: the service
// relays the suggestion's text or the command word to the coordinator over
// the control CLI and edits suggestions.md itself. A shim CLI stands in for
// the real openchamber binary and logs every call, and a temp FIRSTMATE_HOME
// carries the fixture files — no real ~/.config path is touched.
const serviceToken = "test-token"
const serviceRoot = path.join(import.meta.dir, "..")
const serviceEntry = path.join(serviceRoot, "service", "main.ts")

let tempRoot: string
let tempHome: string
let shimDirectory: string
let shimLogPath: string
let suggestionsPath: string
let serviceProcess: ChildProcess | undefined
let servicePort = 0

beforeAll(async () => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "firstmate-suggestions-test-"))
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
      "  send)",
      '    case "$*" in',
      "      *FAILCOORD*) echo 'no such session' >&2; exit 1 ;;",
      "      *) echo '{\"ok\":true}' ;;",
      "    esac ;;",
      "  *) echo '{\"ok\":true}' ;;",
      "esac",
      "",
    ].join("\n"),
  )
  chmodSync(path.join(shimDirectory, "openchamber"), 0o755)

  const sunriseHome = path.join(tempHome, "projects", "sunrise")
  const drifterHome = path.join(tempHome, "projects", "drifter")
  mkdirSync(sunriseHome, { recursive: true })
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
  suggestionsPath = path.join(sunriseHome, "suggestions.md")
  writeFileSync(
    suggestionsPath,
    [
      "# Suggestions",
      "",
      "- Update the PR description :: please refresh the pull-request description with the final summary",
      "- Bump the CI timeout :: bump the CI timeout to 20 minutes",
      "",
      "Prose the coordinator keeps around.",
      "",
    ].join("\n"),
  )

  servicePort = await getFreePort()
  serviceProcess = spawn(process.execPath, [serviceEntry], {
    env: {
      ...process.env,
      OPENCHAMBER_SERVICE_PORT: String(servicePort),
      OPENCHAMBER_SERVICE_TOKEN: serviceToken,
      FIRSTMATE_HOME: tempHome,
      FIRSTMATE_POLL_MS: "60000",
      FIRSTMATE_WATCH_MS: "60000",
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

function authHeaders(): Record<string, string> {
  return { authorization: `Bearer ${serviceToken}`, "content-type": "application/json" }
}

async function get(query: string): Promise<Response> {
  return fetch(`http://127.0.0.1:${servicePort}/suggestions${query}`, {
    headers: { authorization: `Bearer ${serviceToken}` },
  })
}

async function post(pathname: string, body: unknown, headers: Record<string, string> = authHeaders()): Promise<Response> {
  return fetch(`http://127.0.0.1:${servicePort}${pathname}`, {
    method: "POST",
    headers,
    body: typeof body === "string" ? body : JSON.stringify(body),
  })
}

function shimLogLines(): string[] {
  try {
    return readFileSync(shimLogPath, "utf8").split("\n")
  } catch (error) {
    if ((error as NodeJS.ErrnoException | undefined)?.code !== "ENOENT") throw error
    return []
  }
}

function shimSendsContaining(substring: string): string[] {
  return shimLogLines().filter((line) => line.includes("session send") && line.includes(substring))
}

describe("GET /suggestions", () => {
  test("answers the parsed suggestions for a registered slug", async () => {
    const response = await get("?slug=sunrise")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({
      suggestions: [
        {
          label: "Update the PR description",
          text: "please refresh the pull-request description with the final summary",
        },
        { label: "Bump the CI timeout", text: "bump the CI timeout to 20 minutes" },
      ],
    })
  })

  test("answers an empty list when suggestions.md does not exist yet", async () => {
    const response = await get("?slug=drifter")
    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ suggestions: [] })
  })

  test("answers 404 for an unknown slug and 400 when the slug is missing", async () => {
    const unknownSlug = await get("?slug=elsewhere")
    expect(unknownSlug.status).toBe(404)
    const missingSlug = await get("")
    expect(missingSlug.status).toBe(400)
  })

  test("answers 401 without a token and with a wrong token", async () => {
    const noToken = await fetch(`http://127.0.0.1:${servicePort}/suggestions?slug=sunrise`)
    expect(noToken.status).toBe(401)
  })
})

describe("POST /suggestion/send", () => {
  test("sends the suggestion's text to the coordinator and removes the line", async () => {
    const response = await post("/suggestion/send", { slug: "sunrise", label: "Update the PR description" })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ sent: true })
    const sends = shimSendsContaining("please refresh the pull-request description")
    expect(sends).toHaveLength(1)
    expect(sends[0]).toContain("--session ses_coord_1")
    expect(sends[0]).toContain(`--dir ${path.join(tempHome, "projects", "sunrise")}`)
    const onDisk = readFileSync(suggestionsPath, "utf8")
    expect(onDisk).not.toContain("Update the PR description")
    // The coordinator's other suggestion and its prose stay untouched.
    expect(onDisk).toContain("Bump the CI timeout")
    expect(onDisk).toContain("Prose the coordinator keeps around.")
  })

  test("a failed coordinator send answers 500 and leaves the line ready to press again", async () => {
    // The shim fails coordinator sends whose prompt carries the FAILCOORD
    // marker — the prompt is the suggestion's text, not its label.
    const failingLabel = "refresh the description"
    writeFileSync(suggestionsPath, `- ${failingLabel} :: FAILCOORD the failing text\n`)

    const response = await post("/suggestion/send", { slug: "sunrise", label: failingLabel })

    expect(response.status).toBe(500)
    expect(readFileSync(suggestionsPath, "utf8")).toContain(failingLabel)
  })

  test("answers 404 for an unknown slug and an unknown label, 400 on missing fields", async () => {
    const unknownSlug = await post("/suggestion/send", { slug: "elsewhere", label: "any" })
    expect(unknownSlug.status).toBe(404)
    const unknownLabel = await post("/suggestion/send", { slug: "sunrise", label: "no such suggestion" })
    expect(unknownLabel.status).toBe(404)
    const missingLabel = await post("/suggestion/send", { slug: "sunrise" })
    expect(missingLabel.status).toBe(400)
  })

  test("answers 401 without a token", async () => {
    const response = await post("/suggestion/send", { slug: "sunrise", label: "any" }, { "content-type": "application/json" })
    expect(response.status).toBe(401)
  })
})

describe("POST /suggestion/dismiss", () => {
  test("removes the line without sending anything", async () => {
    writeFileSync(suggestionsPath, [
      "- Keep me :: still wanted",
      "- Old idea :: no longer sensible",
      "",
    ].join("\n"))
    const sendsBefore = shimLogLines().length

    const response = await post("/suggestion/dismiss", { slug: "sunrise", label: "Old idea" })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ dismissed: true })
    const onDisk = readFileSync(suggestionsPath, "utf8")
    expect(onDisk).toContain("Keep me")
    expect(onDisk).not.toContain("Old idea")
    // Nothing was sent to the coordinator between the dismissal and before.
    expect(shimLogLines().length).toBe(sendsBefore)
  })

  test("answers 404 for an unknown slug and an unknown label, 400 on missing fields", async () => {
    const unknownSlug = await post("/suggestion/dismiss", { slug: "elsewhere", label: "any" })
    expect(unknownSlug.status).toBe(404)
    const unknownLabel = await post("/suggestion/dismiss", { slug: "sunrise", label: "no such suggestion" })
    expect(unknownLabel.status).toBe(404)
    const missingLabel = await post("/suggestion/dismiss", { slug: "sunrise" })
    expect(missingLabel.status).toBe(400)
  })
})

describe("POST /command", () => {
  test.each([
    ["bearings", "/bearings"],
    ["bearings-file", "/bearings file"],
    ["ahoy", "/ahoy"],
  ])("relays %s to the coordinator as %s, verbatim", async (command, prompt) => {
    const response = await post("/command", { slug: "sunrise", command })

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ sent: true })
    const sends = shimSendsContaining(`--prompt ${prompt}`)
    expect(sends).toHaveLength(1)
    expect(sends[0]).toContain("--session ses_coord_1")
    expect(sends[0]).toContain(`--dir ${path.join(tempHome, "projects", "sunrise")}`)
  })

  test("answers 400 for an unknown command and missing fields", async () => {
    const unknown = await post("/command", { slug: "sunrise", command: "all-hands" })
    expect(unknown.status).toBe(400)
    const missing = await post("/command", { slug: "sunrise" })
    expect(missing.status).toBe(400)
  })

  test("answers 404 for an unknown slug and 401 without a token", async () => {
    const unknownSlug = await post("/command", { slug: "elsewhere", command: "bearings" })
    expect(unknownSlug.status).toBe(404)
    const noToken = await post("/command", { slug: "sunrise", command: "bearings" }, { "content-type": "application/json" })
    expect(noToken.status).toBe(401)
  })
})
