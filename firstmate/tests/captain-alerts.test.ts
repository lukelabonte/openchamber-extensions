import { describe, expect, spyOn, test } from "bun:test"
import type { BacklogTask } from "../service/backlog"
import { formatBacklogEntry } from "../service/backlog"
import type { HttpFetcher, InterruptSupport } from "../service/interrupt"
import { createSupervisionPoller } from "../service/poller"
import { InMemoryFileSystem } from "./helpers/in-memory-file-system"

const homeRoot = "/home/firstmate"
const homeDirectory = `${homeRoot}/projects/sunrise`
const decision: BacklogTask = {
  id: "choose-cache-policy", title: "Choose cache policy", kind: "captain", state: "Blocked",
  hold: "Choose whether this project caches scout findings",
  actions: [{ label: "Reuse", text: "For task choose-cache-policy, reuse checked findings" }, { label: "Fresh", text: "For task choose-cache-policy, commission a fresh scout" }],
}

function harness() {
  const filesystem = new InMemoryFileSystem()
  filesystem.seedFile(`${homeRoot}/registry.json`, JSON.stringify({ sunrise: {
    slug: "sunrise", projectDirectory: "/repos/sunrise", homeDirectory, coordinatorSessionId: "ses_firstmate",
    createdAt: "2026-10-01T08:00:00Z",
  } }))
  const writeTasks = (next: BacklogTask[]) => {
    filesystem.seedFile(`${homeDirectory}/backlog.md`, next.map(formatBacklogEntry).join("\n\n"))
  }
  writeTasks([decision])
  const alerts: Record<string, unknown>[] = []
  let deliveryStatus = 200
  let support: InterruptSupport = { kind: "supported", port: 4096 }
  const fetcher: HttpFetcher = async (url, init) => {
    if (url.includes("/api/notifications/emit")) {
      alerts.push(JSON.parse(init.body!))
      return { status: deliveryStatus }
    }
    return { status: 200, text: async () => JSON.stringify({ pending: {} }) }
  }
  const newPoller = () => createSupervisionPoller({
    filesystem: filesystem.port, homeRoot, fetcher, resolveSupport: async () => support,
    exec: async (_command, args) => args[1] === "status" ? '{"type":"waiting-question"}' : '{"text":"Which test runner?"}',
  })
  return { filesystem, alerts, writeTasks, newPoller, setDeliveryStatus: (status: number) => { deliveryStatus = status }, setSupport: (next: InterruptSupport) => { support = next } }
}

describe("captain decision alerts", () => {
  test("a worker question reaches the first mate without a desktop alert", async () => {
    const input = harness()
    input.writeTasks([{ id: "worker", title: "Worker", state: "Working", sessionId: "ses_worker" }])
    const round = await input.newPoller().poll()
    expect(round.notifications[0]?.message).toContain("waiting on a question")
    expect(input.alerts).toEqual([])
  })

  test("a sessionless captain decision shows its question and choices and opens the first mate", async () => {
    const input = harness()
    await input.newPoller().poll()
    expect(input.alerts).toHaveLength(1)
    expect(input.alerts[0]).toMatchObject({ sessionId: "ses_firstmate", directory: homeDirectory })
    expect(input.alerts[0].title).toContain("sunrise")
    expect(input.alerts[0].body).toContain(decision.title)
    expect(input.alerts[0].body).toContain(decision.id!)
    expect(input.alerts[0].body).toContain(decision.hold!)
    expect(input.alerts[0].body).toContain("Reuse / Fresh")
  })

  test("an unchanged decision stays quiet across polls and service restarts", async () => {
    const input = harness()
    const poller = input.newPoller()
    await poller.poll()
    await poller.poll()
    await input.newPoller().poll()
    expect(input.alerts).toHaveLength(1)
  })

  test("routine timestamp changes do not send another alert", async () => {
    const input = harness()
    const poller = input.newPoller()
    await poller.poll()
    input.writeTasks([{ ...decision, updatedAt: "2026-10-21T10:00:00Z" }])
    await poller.poll()
    expect(input.alerts).toHaveLength(1)
  })

  for (const change of [
    { hold: "Choose whether to keep findings for one week" },
    { actions: [{ label: "Reuse", text: "For task choose-cache-policy, reuse findings for one week" }] },
    { reviewHead: "abcdef1234567" },
    { prUrl: "https://github.com/example/sunrise/pull/12" },
  ]) {
    test(`a changed ${Object.keys(change)[0]} needs a new decision alert`, async () => {
      const input = harness()
      const poller = input.newPoller()
      await poller.poll()
      input.writeTasks([{ ...decision, ...change }])
      await poller.poll()
      await poller.poll()
      expect(input.alerts).toHaveLength(2)
    })
  }

  for (const task of [
    { ...decision, state: "Working" as const, kind: "ship" as const },
    { ...decision, state: "Done" as const },
    { ...decision, state: "Parked" as const },
    { ...decision, state: "Failed" as const },
    { ...decision, hold: undefined },
    { ...decision, actions: [] },
    { ...decision, id: undefined },
    { ...decision, blockedBy: "missing" },
  ]) {
    test(`an unready decision stays quiet: ${JSON.stringify(task)}`, async () => {
      const input = harness()
      input.writeTasks([task])
      await input.newPoller().poll()
      expect(input.alerts).toEqual([])
    })
  }

  test("a queued captain decision and a blocked shipping decision are actionable", async () => {
    const input = harness()
    input.writeTasks([{ ...decision, state: "Queued" }, { ...decision, id: "land", kind: "ship" }])
    await input.newPoller().poll()
    expect(input.alerts).toHaveLength(2)
  })

  test("a decision waits for its dependency to be Done", async () => {
    const input = harness()
    const poller = input.newPoller()
    const prerequisite: BacklogTask = { id: "scout", title: "Scout", kind: "scout", state: "Working" }
    input.writeTasks([{ ...decision, blockedBy: "scout" }, prerequisite])
    await poller.poll()
    expect(input.alerts).toEqual([])
    input.writeTasks([{ ...decision, blockedBy: "scout" }, { ...prerequisite, state: "Done" }])
    await poller.poll()
    expect(input.alerts).toHaveLength(1)
  })

  test("a cleared and later reopened decision alerts again", async () => {
    const input = harness()
    const poller = input.newPoller()
    await poller.poll()
    input.writeTasks([])
    await poller.poll()
    input.writeTasks([decision])
    await input.newPoller().poll()
    expect(input.alerts).toHaveLength(2)
  })

  test("a temporarily gated decision keeps its delivered history", async () => {
    const input = harness()
    const poller = input.newPoller()
    await poller.poll()
    const prerequisite: BacklogTask = { id: "scout", title: "Scout", kind: "scout", state: "Working" }
    input.writeTasks([{ ...decision, blockedBy: "scout" }, prerequisite])
    await poller.poll()
    input.writeTasks([{ ...decision, blockedBy: "scout" }, { ...prerequisite, state: "Done" }])
    await input.newPoller().poll()
    expect(input.alerts).toHaveLength(1)
  })

  test("long questions still leave room for choices and reviewed head", async () => {
    const input = harness()
    input.writeTasks([{
      ...decision, title: "A".repeat(2000), hold: "🙂".repeat(2000), reviewHead: "a".repeat(40),
      actions: [{ label: "Approve", text: "Approve this task" }, { label: "Wait", text: "Wait on this task" }],
    }])
    await input.newPoller().poll()
    const body = input.alerts[0]?.body as string
    expect(body).toContain("Approve / Wait")
    expect(body).toContain("a".repeat(40))
    expect(Array.from(body).length).toBeLessThanOrEqual(1000)
    expect(body).not.toMatch(/[\uD800-\uDFFF]/u)
  })

  test("a failed history save retries without repeating an accepted alert", async () => {
    const input = harness()
    const originalRename = input.filesystem.port.rename
    let storageAvailable = false
    input.filesystem.port.rename = async (fromPath, toPath) => {
      if (toPath.endsWith("/captain-alerts.json") && !storageAvailable) throw new Error("history unavailable")
      await originalRename(fromPath, toPath)
    }
    const errorLog = spyOn(console, "error").mockImplementation(() => {})
    try {
      const poller = input.newPoller()
      await poller.poll()
      await poller.poll()
      expect(input.alerts).toHaveLength(1)
      expect(errorLog).toHaveBeenCalled()
      storageAvailable = true
      await poller.poll()
      await input.newPoller().poll()
      expect(input.alerts).toHaveLength(1)
    } finally {
      errorLog.mockRestore()
    }
  })

  test("invalid history stops alerts without stopping worker supervision", async () => {
    const input = harness()
    input.writeTasks([decision, { title: "Worker", state: "Working", sessionId: "ses_worker" }])
    input.filesystem.seedFile(`${homeDirectory}/captain-alerts.json`, "[]")
    const errorLog = spyOn(console, "error").mockImplementation(() => {})
    try {
      const round = await input.newPoller().poll()
      expect(input.alerts).toEqual([])
      expect(round.notifications[0]?.message).toContain("waiting on a question")
      expect(input.filesystem.fileContents(`${homeDirectory}/captain-alerts.json`)).toBe("[]")
      expect(errorLog).toHaveBeenCalled()
    } finally {
      errorLog.mockRestore()
    }
  })

  test("failed delivery retries only while the decision remains actionable", async () => {
    const input = harness()
    const poller = input.newPoller()
    input.setDeliveryStatus(503)
    await poller.poll()
    input.setDeliveryStatus(200)
    await poller.poll()
    await poller.poll()
    expect(input.alerts).toHaveLength(2)
    input.writeTasks([{ ...decision, hold: "A different decision" }])
    input.setDeliveryStatus(503)
    await poller.poll()
    input.writeTasks([{ ...decision, state: "Done" }])
    await poller.poll()
    expect(input.alerts).toHaveLength(3)
  })

  test("a decision waits for desktop support", async () => {
    const input = harness()
    const poller = input.newPoller()
    input.setSupport({ kind: "unsupported", reason: "No desktop" })
    await poller.poll()
    expect(input.alerts).toEqual([])
    input.setSupport({ kind: "supported", port: 4096 })
    await poller.poll()
    expect(input.alerts).toHaveLength(1)
  })

  test("a malformed backlog cannot clear delivered decision history", async () => {
    const input = harness()
    const poller = input.newPoller()
    await poller.poll()
    input.filesystem.seedFile(`${homeDirectory}/backlog.md`, "- Broken\n  state: not-a-state")
    await poller.poll()
    input.writeTasks([decision])
    await poller.poll()
    expect(input.alerts).toHaveLength(1)
  })
})
