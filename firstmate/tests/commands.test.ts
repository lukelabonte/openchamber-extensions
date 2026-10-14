import { describe, expect, test } from "bun:test"
import { runFirstmateCommand, type FirstmateCommandHost } from "../panel/commands"
import { registerFirstmateBackground } from "../panel/background"

function fixture() {
  const requests: Array<{ method: string; path: string; query?: Record<string, string>; body?: string }> = []
  const opened: string[] = []
  const toasts: Array<{ kind: string; message: string }> = []
  let response: { status: number; body: string } | undefined
  const host: FirstmateCommandHost = {
    serviceRequest: async (request) => {
      requests.push(request)
      return response ?? { status: 200, body: request.path === "/lookup" ? JSON.stringify({ registration: { slug: "sunrise", homeDirectory: "/fm/projects/sunrise", coordinatorSessionId: "ses_mate" } }) : '{"sent":true}' }
    },
    openSession: async (sessionId) => { opened.push(sessionId) },
    toast: async (toast) => { toasts.push(toast) },
  }
  return { host, requests, opened, toasts, respond: (value: typeof response) => { response = value } }
}

describe("native FirstMate commands", () => {
  test("/fm forwards exact arguments and captured origin without a model or chip", async () => {
    const { host, requests, toasts } = fixture()
    const text = '  Review this\n`$(touch unsafe)`\n  keep spacing  \n'
    expect(await runFirstmateCommand({ command: "fm", args: text, context: { directory: "/repos/sunrise", sessionId: "ses_worker" }, host })).toBeNull()
    expect(requests).toHaveLength(1)
    expect(requests[0].path).toBe("/handoff")
    expect(JSON.parse(requests[0].body!)).toEqual({ directory: "/repos/sunrise", sessionId: "ses_worker", text })
    expect(toasts).toHaveLength(1)
    expect(toasts[0].kind).toBe("success")
  })

  test.each(["", " \n "])("empty /fm is actionable and does not send", async (args) => {
    const { host, requests } = fixture()
    await expect(runFirstmateCommand({ command: "fm", args, context: { directory: "/repos/sunrise" }, host })).rejects.toThrow("A handoff needs text after /fm")
    expect(requests).toHaveLength(0)
  })

  test("a missing session id is not replaced by a different thread's id", async () => {
    const { host, requests } = fixture()
    await runFirstmateCommand({ command: "fm", args: "Review", context: { directory: "/repos/sunrise", sessionId: null }, host })
    expect(JSON.parse(requests[0].body!)).toEqual({ directory: "/repos/sunrise", text: "Review" })
  })

  test("UTF-8 byte limit is checked without a service request", async () => {
    const { host, requests } = fixture()
    await expect(runFirstmateCommand({ command: "fm", args: "é".repeat(6001), context: { directory: "/repos/sunrise" }, host })).rejects.toThrow("12,000")
    expect(requests).toHaveLength(0)
  })

  test.each([["", "bearings"], ["file", "bearings-file"]])("/fm-bearings %s resolves this project's slug", async (args, command) => {
    const { host, requests } = fixture()
    await runFirstmateCommand({ command: "fm-bearings", args, context: { directory: "/worktrees/login", sessionId: "ses_worker" }, host })
    expect(requests[0]).toEqual({ method: "GET", path: "/lookup", query: { directory: "/worktrees/login" } })
    expect(JSON.parse(requests[1].body!)).toEqual({ slug: "sunrise", command })
    expect(requests[1].path).toBe("/command")
  })

  test("/fm-open opens only the resolved coordinator", async () => {
    const { host, requests, opened } = fixture()
    await runFirstmateCommand({ command: "fm-open", args: "", context: { directory: "/repos/sunrise" }, host })
    expect(requests).toHaveLength(1)
    expect(opened).toEqual(["ses_mate"])
  })

  test.each([["fm-bearings", "other"], ["fm-open", "another-thread"], ["unknown", ""]])("invalid command usage %s does not send", async (command, args) => {
    const { host, requests, opened } = fixture()
    await expect(runFirstmateCommand({ command, args, context: { directory: "/repos/sunrise" }, host })).rejects.toThrow()
    expect(requests).toHaveLength(0)
    expect(opened).toHaveLength(0)
  })

  test("missing directory never falls back to a selected or first project", async () => {
    const { host, requests } = fixture()
    await expect(runFirstmateCommand({ command: "fm", args: "Review", context: { directory: null }, host })).rejects.toThrow("directory")
    expect(requests).toHaveLength(0)
  })

  test("unregistered project does not open another mate", async () => {
    const { host, respond, opened } = fixture()
    respond({ status: 200, body: '{"registration":null}' })
    await expect(runFirstmateCommand({ command: "fm-open", args: "", context: { directory: "/repos/other" }, host })).rejects.toThrow("registered")
    expect(opened).toHaveLength(0)
  })

  test("service failures preserve the status and actionable error", async () => {
    const { host, respond, toasts } = fixture()
    respond({ status: 409, body: '{"error":"coordinator is busy"}' })
    await expect(runFirstmateCommand({ command: "fm", args: "Review", context: { directory: "/repos/sunrise" }, host })).rejects.toThrow("409")
    await expect(runFirstmateCommand({ command: "fm", args: "Review", context: { directory: "/repos/sunrise" }, host })).rejects.toThrow("coordinator is busy")
    expect(toasts).toHaveLength(0)
  })

  test.each(["not json", "null", "[]", "{}", '{"sent":false}'])("malformed handoff answer %s is not success", async (body) => {
    const { host, respond, toasts } = fixture()
    respond({ status: 200, body })
    await expect(runFirstmateCommand({ command: "fm", args: "Review", context: { directory: "/repos/sunrise" }, host })).rejects.toThrow("malformed")
    expect(toasts).toHaveLength(0)
  })

  test("bearings also rejects a malformed delivery answer", async () => {
    const { host, toasts } = fixture()
    const request = host.serviceRequest
    host.serviceRequest = (input) => input.path === "/lookup" ? request(input) : Promise.resolve({ status: 200, body: '{"sent":false}' })
    await expect(runFirstmateCommand({ command: "fm-bearings", args: "", context: { directory: "/repos/sunrise" }, host })).rejects.toThrow("malformed")
    expect(toasts).toHaveLength(0)
  })

  test("malformed error bodies still report the non-200 status", async () => {
    const { host, respond } = fixture()
    respond({ status: 503, body: "not json" })
    await expect(runFirstmateCommand({ command: "fm", args: "Review", context: { directory: "/repos/sunrise" }, host })).rejects.toThrow("503")
  })

  test("success is not returned until its toast has completed", async () => {
    const { host } = fixture()
    let finishToast: () => void
    const toastStarted = new Promise<void>((resolve) => {
      host.toast = () => { resolve(); return new Promise<void>((finish) => { finishToast = finish }) }
    })
    let completed = false
    const pending = runFirstmateCommand({ command: "fm", args: "Review", context: { directory: "/repos/sunrise" }, host }).then(() => { completed = true })
    await toastStarted
    expect(completed).toBe(false)
    finishToast!()
    await pending
    expect(completed).toBe(true)
  })

  test.each(["not json", "null", "[]", "{}", '{"registration":{}}', '{"registration":{"slug":"sunrise","homeDirectory":"/fm/projects/sunrise","coordinatorSessionId":""}}'])("malformed lookup answer %s is rejected", async (body) => {
    const { host, respond, opened } = fixture()
    respond({ status: 200, body })
    await expect(runFirstmateCommand({ command: "fm-open", args: "", context: { directory: "/repos/sunrise" }, host })).rejects.toThrow("malformed")
    expect(opened).toHaveLength(0)
  })

  test("context is captured before asynchronous lookup", async () => {
    const { host, requests } = fixture()
    const context = { directory: "/repos/sunrise", sessionId: "ses_worker" }
    const pending = runFirstmateCommand({ command: "fm-bearings", args: "", context, host })
    context.directory = "/repos/other"
    context.sessionId = "ses_other"
    await pending
    expect(requests[0].query).toEqual({ directory: "/repos/sunrise" })
    expect(JSON.parse(requests[1].body!)).toEqual({ slug: "sunrise", command: "bearings" })
  })
})

describe("FirstMate background handlers", () => {
  function backgroundFixture() {
    const base = fixture()
    const handlers: Record<string, (...args: any[]) => any> = {}
    registerFirstmateBackground({ ...base.host,
      onReady: (handler) => { handlers.ready = handler; return () => {} },
      onResolve: (handler) => { handlers.resolve = handler; return () => {} },
      onAction: (handler) => { handlers.action = handler; return () => {} },
    })
    return { ...base, handlers }
  }

  test("registers synchronously and awaits the first ready snapshot for slash commands", async () => {
    const { handlers, requests } = backgroundFixture()
    expect(Object.keys(handlers).sort()).toEqual(["action", "ready", "resolve"])
    const request = { command: "fm", args: "  Review\nexact text\n" }
    const pending = handlers.resolve(request)
    request.args = "changed after invocation"
    expect(requests).toHaveLength(0)
    const ready = { directory: "/repos/sunrise", session: { id: "ses_worker" } }
    handlers.ready(ready)
    ready.directory = "/repos/other"
    ready.session.id = "ses_other"
    handlers.ready(ready)
    expect(await pending).toBeNull()
    expect(JSON.parse(requests[0].body!)).toEqual({ directory: "/repos/sunrise", sessionId: "ses_worker", text: "  Review\nexact text\n" })
  })

  test("message action uses the clicked user's text and origin even without ready", async () => {
    const { handlers, requests } = backgroundFixture()
    const item = { kind: "message", action: "firstmate-handoff", role: "user", directory: "/worktrees/login", sessionId: "ses_clicked", text: "  Clicked\ntext\n" }
    const pending = handlers.action(item)
    item.directory = "/repos/other"
    item.sessionId = "ses_selected"
    item.text = "selected text"
    handlers.ready({ directory: "/repos/selected", session: { id: "ses_selected" } })
    await pending
    expect(JSON.parse(requests[0].body!)).toEqual({ directory: "/worktrees/login", sessionId: "ses_clicked", text: "  Clicked\ntext\n" })
  })

  test.each(["firstmate-open", "firstmate-bearings"])("session action %s uses clicked directory", async (action) => {
    const { handlers, requests, opened } = backgroundFixture()
    handlers.ready({ directory: "/repos/selected", session: { id: "ses_selected" } })
    await handlers.action({ kind: "session", action, directory: "/repos/clicked", sessionId: "ses_clicked" })
    expect(requests[0].query).toEqual({ directory: "/repos/clicked" })
    if (action === "firstmate-open") expect(opened).toEqual(["ses_mate"])
    else expect(JSON.parse(requests[1].body!)).toEqual({ slug: "sunrise", command: "bearings" })
  })

  test.each([
    { kind: "message", action: "firstmate-handoff", role: "assistant", directory: "/repos/sunrise", sessionId: "ses_clicked", text: "answer" },
    { kind: "message", action: "firstmate-open", role: "user", directory: "/repos/sunrise", sessionId: "ses_clicked", text: "request" },
    { kind: "session", action: "firstmate-handoff", directory: "/repos/sunrise", sessionId: "ses_clicked" },
    { kind: "message", action: "firstmate-handoff", role: "user", directory: null, sessionId: "ses_clicked", text: "request" },
    { kind: "session", action: "unknown", directory: "/repos/sunrise", sessionId: "ses_clicked" },
  ])("invalid action context fails rather than forwarding another thread", async (item) => {
    const { handlers, requests } = backgroundFixture()
    handlers.ready({ directory: "/repos/selected", session: { id: "ses_selected" } })
    await expect(handlers.action(item)).rejects.toThrow()
    expect(requests).toHaveLength(0)
  })
})
