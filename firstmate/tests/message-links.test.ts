import { describe, expect, test } from "bun:test"
import { workerMessageLink } from "../service/message-links"
import { sessionLastAssistant, type ExecRunner } from "../service/control-client"
import { buildBoardWorker } from "../service/board"
import { parseBoardWorkers, toBoardCard } from "../panel/board"
import { createSupervisionPoller } from "../service/poller"
import { InMemoryFileSystem } from "./helpers/in-memory-file-system"

describe("exact worker message references", () => {
  test("uses OpenChamber's message target, not bb's sequence-number link", () => {
    expect(workerMessageLink("ses_worker", "msg_report")).toBe("openchamber://session/ses_worker?message=msg_report")
    expect(workerMessageLink("s".repeat(128), "m".repeat(128))).toBeDefined()
  })

  test.each(["", "../other", "msg_1?message=other", "msg_1#fragment", "msg_1)", "msg_1\n", "m".repeat(129)])("doesn't manufacture links from invalid identifiers: %j", (value) => {
    expect(workerMessageLink(value, "msg_report")).toBeUndefined()
    expect(workerMessageLink("ses_worker", value)).toBeUndefined()
  })

  test("the message identity survives both service and panel previews", () => {
    const worker = buildBoardWorker({ title: "Login", state: "Working", sessionId: "ses_worker" }, {
      status: { activity: "running", outcome: null }, lastWord: "Report ".repeat(100),
      last: { id: "msg_report", text: "Report ".repeat(100), createdAt: 10, completedAt: 20 },
    })
    const parsed = parseBoardWorkers([worker])
    expect(parsed.malformedCount).toBe(0)
    expect(parsed.workers[0].lastMessageId).toBe("msg_report")
    expect(toBoardCard(parsed.workers[0]).lastMessageId).toBe("msg_report")
    expect(toBoardCard(parsed.workers[0]).lastWord!.length).toBeLessThan(150)
  })

  test("a legacy message without an ID never gets a made-up source", () => {
    const worker = buildBoardWorker({ title: "Login", state: "Working", sessionId: "ses_worker" }, {
      status: { activity: "idle", outcome: null }, lastWord: "Report", last: { text: "Report" },
    })
    expect(worker.lastMessageId).toBeUndefined()
    expect(toBoardCard(parseBoardWorkers([worker]).workers[0]).lastMessageId).toBeUndefined()
  })

  test("a legacy fallback text isn't attributed to a different message-array entry", async () => {
    const exec: ExecRunner = async () => JSON.stringify({
      sessionId: "ses_worker", text: "Legacy report text", messages: [{ id: "msg_without_text", role: "assistant" }],
    })
    const last = await sessionLastAssistant(exec, { sessionId: "ses_worker", directory: "/repo" })
    expect(last.text).toBe("Legacy report text")
    expect(last.id).toBeUndefined()
  })

  test("malformed message identity never becomes a link or blanks a valid card", () => {
    for (const lastMessageId of [42, "", "msg_bad?other=1"]) {
      const parsed = parseBoardWorkers([{ title: "Login", state: "Working", sessionId: "ses_worker", lastWord: "Report", lastMessageId }])
      expect(parsed.workers).toHaveLength(1)
      expect(parsed.workers[0].lastMessageId).toBeUndefined()
    }
  })

  test.each([
    { sessionId: "ses_other", messages: [{ id: "msg_report", role: "assistant", text: "Other session" }] },
    { sessionId: "ses_worker", messages: [{ id: "msg_report", role: "user", text: "Not a worker report" }] },
  ])("rejects mismatched session or role before treating a message as worker evidence", async (payload) => {
    const exec: ExecRunner = async () => JSON.stringify(payload)
    await expect(sessionLastAssistant(exec, { directory: "/repo", sessionId: "ses_worker" })).rejects.toThrow()
  })

  test("the reported outcome points to the observed message even after later turns", async () => {
    const filesystem = new InMemoryFileSystem()
    filesystem.seedFile("/fm/registry.json", JSON.stringify({ project: { slug: "project", projectDirectory: "/repo", homeDirectory: "/fm/projects/project", coordinatorSessionId: "ses_mate", createdAt: "2026-10-16T00:00:00Z" } }))
    filesystem.seedFile("/fm/projects/project/backlog.md", "- Login\n  state: Working\n  session: ses_worker\n")
    let messageId = "msg_report"
    const exec: ExecRunner = async (_command, args) => JSON.stringify(args[1] === "status"
      ? { sessionStatus: { type: "idle" } }
      : { sessionId: "ses_worker", messages: [{ id: messageId, role: "assistant", text: `done: verified evidence for ${messageId}` }] })
    const poller = createSupervisionPoller({ filesystem: filesystem.port, exec, homeRoot: "/fm", fetcher: async () => ({ status: 404 }), resolveSupport: async () => ({ kind: "unsupported", reason: "No desktop proxy" }) })
    const first = await poller.poll()
    expect(first.notifications[0].message).toContain("[Read worker message](openchamber://session/ses_worker?message=msg_report)")
    messageId = "msg_later"
    await poller.poll()
    expect(first.notifications[0].message).not.toContain("msg_later")
    const tasks = [{ title: "Login", state: "Working" as const, sessionId: "ses_worker" }]
    expect(poller.getBoardWorkers("project", tasks)[0].lastMessageId).toBe("msg_later")
    poller.markSteered("project", "ses_worker")
    messageId = "msg_reply"
    const reply = await poller.poll()
    expect(reply.notifications[0].message).toContain("answered the captain's steer")
    expect(reply.notifications[0].message).toContain("[Read worker message](openchamber://session/ses_worker?message=msg_reply)")
  })
})
