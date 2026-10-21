import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

// The service execs `openchamber` through PATH. A shim script stands in for the
// CLI so no test ever runs the real binary; the missing-CLI service gets a PATH
// with no `openchamber` on it at all.
const serviceToken = "test-token"
const serviceRoot = path.join(import.meta.dir, "..")
const serviceEntry = path.join(serviceRoot, "service", "main.ts")

let tempRoot: string
let tempHome: string
let shimDirectory: string
let emptyPathDirectory: string
let shimLogPath: string
let serviceProcess: ChildProcess | undefined
let servicePort = 0
let noCliServiceProcess: ChildProcess | undefined
let noCliServicePort = 0

beforeAll(async () => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "firstmate-launch-test-"))
  tempHome = path.join(tempRoot, "home")
  shimDirectory = path.join(tempRoot, "shim")
  emptyPathDirectory = path.join(tempRoot, "empty-path")
  shimLogPath = path.join(tempRoot, "shim-calls.log")
  mkdirSync(shimDirectory)
  mkdirSync(emptyPathDirectory)
  writeFileSync(
    path.join(shimDirectory, "openchamber"),
    `#!${process.execPath}
import { appendFileSync, writeFileSync } from "node:fs"
const args = process.argv.slice(2)
appendFileSync(process.env.FIRSTMATE_SHIM_LOG, JSON.stringify(args) + "\\n")
if (args[1] === "associate-project") {
  const directory = args[args.indexOf("--display-project-dir") + 1]
  const message = directory.endsWith("unsupported-sidebar-repo") || directory.endsWith("unsupported-warning-repo") ? "Unknown option: --display-project-dir"
    : directory.endsWith("unsupported-command-repo") ? "Unknown session command 'associate-project'."
    : directory.endsWith("failed-sidebar-repo") ? "project association request failed"
    : undefined
  if (message) {
    if (directory.endsWith("unsupported-warning-repo")) writeFileSync(2, "CLI startup warning\\n")
    writeFileSync(1, JSON.stringify({ status: "error", error: { message, details: [message] } }) + "\\n")
    process.exit(1)
  }
}
console.log('{"sessionID":"ses_coord_1"}')
`,
  )
  chmodSync(path.join(shimDirectory, "openchamber"), 0o755)

  servicePort = await getFreePort()
  serviceProcess = spawnService(servicePort, { PATH: `${shimDirectory}:${process.env.PATH ?? ""}` })
  await waitUntilListening(servicePort)
  noCliServicePort = await getFreePort()
  noCliServiceProcess = spawnService(noCliServicePort, { PATH: emptyPathDirectory })
  await waitUntilListening(noCliServicePort)
})

afterAll(() => {
  serviceProcess?.kill()
  noCliServiceProcess?.kill()
  rmSync(tempRoot, { recursive: true, force: true })
})

function spawnService(port: number, env: Record<string, string>): ChildProcess {
  return spawn(process.execPath, [serviceEntry], {
    env: {
      ...process.env,
      OPENCHAMBER_SERVICE_PORT: String(port),
      OPENCHAMBER_SERVICE_TOKEN: serviceToken,
      FIRSTMATE_HOME: tempHome,
      FIRSTMATE_OPENCHAMBER_SETTINGS: path.join(tempRoot, "absent-settings.json"),
      FIRSTMATE_SHIM_LOG: shimLogPath,
      ...env,
    },
    stdio: ["ignore", "ignore", "ignore"],
  })
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
      await fetch(serviceUrl(port, "health"))
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new Error("service did not start listening within 5 seconds")
}

function serviceUrl(port: number, pathname: string, query = ""): string {
  return `http://127.0.0.1:${port}/${pathname}${query}`
}

async function launch(port: number, body: unknown): Promise<Response> {
  return fetch(serviceUrl(port, "launch"), {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${serviceToken}` },
    body: JSON.stringify(body),
  })
}

describe("POST /launch and the registry endpoints", () => {
  test("launches a first mate: session rooted at the home, registration persisted, registry answers", async () => {
    const projectDirectory = path.join(tempRoot, "sunrise-repo")
    mkdirSync(projectDirectory)

    const response = await launch(servicePort, { projectDirectory })

    expect(response.status).toBe(200)
    const registration = (await response.json()) as Record<string, unknown>
    const slug = "sunrise-repo"
    const homeDirectory = path.join(tempHome, "projects", slug)
    expect(registration).toEqual({
      slug,
      projectDirectory,
      homeDirectory,
      coordinatorSessionId: "ses_coord_1",
      createdAt: registration.createdAt,
    })
    expect(typeof registration.createdAt).toBe("string")

    const shimCalls = readFileSync(shimLogPath, "utf8").trim().split("\n").map((line) => JSON.parse(line) as string[])
    expect(shimCalls).toHaveLength(2)
    expect(shimCalls[0].slice(0, 4)).toEqual(["session", "create", "--dir", homeDirectory])
    expect(shimCalls[0]).not.toContain(projectDirectory)
    expect(shimCalls[0][shimCalls[0].indexOf("--prompt") + 1]).toBe(readFileSync(path.join(homeDirectory, "opening.md"), "utf8"))
    expect(shimCalls[1]).toEqual([
      "session", "associate-project", "--session", "ses_coord_1", "--dir", homeDirectory,
      "--display-project-dir", projectDirectory, "--json",
    ])

    const persisted = JSON.parse(readFileSync(path.join(tempHome, "registry.json"), "utf8")) as Record<string, unknown>
    expect(persisted[slug]).toEqual(registration)

    const listResponse = await fetch(serviceUrl(servicePort, "registry"), {
      headers: { authorization: `Bearer ${serviceToken}` },
    })
    expect(listResponse.status).toBe(200)
    expect(await listResponse.json()).toEqual({ registrations: [registration] })

    const oneResponse = await fetch(serviceUrl(servicePort, `registry/${slug}`), {
      headers: { authorization: `Bearer ${serviceToken}` },
    })
    expect(oneResponse.status).toBe(200)
    expect(await oneResponse.json()).toEqual(registration)

    const missingResponse = await fetch(serviceUrl(servicePort, "registry/who-is-this"), {
      headers: { authorization: `Bearer ${serviceToken}` },
    })
    expect(missingResponse.status).toBe(404)
    expect(((await missingResponse.json()) as { error: string }).error).toContain("who-is-this")
  })

  test("relaunching an already-registered project adopts the existing registration", async () => {
    const projectDirectory = path.join(tempRoot, "adopt-me")
    mkdirSync(projectDirectory)
    const firstResponse = await launch(servicePort, { projectDirectory })
    const first = (await firstResponse.json()) as Record<string, unknown>
    const homeDirectory = first.homeDirectory
    if (typeof homeDirectory !== "string") throw new Error("launch must return the first mate's home directory")
    const shimCallCountBefore = readFileSync(shimLogPath, "utf8").trim().split("\n").length

    const secondResponse = await launch(servicePort, { projectDirectory: `${projectDirectory}/` })

    expect(secondResponse.status).toBe(200)
    expect(await secondResponse.json()).toEqual(first)
    const newCalls = readFileSync(shimLogPath, "utf8").trim().split("\n").slice(shimCallCountBefore).map((line) => JSON.parse(line) as string[])
    expect(newCalls).toEqual([[
      "session", "associate-project", "--session", "ses_coord_1", "--dir", homeDirectory,
      "--display-project-dir", projectDirectory, "--json",
    ]])
  })

  test("launching with a first mate's home directory adopts the existing registration", async () => {
    const projectDirectory = path.join(tempRoot, "home-adopt-me")
    mkdirSync(projectDirectory)
    const firstResponse = await launch(servicePort, { projectDirectory })
    const first = (await firstResponse.json()) as Record<string, unknown>
    const homeDirectory = first.homeDirectory
    if (typeof homeDirectory !== "string") throw new Error("launch must return the first mate's home directory")
    const shimCallCountBefore = readFileSync(shimLogPath, "utf8").trim().split("\n").length

    const secondResponse = await launch(servicePort, { projectDirectory: homeDirectory })

    expect(secondResponse.status).toBe(200)
    expect(await secondResponse.json()).toEqual(first)
    const newCalls = readFileSync(shimLogPath, "utf8").trim().split("\n").slice(shimCallCountBefore).map((line) => JSON.parse(line) as string[])
    expect(newCalls).toEqual([[
      "session", "associate-project", "--session", "ses_coord_1", "--dir", homeDirectory,
      "--display-project-dir", projectDirectory, "--json",
    ]])
  })

  test("GET /lookup answers the registration for a registered directory and null otherwise", async () => {
    const projectDirectory = path.join(tempRoot, "lookup-me")
    mkdirSync(projectDirectory)
    const launchResponse = await launch(servicePort, { projectDirectory })
    const registration = (await launchResponse.json()) as Record<string, unknown>

    const found = await fetch(serviceUrl(servicePort, "lookup", `?directory=${encodeURIComponent(projectDirectory)}`), {
      headers: { authorization: `Bearer ${serviceToken}` },
    })
    expect(found.status).toBe(200)
    expect(await found.json()).toEqual({ registration })

    const homeLookup = await fetch(
      serviceUrl(servicePort, "lookup", `?directory=${encodeURIComponent(registration.homeDirectory as string)}`),
      { headers: { authorization: `Bearer ${serviceToken}` } },
    )
    expect(homeLookup.status).toBe(200)
    expect(await homeLookup.json()).toEqual({ registration })

    const none = await fetch(serviceUrl(servicePort, "lookup", `?directory=${encodeURIComponent(path.join(tempRoot, "elsewhere"))}`), {
      headers: { authorization: `Bearer ${serviceToken}` },
    })
    expect(none.status).toBe(200)
    expect(await none.json()).toEqual({ registration: null })

    const invalid = await fetch(serviceUrl(servicePort, "lookup"), {
      headers: { authorization: `Bearer ${serviceToken}` },
    })
    expect(invalid.status).toBe(400)
  })

  test.each(["unsupported-sidebar-repo", "unsupported-command-repo", "unsupported-warning-repo"])("launches and reopens without duplicate sessions when the CLI lacks sidebar support: %s", async (name) => {
    const projectDirectory = path.join(tempRoot, name)
    mkdirSync(projectDirectory)
    const callsBefore = readFileSync(shimLogPath, "utf8").trim().split("\n").length

    const first = await launch(servicePort, { projectDirectory })
    expect(first.status).toBe(200)
    const registration = await first.json() as Record<string, unknown>
    const second = await launch(servicePort, { projectDirectory })
    expect(second.status).toBe(200)
    expect(await second.json()).toEqual(registration)
    expect(registration.homeDirectory).toBe(path.join(tempHome, "projects", name))
    const calls = readFileSync(shimLogPath, "utf8").trim().split("\n").slice(callsBefore).map((line) => JSON.parse(line) as string[])
    expect(calls.filter((args) => args[1] === "create")).toHaveLength(1)
    expect(calls[0].slice(0, 4)).toEqual(["session", "create", "--dir", registration.homeDirectory as string])
    const persisted = JSON.parse(readFileSync(path.join(tempHome, "registry.json"), "utf8"))
    expect(persisted[name]).toEqual(registration)
  })

  test("still reports real association failures with the CLI's JSON stdout diagnostic", async () => {
    const projectDirectory = path.join(tempRoot, "failed-sidebar-repo")
    mkdirSync(projectDirectory)
    const response = await launch(servicePort, { projectDirectory })
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("project association request failed") })
    const persisted = JSON.parse(readFileSync(path.join(tempHome, "registry.json"), "utf8"))
    expect(persisted["failed-sidebar-repo"].coordinatorSessionId).toBe("ses_coord_1")
  })
})

describe("POST /launch when the openchamber CLI is missing", () => {
  test("preserves the missing-CLI response when reopening an existing first mate", async () => {
    const projectDirectory = path.join(tempRoot, "existing-no-cli-repo")
    mkdirSync(projectDirectory)
    expect((await launch(servicePort, { projectDirectory })).status).toBe(200)

    const response = await launch(noCliServicePort, { projectDirectory })

    expect(response.status).toBe(503)
    expect(await response.json()).toMatchObject({ code: "cli-missing" })
  })

  test("answers a clear plain-language error", async () => {
    const projectDirectory = path.join(tempRoot, "no-cli-repo")
    mkdirSync(projectDirectory)

    const response = await launch(noCliServicePort, { projectDirectory })

    expect(response.status).toBe(503)
    const body = (await response.json()) as { error: string; code: string }
    expect(body.error).toContain("the openchamber CLI is required")
    expect(body.code).toBe("cli-missing")
  })
})
