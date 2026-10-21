import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import net from "node:net"
import { tmpdir } from "node:os"
import path from "node:path"

let root: string
let home: string
let projectHome: string
let port: number
let child: ChildProcess | undefined
const token = "port-test-token"

async function start(pollMilliseconds = 60000): Promise<void> {
  port = await new Promise<number>((resolve, reject) => {
    const server = net.createServer()
    server.on("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (typeof address === "object" && address !== null) server.close(() => resolve(address.port))
      else reject(new Error("no test port"))
    })
  })
  child = spawn(process.execPath, [path.join(import.meta.dir, "..", "service", "main.ts")], {
    env: { ...process.env, FIRSTMATE_HOME: home, FIRSTMATE_OPENCHAMBER_SETTINGS: path.join(root, "absent-settings.json"), FIRSTMATE_POLL_MS: String(pollMilliseconds), FIRSTMATE_WATCH_MS: "60000", OPENCHAMBER_SERVICE_TOKEN: token, OPENCHAMBER_SERVICE_PORT: String(port), PATH: `${path.join(root, "bin")}:${process.env.PATH ?? ""}` },
    stdio: "ignore",
  })
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    try { if ((await request("/health")).status === 200) return } catch {}
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error("port test service didn't start")
}

async function stop(): Promise<void> {
  if (child === undefined || child.exitCode !== null) return
  const closed = new Promise<void>((resolve) => child!.once("close", () => resolve()))
  child.kill()
  await closed
  child = undefined
}

async function request(route: string, body?: unknown): Promise<Response> {
  return fetch(`http://127.0.0.1:${port}${route}`, { method: body === undefined ? "GET" : "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
}

beforeAll(async () => {
  root = mkdtempSync(path.join(tmpdir(), "firstmate-port-"))
  home = path.join(root, "home")
  projectHome = path.join(home, "projects", "sunrise")
  mkdirSync(path.join(root, "bin"), { recursive: true })
  mkdirSync(path.join(projectHome, "watches"), { recursive: true })
  writeFileSync(path.join(home, "registry.json"), JSON.stringify({ sunrise: { slug: "sunrise", projectDirectory: "/repos/sunrise", homeDirectory: projectHome, coordinatorSessionId: "ses_mate", createdAt: "2026-10-13T00:00:00Z" } }))
  writeFileSync(path.join(projectHome, "settings.json"), JSON.stringify({ projectDirectory: "/repos/sunrise", coordinatorSessionId: "ses_mate" }))
  writeFileSync(path.join(projectHome, "backlog.md"), "- Approve\n  id: approve\n  kind: captain\n  state: Blocked\n  hold: Merge?\n  actions: Merge => Merge the reviewed head | Hold => Keep it open\n")
  const shim = path.join(root, "bin", "openchamber")
  writeFileSync(shim, `#!${process.execPath}\nconst fs = require('node:fs'); const args = process.argv.slice(2); fs.appendFileSync(${JSON.stringify(path.join(root, "calls.jsonl"))}, JSON.stringify(args)+'\\n'); const busy=fs.existsSync(${JSON.stringify(path.join(root, "busy"))}); console.log(JSON.stringify(args[1]==='create'?{sessionID:'ses_new'}:args[1]==='associate-project'?{sessionId:args[args.indexOf('--session')+1]}:args[1]==='status'?{sessionStatus:{type:busy?'busy':'idle'}}:args[1]==='list'?{sessions:[]}:{}));\n`)
  chmodSync(shim, 0o755)
  const watch = path.join(projectHome, "watches", "signal")
  writeFileSync(watch, "#!/bin/sh\n# schedule: 5 4 29 2 *\nprintf 'durable signal'\n")
  chmodSync(watch, 0o755)
  await start()
}, 15000)

afterAll(async () => { await stop(); if (root !== undefined) rmSync(root, { recursive: true, force: true }) })

describe("ported service routes", () => {
  test("settings preserve ownership and reject unknown fields", async () => {
    expect((await request("/settings?slug=sunrise")).status).toBe(200)
    expect((await request("/settings", { slug: "sunrise", settings: { workerModel: "openai/test", refreshSeconds: 10 } })).status).toBe(200)
    expect(JSON.parse(readFileSync(path.join(projectHome, "settings.json"), "utf8")).coordinatorSessionId).toBe("ses_mate")
    expect((await request("/settings", { slug: "sunrise", settings: { unknown: true } })).status).toBe(400)
    expect((await request("/settings?slug=../escape")).status).toBe(404)
  })

  test("task answers route to the first mate without changing the hold", async () => {
    expect((await request("/decision", { slug: "sunrise", taskId: "approve", label: "Merge", expectedText: "Merge the reviewed head" })).status).toBe(200)
    expect((await request("/decision", { slug: "sunrise", taskId: "approve", label: "Merge", expectedText: "Old instructions" })).status).toBe(409)
    expect(readFileSync(path.join(projectHome, "backlog.md"), "utf8")).toContain("hold: Merge?")
  })

  test("handoffs preserve multiline requests and mark their authority", async () => {
    expect((await request("/handoff", { directory: "/repos/sunrise", sessionId: "ses_origin", text: "Review\nthis exact request" })).status).toBe(200)
    const calls = readFileSync(path.join(root, "calls.jsonl"), "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as string[])
    expect(calls.some((args) => args.some((value) => value.includes("not merge approval") && value.endsWith("Review\nthis exact request")))).toBe(true)
  })

  test("busy watch output survives service restart and is delivered later", async () => {
    writeFileSync(path.join(root, "busy"), "busy")
    expect((await request("/watch/run", { slug: "sunrise", name: "signal", source: "project" })).status).toBe(200)
    expect(await (await request("/watchnotes?slug=sunrise")).json()).toMatchObject({ pendingCount: 1 })
    await stop()
    await start()
    expect(await (await request("/watchnotes?slug=sunrise")).json()).toMatchObject({ pendingCount: 1 })
    rmSync(path.join(root, "busy"))
    expect((await request("/watch/run", { slug: "sunrise", name: "signal", source: "project" })).status).toBe(200)
    const history = await (await request("/watchnotes?slug=sunrise")).json() as { notes: unknown[]; pendingCount: number }
    expect(history.pendingCount).toBe(0)
    expect(history.notes).toHaveLength(2)
  }, 15000)

  test("fresh-session restart and release preserve the backlog", async () => {
    const backlog = readFileSync(path.join(projectHome, "backlog.md"), "utf8")
    const restarted = await request("/coordinator/restart", { slug: "sunrise" })
    expect(restarted.status).toBe(200)
    expect(await restarted.json()).toMatchObject({ registration: { coordinatorSessionId: "ses_new" } })
    expect((await request("/coordinator/release", { slug: "sunrise" })).status).toBe(200)
    expect(readFileSync(path.join(projectHome, "backlog.md"), "utf8")).toBe(backlog)
    expect(JSON.parse(readFileSync(path.join(projectHome, "settings.json"), "utf8")).coordinatorReleased).toBe(true)
  })

  test("a corrupt registry doesn't terminate supervision or the service", async () => {
    await stop()
    writeFileSync(path.join(home, "registry.json"), "{ corrupt")
    await start(50)
    await new Promise((resolve) => setTimeout(resolve, 200))
    try { expect((await request("/health")).status).toBe(200) }
    finally { writeFileSync(path.join(home, "registry.json"), "{}") }
  })

  test("upgrade errors are named and repaired provenance can be retried", async () => {
    await stop()
    writeFileSync(path.join(home, "registry.json"), JSON.stringify({ sunrise: { slug: "sunrise", projectDirectory: "/repos/sunrise", homeDirectory: projectHome, coordinatorSessionId: "ses_mate", createdAt: "2026-10-13T00:00:00Z" } }))
    mkdirSync(path.join(home, "shared"), { recursive: true })
    const charter = path.join(home, "shared", "charter.md")
    writeFileSync(charter, "Captain's custom charter")
    writeFileSync(`${charter}.template.json`, "invalid provenance")
    await start()
    const failed = await request("/upgrades?slug=sunrise")
    expect(failed.status).toBe(500)
    expect((await failed.json() as { error: string }).error).not.toBe("internal error")
    rmSync(`${charter}.template.json`)
    expect((await request("/upgrades?slug=sunrise")).status).toBe(200)
    expect(readFileSync(charter, "utf8")).toBe("Captain's custom charter")
    expect(readFileSync(`${charter}.new`, "utf8")).toContain("# Charter")
  })
})
