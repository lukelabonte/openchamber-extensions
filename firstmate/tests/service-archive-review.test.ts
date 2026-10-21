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
  let settingsPath = path.join(root, "absent-settings.json")
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
        FIRSTMATE_HOME: homeRoot, FIRSTMATE_OPENCHAMBER_SETTINGS: settingsPath,
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
    setupCleanup(hostPort: number) {
      settingsPath = path.join(root, "desktop-settings.json")
      writeFileSync(settingsPath, JSON.stringify({ desktopLocalPort: hostPort, desktopLocalClientToken: "desktop-token" }))
      writeFileSync(path.join(projectHome, "backlog.md"), "- Ship search\n  state: Done\n  id: search\n  kind: ship\n  session: ses_old\n  pr: https://github.com/owner/app/pull/7")
      mkdirSync(path.join(projectHome, "reports"), { recursive: true })
      writeFileSync(path.join(projectHome, "reports", "search.md"), "Verified merged PR: https://github.com/owner/app/pull/7. Worker ses_old. Worktree and branch retained.")
      writeFileSync(path.join(projectHome, "reports", "archive.jsonl"), JSON.stringify({ sessionId: "ses_old", title: "Ship search", archivedAt: "2026-10-21T10:00:00Z", hostArchived: true }) + "\n")
      const ghPath = path.join(shimDirectory, "gh")
      writeFileSync(ghPath, '#!/bin/sh\nprintf "gh %s\\n" "$*" >> "$FIRSTMATE_TEST_CLI_LOG"\necho \'{"state":"MERGED","mergedAt":"2026-10-21T10:00:00Z","url":"https://github.com/owner/app/pull/7"}\'\n')
      chmodSync(ghPath, 0o755)
    },
    releaseWorker: tracked.unblock,
    setActivity(value: string) { writeFileSync(activityPath, JSON.stringify({ sessionStatus: { type: value } })) },
    state() { try { return JSON.parse(readFileSync(path.join(projectHome, "archive-review.json"), "utf8")) } catch { return undefined } },
  }
}

describe("service archive-review scheduling", () => {
  test("requests the initial review before the first supervision interval and persists it across restart", async () => {
    const environment = fixture("idle", 60_000)
    const first = await environment.start()
    await waitUntil(() => environment.state()?.lastDeliveredAt !== undefined, "startup review wasn't delivered and persisted")
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
    await waitUntil(() => environment.state()?.lastDeliveredAt !== undefined, "idle coordinator didn't receive the review")
    await new Promise((resolve) => setTimeout(resolve, 150))
    expect(environment.sends()).toBe(1)
  })

  test("a slow worker poll doesn't stop a due review from reaching the coordinator", async () => {
    const environment = fixture("busy", 30, true)
    await environment.start()
    await waitUntil(() => environment.log().includes("session status --session ses_old"), "worker polling didn't reach its gate")
    expect(environment.sends()).toBe(0)
    environment.setActivity("idle")
    await waitUntil(() => environment.state()?.lastDeliveredAt !== undefined, "blocked worker polling prevented the review sweep")
    expect(environment.sends()).toBe(1)
    environment.releaseWorker()
  })

  test("unlinks a historical merged PR through the authenticated desktop route without waking or deleting workers", async () => {
    const pull = { id: "owner/app#7", title: "Ship search", kind: "pull", url: "https://github.com/owner/app/pull/7", number: 7 }
    const issue = { id: "owner/app#8", title: "Keep issue", kind: "issue", url: "https://github.com/owner/app/issues/8" }
    let links = [pull, issue]
    const requests: { path: string; body?: unknown; token: string }[] = []
    const host = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(request) {
      const url = new URL(request.url)
      const body = request.method === "POST" ? await request.json() : undefined
      requests.push({ path: url.pathname, body, token: request.headers.get("authorization") })
      if (url.pathname === "/api/sessions/status" && request.method === "GET") return Response.json({})
      if (url.pathname === "/api/openchamber/sessions/ses_coordinator/links" && request.method === "POST") links = [issue]
      else if (url.pathname !== "/api/openchamber/sessions/ses_coordinator/metadata") return new Response("unexpected operation", { status: 400 })
      return Response.json({ metadata: { openchamber: { linked_issues: links } } })
    } })
    const environment = fixture("idle", 30)
    environment.setupCleanup(host.port)
    try {
      const child = await environment.start()
      await waitUntil(() => environment.state()?.lastCleanupAttemptAt !== undefined, "PR cleanup didn't finish")
      expect(links).toEqual([issue])
      expect(requests.filter((request) => request.path.startsWith("/api/openchamber/sessions/"))).toEqual([
        { path: "/api/openchamber/sessions/ses_coordinator/metadata", body: undefined, token: "Bearer desktop-token" },
        { path: "/api/openchamber/sessions/ses_coordinator/links", body: { directory: environment.projectHome, entries: [pull], linked: false }, token: "Bearer desktop-token" },
      ])
      expect(requests.filter((request) => request.body !== undefined)).toHaveLength(1)
      expect(environment.log()).toContain("gh pr view https://github.com/owner/app/pull/7 --json state,mergedAt,url")
      expect(environment.sends()).toBe(0)
      expect(environment.state().lastDeliveredAt).toBeUndefined()
      expect(readFileSync(path.join(environment.projectHome, "backlog.md"), "utf8")).toContain(pull.url)
      expect(readFileSync(path.join(environment.projectHome, "reports", "search.md"), "utf8")).toContain("Worktree and branch retained")
      await stop(child)
      await environment.start()
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(requests.filter((request) => request.path.startsWith("/api/openchamber/sessions/"))).toHaveLength(2)
      expect(environment.sends()).toBe(0)
    } finally {
      host.stop(true)
    }
  })
})
