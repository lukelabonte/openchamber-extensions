import { afterEach, describe, expect, test } from "bun:test"
import { spawn, type ChildProcess } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import net from "node:net"
import os from "node:os"
import path from "node:path"

const fixtures: { root: string; child?: ChildProcess; unblock(): void }[] = []

afterEach(async () => {
  for (const fixture of fixtures.splice(0)) {
    fixture.unblock()
    if (fixture.child !== undefined) await stop(fixture.child)
    rmSync(fixture.root, { recursive: true, force: true })
  }
})

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
  child.kill()
  await exited
}

async function waitUntil(predicate: () => boolean | Promise<boolean>, message: string): Promise<void> {
  const deadline = Date.now() + 5000
  while (Date.now() < deadline) {
    if (await predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 25))
  }
  throw new Error(message)
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.once("error", reject)
    server.listen(0, "127.0.0.1", () => {
      const address = server.address()
      if (address === null || typeof address === "string") { server.close(); reject(new Error("missing port")); return }
      server.close(() => resolve(address.port))
    })
  })
}

function fixture(activity: string, pollMs: number, blockWorker = false) {
  const root = mkdtempSync(path.join(os.tmpdir(), "firstmate-archive-review-test-"))
  const homeRoot = path.join(root, "home")
  const projectHome = path.join(homeRoot, "projects", "app")
  const shimDirectory = path.join(root, "bin")
  const logPath = path.join(root, "cli.log")
  const activityPath = path.join(root, "activity.json")
  const workerGatePath = path.join(root, "worker-gate")
  mkdirSync(projectHome, { recursive: true })
  mkdirSync(shimDirectory)
  writeFileSync(logPath, "")
  writeFileSync(activityPath, JSON.stringify({ sessionStatus: { type: activity } }))
  writeFileSync(path.join(homeRoot, "registry.json"), JSON.stringify({ app: {
    slug: "app", projectDirectory: "/repos/app", homeDirectory: projectHome,
    coordinatorSessionId: "ses_coordinator", createdAt: "2026-10-01T08:00:00Z",
  } }))
  writeFileSync(path.join(projectHome, "backlog.md"), "- Old worker\n  state: Done\n  session: ses_old")
  const shimPath = path.join(shimDirectory, "openchamber")
  writeFileSync(shimPath, [
    "#!/bin/sh",
    'printf "%s\\n" "$*" >> "$FIRSTMATE_TEST_CLI_LOG"',
    'case "$2" in',
    '  status) if [ "$4" = "ses_coordinator" ]; then cat "$FIRSTMATE_TEST_ACTIVITY"; else',
    '    while [ "$FIRSTMATE_TEST_BLOCK_WORKER" = "1" ] && [ ! -f "$FIRSTMATE_TEST_WORKER_GATE" ]; do sleep 0.02; done',
    '    echo \'{"type":"idle"}\'; fi ;;',
    '  messages) echo \'{"text":"done: findings saved"}\' ;;',
    '  send) echo \'{"ok":true}\' ;;',
    '  *) echo \'{}\' ;;',
    "esac", "",
  ].join("\n"))
  chmodSync(shimPath, 0o755)
  const tracked: { root: string; child?: ChildProcess; unblock(): void } = { root, unblock: () => writeFileSync(workerGatePath, "continue") }
  fixtures.push(tracked)
  function log(): string { return readFileSync(logPath, "utf8") }
  function sends(): number { return log().split("\n").filter((line) => line.startsWith("session send --session ses_coordinator")).length }
  async function start() {
    const port = await freePort()
    tracked.child = spawn(process.execPath, [path.join(import.meta.dir, "..", "service", "main.ts")], {
      env: {
        ...process.env,
        OPENCHAMBER_SERVICE_PORT: String(port), OPENCHAMBER_SERVICE_TOKEN: "fixture-token",
        FIRSTMATE_HOME: homeRoot, FIRSTMATE_OPENCHAMBER_SETTINGS: path.join(root, "absent-settings.json"),
        FIRSTMATE_POLL_MS: String(pollMs), FIRSTMATE_WATCH_MS: "60000",
        FIRSTMATE_TEST_CLI_LOG: logPath, FIRSTMATE_TEST_ACTIVITY: activityPath,
        FIRSTMATE_TEST_BLOCK_WORKER: blockWorker ? "1" : "0", FIRSTMATE_TEST_WORKER_GATE: workerGatePath,
        PATH: `${shimDirectory}:${process.env.PATH ?? ""}`,
      },
      stdio: ["ignore", "ignore", "ignore"],
    })
    await waitUntil(async () => {
      try { return (await fetch(`http://127.0.0.1:${port}/health`, { headers: { authorization: "Bearer fixture-token" } })).ok } catch { return false }
    }, "service didn't start")
    return tracked.child
  }
  return { start, log, sends, projectHome,
    releaseWorker: tracked.unblock,
    setActivity(value: string) { writeFileSync(activityPath, JSON.stringify({ sessionStatus: { type: value } })) },
    state() { try { return JSON.parse(readFileSync(path.join(projectHome, "archive-review.json"), "utf8")) } catch { return undefined } },
  }
}

describe("service archive-review scheduling", () => {
  test("requests the initial review before the first supervision interval and persists it across restart", async () => {
    const environment = fixture("idle", 60_000)
    const first = await environment.start()
    await waitUntil(() => environment.state() !== undefined, "startup review wasn't delivered and persisted")
    expect(environment.sends()).toBe(1)
    expect(environment.log()).toContain("Scheduled worker-session archival review")
    const deliveredAt = environment.state().lastDeliveredAt
    await stop(first)
    await environment.start()
    // Startup is deliberately before any interval tick, so a duplicate here
    // could only come from the startup sweep itself.
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(environment.sends()).toBe(1)
    expect(environment.state().lastDeliveredAt).toBe(deliveredAt)
    expect(readFileSync(path.join(environment.projectHome, "backlog.md"), "utf8")).toContain("state: Done")
    expect(environment.log()).not.toContain("session create")
  })

  test("defers busy and unknown coordinators, then delivers once when idle", async () => {
    const environment = fixture("busy", 30)
    await environment.start()
    const checks = () => environment.log().split("\n").filter((line) => line.startsWith("session status --session ses_coordinator")).length
    await waitUntil(() => checks() >= 2, "busy coordinator wasn't checked")
    expect(environment.sends()).toBe(0)
    expect(environment.state()).toBeUndefined()
    environment.setActivity("unknown")
    const before = checks()
    await waitUntil(() => checks() >= before + 2, "unknown coordinator wasn't checked")
    expect(environment.sends()).toBe(0)
    environment.setActivity("idle")
    await waitUntil(() => environment.state() !== undefined, "idle coordinator didn't receive the review")
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(environment.sends()).toBe(1)
  })

  test("a slow worker poll doesn't stop a due review from reaching the coordinator", async () => {
    const environment = fixture("busy", 30, true)
    await environment.start()
    await waitUntil(() => environment.log().includes("session status --session ses_old"), "worker polling didn't reach its gate")
    expect(environment.sends()).toBe(0)
    environment.setActivity("idle")
    await waitUntil(() => environment.state() !== undefined, "blocked worker polling prevented the review sweep")
    expect(environment.sends()).toBe(1)
    environment.releaseWorker()
  })
})
