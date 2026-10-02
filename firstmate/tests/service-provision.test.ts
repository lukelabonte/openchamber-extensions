import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { accessSync, constants as fsConstants, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

const serviceToken = "test-token"
const serviceRoot = path.join(import.meta.dir, "..")
const serviceEntry = path.join(serviceRoot, "service", "main.ts")

let tempRoot: string
let tempHome: string
let serviceProcess: ChildProcess | undefined
let servicePort = 0

beforeAll(async () => {
  tempRoot = mkdtempSync(path.join(os.tmpdir(), "firstmate-provision-test-"))
  tempHome = path.join(tempRoot, "home")
  servicePort = await getFreePort()
  serviceProcess = spawn(process.execPath, [serviceEntry], {
    env: {
      ...process.env,
      OPENCHAMBER_SERVICE_PORT: String(servicePort),
      OPENCHAMBER_SERVICE_TOKEN: serviceToken,
      FIRSTMATE_HOME: tempHome,
    },
    stdio: ["ignore", "ignore", "ignore"],
  })
  await waitUntilListening()
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

async function waitUntilListening(): Promise<void> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try {
      await fetch(serviceUrl("health"))
      return
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  throw new Error("service did not start listening within 5 seconds")
}

function serviceUrl(pathname: string): string {
  return `http://127.0.0.1:${servicePort}/${pathname}`
}

async function provision(body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(serviceUrl("provision"), {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  })
}

describe("POST /provision", () => {
  test("provisions a project home from templates and returns its slug and home directory", async () => {
    const projectDirectory = path.join(tempRoot, "sunrise-repo")
    mkdirSync(projectDirectory)

    const response = await provision({ projectDirectory }, { authorization: `Bearer ${serviceToken}` })

    expect(response.status).toBe(200)
    const slug = "sunrise-repo"
    const projectHome = path.join(tempHome, "projects", slug)
    expect(await response.json()).toEqual({ slug, homeDirectory: projectHome })
    expect(existsSync(path.join(tempHome, "shared", "charter.md"))).toBe(true)
    expect(existsSync(path.join(tempHome, "shared", "captain.md"))).toBe(true)
    expect(existsSync(path.join(tempHome, "shared", "watches"))).toBe(true)
    expect(existsSync(path.join(tempHome, "shared", "watches", "README.md"))).toBe(true)
    const installedPrWatch = path.join(tempHome, "shared", "watches", "pr-watch")
    expect(existsSync(installedPrWatch)).toBe(true)
    accessSync(installedPrWatch, fsConstants.X_OK)
    for (const fileName of ["charter.md", "captain.md", "backlog.md", "projects.md", "settings.json", "AGENTS.md"]) {
      expect(existsSync(path.join(projectHome, fileName))).toBe(true)
    }
    for (const directoryName of ["briefs", "reports", "watches"]) {
      expect(existsSync(path.join(projectHome, directoryName))).toBe(true)
    }
  })

  test("composes AGENTS.md from all four provisioned layers", async () => {
    const projectDirectory = path.join(tempRoot, "compose-check")
    mkdirSync(projectDirectory)
    await provision({ projectDirectory }, { authorization: `Bearer ${serviceToken}` })

    const composed = readFileSync(path.join(tempHome, "projects", "compose-check", "AGENTS.md"), "utf8")

    expect(composed).toContain("Hard rules")
    expect(composed).toContain("Layers, lowest to highest precedence")
    for (const layer of [
      "shared/charter.md",
      "projects/compose-check/charter.md",
      "shared/captain.md",
      "projects/compose-check/captain.md",
    ]) {
      expect(composed).toContain(`${layer} — included`)
    }
    expect(composed).not.toContain("skipped")
  })

  test("never overwrites a user-edited charter on reprovision and recomposes AGENTS.md from it", async () => {
    const projectDirectory = path.join(tempRoot, "edit-check")
    mkdirSync(projectDirectory)
    await provision({ projectDirectory }, { authorization: `Bearer ${serviceToken}` })
    const sharedCharter = path.join(tempHome, "shared", "charter.md")
    writeFileSync(sharedCharter, "CAPTAIN EDIT")

    await provision({ projectDirectory }, { authorization: `Bearer ${serviceToken}` })

    expect(readFileSync(sharedCharter, "utf8")).toBe("CAPTAIN EDIT")
    expect(readFileSync(path.join(tempHome, "projects", "edit-check", "AGENTS.md"), "utf8")).toContain("CAPTAIN EDIT")
  })

  test("rejects provisioning without authorization", async () => {
    const response = await provision({ projectDirectory: "/somewhere/sunrise" })
    expect(response.status).toBe(401)
  })

  test("rejects a body without a project directory", async () => {
    const response = await provision({}, { authorization: `Bearer ${serviceToken}` })
    expect(response.status).toBe(400)
  })
})
