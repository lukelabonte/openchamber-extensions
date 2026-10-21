// This module is imported only by the subprocess branch of panel-port.test.ts.
// SDK mocks, browser globals and the fake clock never escape that process.
import { mock } from "bun:test"
import { join } from "node:path"
import { collectText, FakeElement, findByAriaLabel, findByText, findFirst, installFakeEnvironment } from "./panel-harness"

const registrationA = {
  slug: "proj-a", projectDirectory: "/repos/a", homeDirectory: "/home/a",
  coordinatorSessionId: "ses-a", createdAt: "2026-01-01T00:00:00.000Z",
}
const registrationB = { ...registrationA, slug: "proj-b", projectDirectory: "/repos/b", homeDirectory: "/home/b", coordinatorSessionId: "ses-b" }
const defaultSettings = { coordinatorModel: "", coordinatorVariant: "", workerModel: "", workerVariant: "", refreshSeconds: 30 }
const decision = {
  title: "Needs your call", state: "Blocked", taskId: "decision-1", kind: "captain",
  hold: "captain approval", blockedBy: "work-1", reviewHead: "a".repeat(40),
  actions: [{ label: "Proceed", text: "Approve the smaller change" }],
}

export async function runPortScenario(name: string): Promise<Record<string, unknown>> {
  const fake = installFakeEnvironment()
  let innerHtmlWrites = 0
  Object.defineProperty(FakeElement.prototype, "innerHTML", { set: () => { innerHtmlWrites += 1 }, configurable: true })
  let ready: (context: { directory: string; session?: { id: string } | null }) => void = () => {}
  let directoryChanged: (directory: string) => void = () => {}
  let sessionChanged: (session: { id: string } | null) => void = () => {}
  let sessionsChanged: (snapshot: any) => void = () => {}
  const calls: Array<{ method: string; path: string; query?: Record<string, string>; body?: string }> = []
  const held = new Map<string, Array<(result: { status: number; body: string }) => void>>()
  const rejected = new Map<string, Array<(error: Error) => void>>()
  let commandFailure: string | undefined
  const holds = new Set<string>()
  const failures = new Set<string>()
  const opened: string[] = []
  const copied: string[] = []
  const shellScopes: Array<{ kind: string; sessionId: string }> = []
  const shellReads: Array<{ id: string; options: unknown }> = []
  let shellUnsubscribes = 0
  let shellSnapshot: (snapshot: unknown) => void = () => {}
  let settings = { ...defaultSettings }
  let registration: typeof registrationA | null = registrationA
  const suggestionText = `<img src=x onerror=alert(1)> ${"full suggestion words ".repeat(30)}`
  const workers = [
    decision,
    { title: "Worker A", state: name.startsWith("worker-report") ? "Idle" : "Working", sessionId: "ses-worker-a", worktree: "/trees/a", hold: "captain approval", ...(name.startsWith("worker-report") ? { lastWord: "A long preamble", workerReport: { state: "done", text: name === "worker-report-empty" ? "" : "<script>worker testimony</script>" }, reportPrUrl: "https://github.com/example/repo/pull/42" } : {}), ...(name.startsWith("message-") && name !== "message-legacy" ? { lastWord: "The verified report", lastMessageId: "msg_report" } : {}) },
    { title: "Worker B", state: "Working", sessionId: "ses-worker-b", worktree: "/trees/b" },
  ]
  const auxiliaryPaths = ["/settings", "/upgrades", "/watchnotes"]
  const host = {
    onReady: (callback: typeof ready) => { ready = callback; return () => {} },
    onDirectory: (callback: typeof directoryChanged) => { directoryChanged = callback; return () => {} },
    onSession: (callback: typeof sessionChanged) => { sessionChanged = callback; return () => {} },
    listProjects: async () => ({ projects: [{ id: "p-a", directory: "/repos/a" }, { id: "p-b", directory: "/repos/b" }] }),
    onSessions: async (_projectId: string, callback: typeof sessionsChanged) => { sessionsChanged = callback; return () => {} },
    openSession: async (sessionId: string) => {
      if (name === "worker-list-error") throw new Error("navigation failed")
      opened.push(sessionId)
    },
    openUrl: async () => {},
    writeClipboard: async (contents: string) => { copied.push(contents) },
    onRunningShells: name.startsWith("shell-") ? async (scope: { kind: string; sessionId: string }, listener: (snapshot: unknown) => void) => {
      shellScopes.push(scope)
      shellSnapshot = listener
      listener({ kind: "shells", scope, shells: [
        { id: "shell-own", sessionID: scope.sessionId, command: "bun test <literal>", startedAt: 1, background: false },
        { id: "shell-foreign", sessionID: "unrelated-session", command: "private unrelated command", startedAt: 1, background: false },
      ], ended: [] })
      return () => { shellUnsubscribes += 1 }
    } : undefined,
    readShellOutput: name.startsWith("shell-") ? async (id: string, options: unknown) => {
      shellReads.push({ id, options })
      return { output: "<script>literal output</script>", cursor: 100, skipped: true }
    } : undefined,
    serviceRequest: async (request: typeof calls[number]): Promise<{ status: number; body: string }> => {
      calls.push(request)
      const key = `${request.path}:${request.query?.slug ?? ""}`
      if (commandFailure === "reject" && request.path === "/command") throw new Error("bridge failed")
      if (holds.has(key)) return new Promise((resolve, reject) => {
        held.set(key, [...(held.get(key) ?? []), resolve])
        rejected.set(key, [...(rejected.get(key) ?? []), reject])
      })
      if (failures.has(request.path)) return { status: 500, body: "" }
      const answer = (body: unknown) => ({ status: 200, body: JSON.stringify(body) })
      if (request.method === "POST") {
        const body = JSON.parse(request.body ?? "{}")
        if (request.path === "/command") {
          if (commandFailure === "http") return { status: 409, body: JSON.stringify({ error: "coordinator unavailable" }) }
          if (commandFailure === "malformed") return { status: 200, body: "not JSON" }
          if (commandFailure === "unsent") return answer({ sent: false })
          return answer({ sent: true })
        }
        if (request.path === "/launch") { registration = registrationA; return answer(registration) }
        if (request.path === "/settings") { settings = body.settings; return answer({ settings }) }
        if (request.path === "/coordinator/restart") {
          registration = { ...registrationA, coordinatorSessionId: "ses-fresh" }
          return answer({ registration })
        }
        if (request.path === "/coordinator/adopt") {
          registration = { ...registrationA, coordinatorSessionId: body.sessionId }
          return answer({ registration })
        }
        if (request.path === "/coordinator/release") { registration = null; return answer({ released: true }) }
        return answer({})
      }
      if (request.path === "/lookup") return answer({ registration: request.query?.directory === "/repos/b" ? registrationB : registration })
      if (request.path === "/board") return answer({ workers })
      if (request.path === "/watches") return answer({ watches: [] })
      if (request.path === "/shipping") return answer({ mode: null, yolo: false })
      if (request.path === "/suggestions") return answer({ suggestions: [{ label: "Long suggestion", text: suggestionText }] })
      if (name === "absent-extras" && auxiliaryPaths.includes(request.path)) return { status: 404, body: "" }
      if (request.path === "/settings") return answer({ settings: request.query?.slug === "proj-b" ? defaultSettings : settings })
      if (request.path === "/upgrades") return answer({ upgrades: [{ name: "charter", edited: true, outdated: true }] })
      if (request.path === "/upgrades/compare") return answer({ contents: "<script>personal words</script>\nupstream comparison" })
      if (request.path === "/watchnotes") return answer({
        notes: Array.from({ length: 60 }, (_, index) => ({
          id: `note-${index}`, createdAt: "2026-01-01T00:00:00.000Z",
          notification: { message: `<b>note ${index}</b>`, watchName: "nightly" },
        })), pendingCount: 3, dropped: 2,
      })
      return { status: 404, body: "" }
    },
  }
  const serviceRequest = host.serviceRequest
  host.serviceRequest = (request) => {
    if (commandFailure === "throw" && request.path === "/command") {
      calls.push(request)
      throw new Error("bridge failed")
    }
    return serviceRequest(request)
  }
  mock.module("@openchamber/sdk", () => ({ connectHost: () => host }))
  mock.module("@openchamber/sdk/ui", () => ({ applyHostReady: () => {}, mountBadge: (element: FakeElement, options: { label: string }) => { element.textContent = options.label } }))
  await import(join(import.meta.dir, "..", "..", "panel", "main.ts"))

  const flush = () => fake.flushMicrotasks()
  const button = (label: string) => {
    const element = findByText(fake.root, "button", label)
    if (element === null) throw new Error(`missing button: ${label}; ${collectText(fake.root)}`)
    return element
  }
  const field = (label: string) => {
    const element = findByAriaLabel(fake.root, label)
    if (element === null) throw new Error(`missing field: ${label}`)
    return element
  }
  const type = (label: string, value: string) => { const input = field(label); input.value = value; input.emitInput() }
  const workerCard = (title = "Worker A") => {
    const card = findFirst(fake.root, (element) => element.tagName === "article" && findByText(element, "strong", title) !== null)
    if (card === null) throw new Error(`missing worker card: ${title}`)
    return card
  }
  const workerInput = (action: "steer" | "relaunch", title = "Worker A") => {
    const placeholder = action === "steer" ? "Steer the worker…" : "Note for the relaunch…"
    const input = findFirst(workerCard(title), (element) => element.tagName === "input" && element.placeholder === placeholder)
    if (input === null) throw new Error(`missing ${action} input for ${title}`)
    return input
  }
  const typeWorker = (action: "steer" | "relaunch", value: string, title = "Worker A") => {
    const input = workerInput(action, title)
    input.value = value
    input.emitInput()
  }
  const workerDraftValues = () => ({ steer: workerInput("steer").value, relaunch: workerInput("relaunch").value })
  const workerButton = (label: string, title = "Worker A") => {
    const element = findByText(workerCard(title), "button", label)
    if (element === null) throw new Error(`missing ${label} button for ${title}`)
    return element
  }
  const posts = () => calls.filter((call) => call.method === "POST").map((call) => ({ path: call.path, body: JSON.parse(call.body ?? "{}") }))
  const boardCalls = () => calls.filter((call) => call.path === "/board").length
  const refresh = async () => { fake.querySelector("button.fm-refresh")!.click(); await flush() }
  const all = (predicate: (element: FakeElement) => boolean): FakeElement[] => {
    const found: FakeElement[] = []
    const visit = (element: FakeElement) => { if (predicate(element)) found.push(element); element.children.forEach(visit) }
    visit(fake.root)
    return found
  }
  const release = (key: string, body: unknown, status = 200) => {
    holds.delete(key)
    for (const resolve of held.get(key) ?? []) resolve({ status, body: JSON.stringify(body) })
    held.delete(key)
  }
  if (name === "stale-settings") holds.add("/settings:proj-a")
  if (name === "stale-lookup") holds.add("/lookup:")
  if (name === "board-initial-superseded") holds.add("/board:proj-a")
  if (name === "worker-list-refresh") holds.add("/board:proj-a")
  if (name === "worker-list") workers.push(
    { title: "Duplicate A", state: "Working", sessionId: "ses-worker-a", worktree: "/trees/a" },
    { title: "Previously done", state: "Done", sessionId: "ses-Idle", worktree: "/trees/Idle" },
    ...["Queued", "Idle", "Parked", "Done", "Failed"].map((state) => ({ title: `${state} worker`, state, sessionId: `ses-${state}`, worktree: `/trees/${state}` })),
    { title: "Not dispatched", state: "Queued", sessionId: "", worktree: "" },
  )
  if (name === "worker-list") {
    workers[1]!.title = "<script>Worker A</script>"
    workers[2]!.state = "Blocked"
  }
  ready({ directory: name === "worker" ? "/trees/a" : name === "home-release" ? "/home/a" : "/repos/a", session: name === "worker" ? { id: "ses-worker-a" } : null })
  await flush()
  let extra: Record<string, unknown> = {}

  switch (name) {
    case "worker-list": {
      const picker = () => findFirst(fake.root, (element) => element.className === "fm-worker-picker")!
      const toggle = () => findFirst(picker(), (element) => element.tagName === "button")!
      const rows = () => all((element) => element.tagName === "button" && element.className.split(" ").includes("fm-worker-link"))
      const count = toggle().textContent
      const initialExpanded = toggle().attributes.get("aria-expanded")
      toggle().click()
      const expanded = toggle().attributes.get("aria-expanded")
      const rowCount = rows().length
      const listText = collectText(picker())
      rows().find((row) => collectText(row).includes("<script>Worker A</script>"))!.click()
      await flush()
      sessionChanged({ id: "ses-worker-a" })
      const current = rows().find((row) => collectText(row).includes("<script>Worker A</script>"))!.attributes.get("aria-current")
      const workerExpanded = toggle().attributes.get("aria-expanded")
      rows().find((row) => collectText(row).includes("Worker B"))!.click()
      await flush()
      toggle().click()
      extra = { count, initialExpanded, expanded, rowCount, listText, current, workerExpanded, collapsed: toggle().attributes.get("aria-expanded"), opened }
      break
    }
    case "worker-list-refresh": {
      const picker = () => findFirst(fake.root, (element) => element.className === "fm-worker-picker")!
      const toggle = () => findFirst(picker(), (element) => element.tagName === "button")!
      const rows = () => all((element) => element.tagName === "button" && element.className.split(" ").includes("fm-worker-link"))
      const loading = toggle().textContent
      const loadingDisabled = toggle().disabled
      release("/board:proj-a", {}, 500)
      await flush()
      const unavailable = toggle().textContent
      await refresh()
      toggle().click()
      failures.add("/board")
      await refresh()
      const stale = toggle().textContent
      const staleRows = rows().length
      failures.delete("/board")
      workers.splice(1, 1)
      sessionsChanged({ state: "ready", sessions: [] })
      fake.advanceClock(1_000)
      await flush()
      const updated = toggle().textContent
      const updatedRows = rows().length
      const updatedExpanded = toggle().attributes.get("aria-expanded")
      directoryChanged("/repos/b")
      await flush()
      const newProjectExpanded = toggle().attributes.get("aria-expanded")
      workers.splice(0, workers.length)
      await refresh()
      toggle().click()
      extra = { loading, loadingDisabled, unavailable, stale, staleRows, updated, updatedRows, updatedExpanded, newProjectExpanded, empty: toggle().textContent, emptyText: collectText(picker()) }
      break
    }
    case "worker-list-error": {
      const toggle = () => findFirst(fake.root, (element) => element.className === "fm-worker-picker")!.children[0]!
      toggle().click()
      all((element) => element.tagName === "button" && element.className.split(" ").includes("fm-worker-link"))[0]!.click()
      await flush()
      const failureText = collectText(fake.root)
      await refresh()
      const afterRefreshText = collectText(fake.root)
      directoryChanged("/repos/b")
      await flush()
      extra = { failureText, afterRefreshText, newProjectText: collectText(fake.root) }
      break
    }
    case "shell-view":
    case "shell-removal": {
      const settingsInput = field("Coordinator model")
      workerButton("Show commands").click()
      await flush()
      workerButton("Read output").click()
      await flush()
      const workerText = collectText(workerCard())
      const settingsInputPreserved = settingsInput === field("Coordinator model")
      if (name === "shell-removal") {
        workers.splice(workers.findIndex((worker) => worker.title === "Worker A"), 1)
        await refresh()
      } else {
        directoryChanged("/repos/b")
        await flush()
      }
      shellSnapshot({ kind: "shells", scope: { kind: "session", sessionId: "ses-worker-a" }, shells: [{ id: "stale", sessionID: "ses-worker-a", command: "stale private command", startedAt: 1, background: false }], ended: [] })
      await flush()
      extra = { workerText, shellScopes, shellReads, shellUnsubscribes, settingsInputPreserved }
      break
    }
    case "worker-report":
    case "worker-report-empty":
      extra = { workerText: collectText(workerCard()), hasReportedPr: findByText(workerCard(), "button", "Open worker-reported PR") !== null }
      break
    case "board-initial-superseded": {
      holds.delete("/board:proj-a")
      workers.splice(0, workers.length, { title: "Newest worker", state: "Working", sessionId: "ses-newest", worktree: "/trees/newest" })
      sessionsChanged({ state: "ready", sessions: [] })
      fake.advanceClock(1_000)
      await flush()
      release("/board:proj-a", { workers: [{ title: "Old worker", state: "Working" }] })
      await flush()
      const supersededText = collectText(fake.root)
      const supersededRefresh = fake.querySelector("button.fm-refresh")?.textContent
      await refresh()
      extra = { supersededText, supersededRefresh }
      break
    }
    case "board-delayed-verdict": {
      fake.advanceClock(60_000)
      await flush()
      holds.add("/watches:proj-a")
      fake.querySelector("button.fm-refresh")!.click()
      await flush()
      failures.add("/board")
      sessionsChanged({ state: "ready", sessions: [] })
      fake.advanceClock(1_000)
      await flush()
      release("/watches:proj-a", { watches: [] })
      await flush()
      break
    }
    case "board-last-good": {
      failures.add("/board")
      await refresh()
      const staleText = collectText(fake.root)
      const staleRefresh = fake.querySelector("button.fm-refresh")?.textContent
      const interruptDisabled = workerButton("Interrupt").disabled
      sessionChanged({ id: "ses-worker-a" })
      const workerText = collectText(fake.root)
      sessionChanged(null)
      failures.delete("/board")
      await refresh()
      extra = { staleText, staleRefresh, interruptDisabled, workerText }
      break
    }
    case "board-old-success":
    case "board-old-failure":
    case "board-old-reject":
    case "board-old-malformed":
    case "board-new-failure": {
      fake.advanceClock(60_000)
      await flush()
      const labelBeforeOld = fake.querySelector("button.fm-refresh")?.textContent
      holds.add("/board:proj-a")
      fake.querySelector("button.fm-refresh")!.click()
      await flush()
      holds.delete("/board:proj-a")
      if (name === "board-new-failure") failures.add("/board")
      workers.splice(0, workers.length, { title: "Newest worker", state: "Working", sessionId: "ses-newest", worktree: "/trees/newest" })
      sessionsChanged({ state: "ready", sessions: [] })
      fake.advanceClock(1_000)
      await flush()
      if (name === "board-old-reject") rejected.get("/board:proj-a")!.shift()!(new Error("old rejection"))
      else held.get("/board:proj-a")!.shift()!({
        status: name === "board-old-failure" ? 500 : 200,
        body: name === "board-old-malformed" ? "not JSON" : JSON.stringify({ workers: [{ title: "Old worker", state: "Working" }] }),
      })
      await flush()
      extra = { labelBeforeOld }
      break
    }
    case "command-pending-bearings":
    case "command-pending-bearings-file":
    case "command-pending-ahoy": {
      type("Answer for decision-1", "Keep the decision draft")
      if (name.endsWith("bearings-file")) field("Write the bearings report to a dated file").checked = true
      holds.add("/command:")
      const commandButton = button(name.endsWith("ahoy") ? "Catch me up" : "Status report")
      commandButton.click()
      commandButton.click()
      button("Catch me up").click()
      field("Send Long suggestion").click()
      button("Proceed").click()
      await refresh()
      const pendingDisabled = [button("Status report").disabled, button("Catch me up").disabled, field("Send Long suggestion").disabled, button("Proceed").disabled]
      const decisionDraft = field("Answer for decision-1").value
      sessionChanged({ id: "ses-worker-a" })
      type("Note for first mate", "Keep the note draft")
      const noteDisabled = button("Send note to first mate").disabled
      button("Send note to first mate").click()
      const noteDraft = field("Note for first mate").value
      sessionChanged(null)
      const whilePendingPosts = posts()
      release("/command:", { sent: true })
      await flush()
      const retryEnabled = !button("Status report").disabled
      button("Status report").click()
      await flush()
      extra = { whilePendingPosts, pendingDisabled, decisionDraft, noteDisabled, noteDraft, retryEnabled }
      break
    }
    case "command-failure-http":
    case "command-failure-malformed":
    case "command-failure-unsent":
    case "command-failure-throw":
    case "command-failure-reject": {
      commandFailure = name.slice("command-failure-".length)
      button("Status report").click()
      await flush()
      await refresh()
      const failureText = collectText(fake.root)
      const retryEnabled = !button("Status report").disabled
      commandFailure = undefined
      button("Status report").click()
      await flush()
      extra = { failureText, retryEnabled }
      break
    }
    case "captain-gate-suggestion":
    case "captain-gate-decision":
    case "captain-gate-note": {
      const source = name.slice("captain-gate-".length)
      const path = source === "suggestion" ? "/suggestion/send:" : source === "decision" ? "/decision:" : "/handoff:"
      holds.add(path)
      if (source === "suggestion") field("Send Long suggestion").click()
      else if (source === "decision") { type("Answer for decision-1", "Keep answer"); button("Answer").click() }
      else {
        sessionChanged({ id: "ses-worker-a" })
        type("Note for first mate", "Keep note")
        button("Send note to first mate").click()
        sessionChanged(null)
      }
      const reportDisabled = button("Status report").disabled
      button("Status report").click()
      field("Send Long suggestion").click()
      button("Proceed").click()
      await flush()
      const pendingPosts = posts()
      release(path, { sent: true })
      await flush()
      button("Status report").click()
      await flush()
      extra = { pendingPosts, reportDisabled }
      break
    }
    case "suggestion-stale-gate": {
      holds.add("/suggestion/send:")
      field("Send Long suggestion").click()
      await flush()
      directoryChanged("/repos/b")
      await flush()
      field("Send Long suggestion").click()
      await flush()
      const readsBeforeOld = calls.filter((call) => call.path === "/suggestions").length
      held.get("/suggestion/send:")!.shift()!({ status: 409, body: JSON.stringify({ error: "old suggestion error" }) })
      await flush()
      const readsAfterOld = calls.filter((call) => call.path === "/suggestions").length
      const afterOldDisabled = field("Send Long suggestion").disabled
      field("Send Long suggestion").click()
      button("Status report").click()
      const pendingPosts = posts()
      release("/suggestion/send:", { sent: true })
      await flush()
      const retryEnabled = !button("Status report").disabled
      extra = { pendingPosts, afterOldDisabled, readsBeforeOld, readsAfterOld, retryEnabled }
      break
    }
    case "command-stale": {
      holds.add("/command:")
      button("Status report").click()
      await flush()
      directoryChanged("/repos/b")
      await flush()
      button("Catch me up").click()
      await flush()
      held.get("/command:")!.shift()!({ status: 409, body: JSON.stringify({ error: "old command error" }) })
      await flush()
      const afterStaleText = collectText(fake.root)
      const afterStaleDisabled = button("Status report").disabled
      button("Status report").click()
      release("/command:", { sent: true })
      await flush()
      extra = { afterStaleText, afterStaleDisabled, retryEnabled: !button("Status report").disabled }
      break
    }
    case "message-link": {
      workerButton("Copy message link").click()
      await flush()
      extra = { copied, opened }
      break
    }
    case "message-legacy":
      extra = { hasMessageLink: findByText(workerCard(), "button", "Copy message link") !== null }
      break
    case "variant-labels": {
      const workerDefault = field("Worker variant").placeholder
      const coordinatorDefault = field("Coordinator variant").placeholder
      button("Save settings").click()
      await flush()
      type("Worker variant", "provider:adaptive/extended")
      type("Coordinator variant", "thinking/extended:custom")
      button("Save settings").click()
      await flush()
      extra = { workerDefault, coordinatorDefault }
      break
    }
    case "parent-refresh": {
      const baseline = boardCalls()
      for (const state of ["loading", "error"]) {
        sessionsChanged({ state, sessions: [] })
        fake.advanceClock(1000)
        await flush()
      }
      const afterIncomplete = boardCalls()
      const counts: number[] = []
      for (const [parentId, directory] of [["ses-a", "/trees/a"], ["ses-other", "/trees/a"], ["ses-other", "/trees/moved"]]) {
        sessionsChanged({ state: "ready", projectId: "p-a", coverage: [{ directory, state: "ready" }], sessions: [{ id: "ses-worker-a", parentId, directory, activity: "running" }] })
        fake.advanceClock(1000)
        await flush()
        counts.push(boardCalls())
      }
      sessionsChanged({ state: "ready", sessions: [] })
      fake.advanceClock(1000)
      await flush()
      extra = { baseline, afterIncomplete, counts, afterRemoval: boardCalls() }
      break
    }
    case "worker-steer-failure":
    case "worker-relaunch-failure": {
      const action = name.includes("-steer-") ? "steer" : "relaunch"
      const label = action === "steer" ? "Steer" : "Relaunch"
      typeWorker(action, "Keep this failed message")
      holds.add(`/${action}:`)
      workerButton(label).click()
      await flush()
      release(`/${action}:`, { error: "The worker could not accept this request." }, 409)
      await flush()
      await refresh()
      const draftAfterFailure = workerInput(action).value
      const feedbackAfterFailure = collectText(workerCard())
      const retryEnabled = !workerButton(label).disabled
      holds.add(`/${action}:`)
      workerButton(label).click()
      await flush()
      release(`/${action}:`, { warning: "Sent, but coordinator delivery failed." })
      await flush()
      await refresh()
      extra = { draftAfterFailure, feedbackAfterFailure, retryEnabled, draftAfterRetry: workerInput(action).value, feedbackAfterRetry: collectText(workerCard()) }
      break
    }
    case "worker-steer-stale":
    case "worker-relaunch-stale": {
      const action = name.includes("-steer-") ? "steer" : "relaunch"
      const label = action === "steer" ? "Steer" : "Relaunch"
      typeWorker(action, "Old project draft")
      holds.add(`/${action}:`)
      workerButton(label).click()
      await flush()
      directoryChanged("/repos/b")
      await flush()
      const draftAfterSwitch = workerInput(action).value
      const inputDisabledAfterSwitch = workerInput(action).disabled
      const boardCallsBeforeStale = boardCalls()
      release(`/${action}:`, { error: "old worker action failed" }, 409)
      await flush()
      const boardCallsAfterStale = boardCalls()
      const feedbackAfterStale = collectText(workerCard())
      typeWorker(action, "New project message")
      workerButton(label).click()
      await flush()
      extra = { draftAfterSwitch, inputDisabledAfterSwitch, boardCallsBeforeStale, boardCallsAfterStale, feedbackAfterStale }
      break
    }
    case "worker-end-confirmation": {
      workerButton("End").click()
      await refresh()
      const confirmation = findByText(workerCard(), "button", "Really end?")
      const requestsBeforeConfirmation = posts().length
      confirmation?.click()
      await flush()
      // Re-arm before switching to prove the confirmation itself is discarded.
      workerButton("End").click()
      directoryChanged("/repos/b")
      await flush()
      extra = { confirmationAfterRefresh: confirmation !== null, requestsBeforeConfirmation, confirmationAfterProjectSwitch: findByText(workerCard(), "button", "Really end?") !== null }
      break
    }
    case "worker-steer-pending":
    case "worker-relaunch-pending":
    case "worker-interrupt-pending":
    case "worker-end-pending": {
      const action = name.split("-")[1]!
      const label = action[0]!.toUpperCase() + action.slice(1)
      const textAction = action === "steer" || action === "relaunch" ? action : null
      if (textAction !== null) typeWorker(textAction, "Keep this message")
      holds.add(`/${action}:`)
      workerButton(label).click()
      if (action === "end") workerButton("Really end?").click()
      await flush()
      await refresh()
      const pendingDisabled = workerButton(label).disabled
      const draftWhilePending = textAction === null ? null : workerInput(textAction).value
      const inputDisabled = textAction === null ? null : workerInput(textAction).disabled
      workerButton(label).click()
      if (action === "end") findByText(workerCard(), "button", "Really end?")?.click()
      await flush()
      const requestsBeforeRelease = posts().filter((request) => request.path === `/${action}`).length
      release(`/${action}:`, {})
      await flush()
      const draftAfterSuccess = textAction === null ? null : workerInput(textAction).value
      await refresh()
      const successMessages: Record<string, string> = { steer: "Steered.", relaunch: "Relaunch requested.", interrupt: "Interrupt sent.", end: "Archived." }
      extra = { pendingDisabled, draftWhilePending, inputDisabled, requestsBeforeRelease, draftAfterSuccess, feedbackAfterRefresh: collectText(workerCard()), successMessage: successMessages[action] }
      break
    }
    case "worker-action-drafts": {
      typeWorker("steer", "Keep this steer")
      typeWorker("relaunch", "Keep this relaunch")
      for (const path of ["/board", "/watches", "/shipping", "/suggestions", ...auxiliaryPaths]) holds.add(`${path}:proj-a`)
      fake.advanceClock(30_000)
      await flush()
      release("/board:proj-a", { workers })
      await flush()
      const afterBoard = workerDraftValues()
      release("/settings:proj-a", { settings })
      await flush()
      const afterAuxiliary = workerDraftValues()
      directoryChanged("/repos/b")
      await flush()
      extra = { afterBoard, afterAuxiliary, afterProjectSwitch: workerDraftValues() }
      break
    }
    case "decision":
      button("Proceed").click()
      await flush()
      type("Answer for decision-1", "Use the smaller change")
      button("Answer").click()
      await flush()
      break
    case "stale-decision": {
      type("Answer for decision-1", "keep this answer")
      await refresh()
      const draftBeforeSwitch = field("Answer for decision-1").value
      holds.add("/decision:")
      button("Proceed").click()
      await refresh()
      button("Proceed").click()
      directoryChanged("/repos/b")
      await flush()
      release("/decision:", { error: "old project error" }, 409)
      await flush()
      extra = { draftBeforeSwitch, answerAfterSwitch: field("Answer for decision-1").value }
      break
    }
    case "rejected-decision":
      type("Answer for decision-1", "keep this answer")
      holds.add("/decision:")
      button("Proceed").click()
      await flush()
      release("/decision:", { error: "action changed; refresh before choosing" }, 409)
      await flush()
      extra = { answer: field("Answer for decision-1").value }
      break
    case "suggestion": {
      const details = findFirst(fake.root, (element) => element.tagName === "details" && element.className === "fm-suggestion-details")
      if (details === null) throw new Error("missing expandable suggestion")
      ;(details as FakeElement & { open: boolean }).open = true
      for (const toggle of details.listeners.get("toggle") ?? []) toggle()
      const fullText = findFirst(details, (element) => element.tagName === "pre")?.textContent
      button("Copy suggestion").click()
      await flush()
      await refresh()
      extra = { fullText, suggestionText, copied, openAfterRefresh: (findFirst(fake.root, (element) => element.className === "fm-suggestion-details") as FakeElement & { open?: boolean })?.open }
      break
    }
    case "columns": {
      const heading = all((element) => element.className === "fm-collapsible-heading").find((element) => collectText(element).endsWith("Working"))!
      heading.click()
      field("Move Blocked up").click()
      await refresh()
      const storage = (globalThis.window.localStorage).getItem("firstmate-column-order")
      extra = {
        persisted: JSON.parse(storage!),
        columns: all((element) => element.attributes.has("data-column")).map((element) => element.attributes.get("data-column")),
        folded: all((element) => element.className === "fm-collapsible-heading").find((element) => collectText(element).endsWith("Working"))?.attributes.get("aria-expanded") === "false",
      }
      break
    }
    case "settings": {
      type("Coordinator model", "openai/gpt-example")
      type("Coordinator variant", "high")
      type("Worker model", "anthropic/claude-example")
      type("Worker variant", "fast")
      type("Refresh seconds", "5")
      await refresh()
      const draftAfterRefresh = field("Coordinator model").value
      button("Save settings").click()
      await flush()
      const baseline = boardCalls()
      fake.advanceClock(4_999)
      await flush()
      const beforeTick = boardCalls()
      fake.advanceClock(1)
      await flush()
      extra = { baseline, beforeTick, afterTick: boardCalls(), draftAfterRefresh, saved: posts().find((post) => post.path === "/settings")?.body }
      break
    }
    case "invalid-settings":
      for (const value of ["4", "5.5", "3601", "nope"]) {
        type("Refresh seconds", value)
        button("Save settings").click()
        await flush()
      }
      break
    case "stale-settings": {
      directoryChanged("/repos/b")
      await flush()
      directoryChanged("/repos/a")
      await flush()
      held.get("/settings:proj-a")?.shift()?.({ status: 200, body: JSON.stringify({ settings: { ...defaultSettings, coordinatorModel: "old-model", refreshSeconds: 5 } }) })
      release("/settings:proj-a", { settings: defaultSettings })
      await flush()
      const baseline = boardCalls()
      fake.advanceClock(5_000)
      await flush()
      extra = { baseline, boardCalls: boardCalls(), interval: field("Refresh seconds").value }
      break
    }
    case "project-timer": {
      type("Refresh seconds", "5")
      button("Save settings").click()
      await flush()
      directoryChanged("/repos/b")
      await flush()
      const baseline = boardCalls()
      fake.advanceClock(29_999)
      await flush()
      const beforeTick = boardCalls()
      fake.advanceClock(1)
      await flush()
      extra = { baseline, beforeTick, afterTick: boardCalls(), interval: field("Refresh seconds").value }
      break
    }
    case "stale-lookup": {
      directoryChanged("/repos/b")
      await flush()
      directoryChanged("/repos/a")
      await flush()
      held.get("/lookup:")?.shift()?.({ status: 200, body: JSON.stringify({ registration: { ...registrationA, slug: "old-project" } }) })
      held.get("/lookup:")?.shift()?.({ status: 200, body: JSON.stringify({ registration: registrationB }) })
      await flush()
      const beforeCurrentLookup = collectText(fake.root)
      const boardCallsBeforeCurrent = boardCalls()
      release("/lookup:", { registration: registrationA })
      await flush()
      extra = { beforeCurrentLookup, boardCallsBeforeCurrent }
      break
    }
    case "known-extra-error":
      auxiliaryPaths.forEach((path) => failures.add(path))
      await refresh()
      break
    case "upgrades":
      button("Compare charter").click()
      await flush()
      extra = { comparison: findFirst(fake.root, (element) => element.className === "fm-upgrade-comparison")?.textContent }
      button("Acknowledge charter").click()
      await flush()
      break
    case "stale-upgrade":
      holds.add("/upgrades/compare:proj-a")
      button("Compare charter").click()
      await flush()
      directoryChanged("/repos/b")
      await flush()
      release("/upgrades/compare:proj-a", { contents: "old-project comparison" })
      await flush()
      extra = { acknowledgePresent: findByText(fake.root, "button", "Acknowledge charter") !== null }
      break
    case "watchnotes":
      extra = { notes: all((element) => element.className === "fm-watch-note").length }
      break
    case "lifecycle": {
      button("Restart in fresh session").click()
      const restartFirstClickPosts = posts().length
      const confirmation = collectText(fake.root)
      button("Confirm restart in fresh session").click()
      await flush()
      button("Open chat").click()
      await flush()
      button("Release first mate").click()
      const releaseFirstClickPosts = posts().length
      const releaseConfirmation = collectText(fake.root)
      button("Confirm release").click()
      await flush()
      extra = { restartFirstClickPosts, releaseFirstClickPosts, confirmation, releaseConfirmation, restartedSession: opened[0] }
      break
    }
    case "adopt":
      type("Session to adopt", "ses-candidate")
      button("Adopt session").click()
      await flush()
      button("Open chat").click()
      await flush()
      extra = { session: opened[0] }
      break
    case "home-release":
      button("Release first mate").click()
      button("Confirm release").click()
      await flush()
      ready({ directory: "/home/a", session: null })
      await flush()
      button("Launch first mate").click()
      await flush()
      extra = { launch: posts().find((post) => post.path === "/launch")?.body }
      break
    case "worker": {
      // The fleet picker deliberately lists other workers. Task controls below
      // it must still be limited to the current worker's card.
      const taskText = () => fake.root.children.filter((element) => element.className !== "fm-worker-picker").map(collectText).join("")
      const workerText = taskText()
      type("Note for first mate", "A note for the first mate")
      button("Send note to first mate").click()
      await flush()
      button("Open first mate").click()
      await flush()
      sessionChanged({ id: "ses-worker-b" })
      await flush()
      const afterSessionChange = taskText()
      ready({ directory: "/trees/a", session: { id: "unrelated" } })
      await flush()
      extra = { workerText, opened, afterSessionChange, afterUnrelatedSession: collectText(fake.root) }
      break
    }
  }
  return { posts: posts(), text: collectText(fake.root), refresh: fake.querySelector("button.fm-refresh")?.textContent, innerHtmlWrites, ...extra }
}
