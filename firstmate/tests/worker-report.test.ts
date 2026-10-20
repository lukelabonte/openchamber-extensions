import { describe, expect, test } from "bun:test"
import { parseWorkerReport, reportPullRequestUrl, workerReportStates } from "../service/worker-report"
import { buildBoardWorker } from "../service/board"
import { parseBoardWorkers, toBoardCard } from "../panel/board"
import { createSupervisionPoller } from "../service/poller"
import { InMemoryFileSystem } from "./helpers/in-memory-file-system"

describe("worker closing reports", () => {
  test("an empty closing claim doesn't substitute an older status or borrow text from another line", () => {
    expect(parseWorkerReport("done: Earlier claim\nblocked:\nWaiting on CI")).toEqual({ state: "blocked", text: "" })
  })
  test.each([...workerReportStates])("recognizes the closing %s status", (state) => {
    expect(parseWorkerReport(`Details\r\n\r\n${state}: Evidence or next gate`)).toEqual({ state, text: "Evidence or next gate" })
  })

  test.each(["- **blocked**: Waiting on CI", "**blocked:** Waiting on CI", "**blocked: Waiting on CI**", "status = BLOCKED [task=login]: Waiting on CI"])("accepts a formatted closing status: %s", (line) => {
    expect(parseWorkerReport(line)).toEqual({ state: "blocked", text: "Waiting on CI" })
  })

  test("normalizes decision spellings and takes the latest of the final four nonempty lines", () => {
    expect(parseWorkerReport("done: Old claim\n\nneeds_decision: Choose a path\nSupporting evidence")).toEqual({ state: "needs-decision", text: "Choose a path" })
    expect(parseWorkerReport("blocked: Not a closing report\na\nb\nc\nd")).toBeUndefined()
  })

  test.each([undefined, "", "The build is done: that's prose", "> blocked: quoted text", "```text\nfailed: example\n```", "~~~text\ndone: example\n~~~", "```text\nblocked: unfinished code"])("doesn't turn prose, quotes or code into a report: %j", (message) => {
    expect(parseWorkerReport(message)).toBeUndefined()
  })

  test("keeps worker testimony separate from coordinator-owned states and host failure evidence", () => {
    for (const state of ["Blocked", "Parked", "Done", "Failed", "Idle"] as const) {
      const worker = buildBoardWorker({ title: "Task", state, sessionId: "ses_worker" }, { status: { activity: "idle", outcome: null }, lastWord: "done: Claimed completion" })
      expect(worker.state).toBe(state)
      expect(worker.workerReport?.state).toBe("done")
    }
    expect(buildBoardWorker({ title: "Task", state: "Working", sessionId: "ses_worker" }, { status: { activity: "idle", outcome: "failed" }, lastWord: "done: Claimed completion" }).state).toBe("Failed")
    for (const activity of ["running", "retrying", "unknown", "waiting-question", "waiting-permission"] as const) {
      expect(buildBoardWorker({ title: "Task", state: "Working", sessionId: "ses_worker" }, { status: { activity, outcome: null }, lastWord: "blocked: Old report" }).workerReport).toBeUndefined()
    }
  })

  test("doesn't relabel retained text as a fresh report after a failed observation", () => {
    expect(buildBoardWorker({ title: "Task", state: "Working", sessionId: "ses_worker" }, { status: { activity: "idle", outcome: null }, lastWord: "done: Old report", error: "Host unreachable" }).workerReport).toBeUndefined()
  })

  test("keeps the precise message identity while showing its closing report", () => {
    const text = `${"Details ".repeat(100)}\nblocked: Waiting for CI`
    const worker = buildBoardWorker({ title: "Task", state: "Working", sessionId: "ses_worker" }, { status: { activity: "idle", outcome: null }, lastWord: text, last: { id: "msg_report", text } })
    const card = toBoardCard(parseBoardWorkers([worker]).workers[0])
    expect(card.workerReport).toEqual({ state: "blocked", text: "Waiting for CI" })
    expect(card.lastMessageId).toBe("msg_report")
    expect(card.state).toBe("Idle")
  })

  test("polling carries the full closing report into cards and drops it when a new turn starts or reads fail", async () => {
    const filesystem = new InMemoryFileSystem()
    filesystem.seedFile("/fm/registry.json", JSON.stringify({ project: { slug: "project", projectDirectory: "/repo", homeDirectory: "/fm/projects/project", coordinatorSessionId: "ses_mate", createdAt: "2026-10-20T00:00:00Z" } }))
    filesystem.seedFile("/fm/projects/project/backlog.md", "- Task\n  state: Working\n  session: ses_worker\n")
    let activity = "idle"
    let failRead = false
    const text = `${"Detailed evidence. ".repeat(100)}\ndone: PR https://github.com/owner/repo/pull/42`
    const poller = createSupervisionPoller({
      filesystem: filesystem.port, homeRoot: "/fm", fetcher: async () => ({ status: 404 }),
      resolveSupport: async () => ({ kind: "unsupported", reason: "No desktop proxy" }),
      exec: async (_command, args) => {
        if (failRead) throw new Error("Host unavailable")
        return JSON.stringify(args[1] === "status" ? { sessionStatus: { type: activity } } : { sessionId: "ses_worker", messages: [{ id: "msg_report", role: "assistant", text }] })
      },
    })
    const tasks = [{ title: "Task", state: "Working" as const, sessionId: "ses_worker" }]
    await poller.poll()
    expect(poller.getBoardWorkers("project", tasks)[0]).toMatchObject({ state: "Idle", workerReport: { state: "done", text: "PR https://github.com/owner/repo/pull/42" }, lastMessageId: "msg_report" })
    failRead = true
    await poller.poll()
    expect(poller.getBoardWorkers("project", tasks)[0].workerReport).toBeUndefined()
    failRead = false
    activity = "busy"
    await poller.poll()
    expect(poller.getBoardWorkers("project", tasks)[0]).toMatchObject({ state: "Working", lastMessageId: "msg_report" })
    expect(poller.getBoardWorkers("project", tasks)[0].workerReport).toBeUndefined()
  })
})

describe("worker-reported PR links", () => {
  test.each(["`", '"', "'", "**", "__", "*", "_"])("recognizes markdown wrappers around a reported PR: %s", (marker) => {
    const url = "https://github.com/owner/repo/pull/42"
    expect(reportPullRequestUrl(`PR ${marker}${url}${marker}`)).toBe(url)
  })
  test("extracts only a valid GitHub pull request URL, without trailing punctuation", () => {
    expect(reportPullRequestUrl("PR [review](https://github.com/owner/repo/pull/42). Tests passed.")).toBe("https://github.com/owner/repo/pull/42")
    expect(reportPullRequestUrl("https://example.com/doc then https://github.com/owner/repo/pull/42,")).toBe("https://github.com/owner/repo/pull/42")
  })

  test.each(["javascript:alert(1)", "http://github.com/owner/repo/pull/42", "https://github.com.evil.test/owner/repo/pull/42", "https://github.com@evil.test/owner/repo/pull/42", "https://user@github.com/owner/repo/pull/42", "https://github.com/owner/repo/issues/42", "https://github.com/owner/repo/pull/0"])("doesn't make this a PR button: %s", (text) => {
    expect(reportPullRequestUrl(text)).toBeUndefined()
  })

  test("uses a reported PR only as a labeled fallback to the backlog's recorded PR", () => {
    const reportPrUrl = "https://github.com/owner/repo/pull/42"
    const parsed = parseBoardWorkers([{ title: "Task", state: "Idle", workerReport: { state: "done", text: "PR ready" }, reportPrUrl }])
    expect(toBoardCard(parsed.workers[0])).toMatchObject({ prUrl: reportPrUrl, prOpenable: true, prSource: "worker-report" })
    const withBacklog = parseBoardWorkers([{ ...parsed.workers[0], prUrl: "https://github.com/owner/repo/pull/43" }])
    expect(toBoardCard(withBacklog.workers[0]).prUrl).toBe("https://github.com/owner/repo/pull/43")
    expect(toBoardCard(withBacklog.workers[0]).prSource).toBeUndefined()
  })

  test("bad optional report metadata doesn't discard a valid legacy worker card", () => {
    for (const workerReport of [null, "done", { state: "unknown", text: "x" }, { state: "done", text: 3 }]) {
      const parsed = parseBoardWorkers([{ title: "Task", state: "Idle", workerReport, reportPrUrl: "javascript:alert(1)" }])
      expect(parsed.workers).toHaveLength(1)
      expect(toBoardCard(parsed.workers[0]).workerReport).toBeUndefined()
      expect(toBoardCard(parsed.workers[0]).prUrl).toBeUndefined()
    }
  })
})
