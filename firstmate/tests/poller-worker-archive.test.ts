import { describe, expect, test } from "bun:test"
import { loadArchivedSessionIds, archiveSession } from "../service/archive"
import { formatBacklogEntry, type BacklogTask } from "../service/backlog"
import type { ExecRunner } from "../service/control-client"
import type { HttpFetcher } from "../service/interrupt"
import { createSupervisionPoller } from "../service/poller"
import { InMemoryFileSystem } from "./helpers/in-memory-file-system"

const homeRoot = "/home/firstmate"
const backlogPath = `${homeRoot}/projects/app/backlog.md`
const task: BacklogTask = { title: "Inspect app", id: "inspect-app", kind: "scout", state: "Done", sessionId: "ses_worker", archiveSessionId: "ses_worker" }

function fixture() {
  const filesystem = new InMemoryFileSystem()
  filesystem.seedFile(`${homeRoot}/registry.json`, JSON.stringify({ app: {
    slug: "app", projectDirectory: "/repos/app", homeDirectory: `${homeRoot}/projects/app`,
    coordinatorSessionId: "ses_coordinator", createdAt: "2026-10-01T08:00:00Z",
  } }))
  filesystem.seedFile(backlogPath, formatBacklogEntry(task))
  filesystem.seedFile(`${homeRoot}/projects/app/reports/inspect-app.md`, "Checked outcome and evidence.")
  const archiveCalls: string[] = []
  let busy = false
  let failed = false
  let waiting = false
  let unknown = false
  const exec: ExecRunner = async (_command, args) => args[1] === "status"
    ? JSON.stringify({ sessionId: "ses_worker", sessionStatus: { type: busy ? "busy" : "idle" } })
    : JSON.stringify({ messages: [{ id: "msg_result", role: "assistant", text: "done: checked outcome" }] })
  const fetcher: HttpFetcher = async (url, init) => {
    let payload: unknown = {}
    if (url.endsWith("/api/sessions/status")) {
      if (unknown) return { status: 503 }
      payload = { pending: waiting ? { ses_worker: { forms: [{}] } } : {} }
    }
    if (url.includes("/api/session/")) payload = { id: "ses_worker", time: { idle: 1600 } }
    if (url.endsWith("/api/openchamber/sessions/archive")) {
      archiveCalls.push(init.body!)
      if (failed) return { status: 503 }
      payload = { archived: [{ id: "ses_worker", archivedAt: 1700 }], failedIds: [] }
    }
    return { status: 200, text: async () => JSON.stringify(payload) }
  }
  const createPoller = () => createSupervisionPoller({
    filesystem: filesystem.port, exec, homeRoot, fetcher,
    resolveSupport: async () => ({ kind: "supported", port: 4096 }), nowMs: () => 1700,
  })
  return { filesystem, poller: createPoller(), createPoller, archiveCalls,
    setBusy(value: boolean) { busy = value }, setFailed(value: boolean) { failed = value },
    setWaiting(value: boolean) { waiting = value }, setUnknown(value: boolean) { unknown = value },
  }
}

describe("supervision executes explicit archive requests", () => {
  test("archives once and reports confirmation to the coordinator, including after a service restart", async () => {
    const { filesystem, poller, createPoller, archiveCalls } = fixture()
    const first = await poller.poll()
    expect(archiveCalls).toEqual(['{"ids":["ses_worker"]}'])
    expect(first.notifications.some((notification) => notification.message.includes("ses_worker") && notification.message.includes("archived"))).toBe(true)
    await poller.poll()
    await createPoller().poll()
    expect(archiveCalls).toHaveLength(1)
    expect(await loadArchivedSessionIds(filesystem.port, homeRoot, "app")).toEqual(new Set(["ses_worker"]))
  })

  test("Done alone doesn't trigger archival", async () => {
    const { filesystem, poller, archiveCalls } = fixture()
    filesystem.seedFile(backlogPath, formatBacklogEntry({ ...task, archiveSessionId: undefined }))
    await poller.poll()
    expect(archiveCalls).toHaveLength(0)
  })

  test("waits for a busy worker to become idle without losing the request", async () => {
    const { poller, archiveCalls, setBusy } = fixture()
    setBusy(true)
    await poller.poll()
    expect(archiveCalls).toHaveLength(0)
    setBusy(false)
    await poller.poll()
    expect(archiveCalls).toHaveLength(1)
  })

  test("doesn't archive workers with pending questions or unknown blocking state", async () => {
    const { poller, archiveCalls, setWaiting, setUnknown } = fixture()
    setWaiting(true)
    await poller.poll()
    setWaiting(false)
    setUnknown(true)
    await poller.poll()
    expect(archiveCalls).toHaveLength(0)
    setUnknown(false)
    await poller.poll()
    expect(archiveCalls).toHaveLength(1)
  })

  test("reports a host failure once and retries only after the coordinator clears and re-adds the request", async () => {
    const { filesystem, poller, archiveCalls, setFailed } = fixture()
    setFailed(true)
    const first = await poller.poll()
    expect(first.notifications.some((notification) => notification.message.includes("archive") && notification.message.includes("503"))).toBe(true)
    const second = await poller.poll()
    expect(second.notifications).toHaveLength(0)
    expect(archiveCalls).toHaveLength(1)
    filesystem.seedFile(backlogPath, formatBacklogEntry({ ...task, archiveSessionId: undefined }))
    await poller.poll()
    filesystem.seedFile(backlogPath, formatBacklogEntry(task))
    setFailed(false)
    await poller.poll()
    expect(archiveCalls).toHaveLength(2)
  })

  test("a previous board-only End doesn't count as host archival", async () => {
    const { filesystem, poller, archiveCalls } = fixture()
    await archiveSession(filesystem.port, homeRoot, "app", { sessionId: "ses_worker", title: task.title, archivedAt: new Date(1600).toISOString() })
    await poller.poll()
    expect(archiveCalls).toHaveLength(1)
  })

  test("a request for an old session never archives a replacement", async () => {
    const { filesystem, poller, archiveCalls } = fixture()
    filesystem.seedFile(backlogPath, formatBacklogEntry({ ...task, archiveSessionId: "ses_previous" }))
    await poller.poll()
    expect(archiveCalls).toHaveLength(0)
  })
})
