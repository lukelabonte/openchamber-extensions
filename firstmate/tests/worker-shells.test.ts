import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { createWorkerShells, type WorkerShell, type WorkerShellsHost, type WorkerShellsSnapshot } from "../panel/worker-shells"
import { collectText, FakeElement, findByText, findFirst } from "./helpers/panel-harness"

function deferred<Value>() {
  let resolve!: (value: Value) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<Value>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise
    reject = rejectPromise
  })
  return { promise, resolve, reject }
}

async function flush() {
  for (let index = 0; index < 30; index += 1) await Promise.resolve()
}

function shell(id: string, sessionID = "worker-a", command = `command ${id}`): WorkerShell {
  return { id, sessionID, command, startedAt: 1, background: false }
}

function fixture() {
  const registrations: Array<{
    scope: { kind: "session"; sessionId: string }
    listener: (snapshot: WorkerShellsSnapshot) => void
    pending: ReturnType<typeof deferred<() => void>>
    unsubscribed: number
  }> = []
  const reads: Array<{ id: string; options: { tailBytes?: number }; pending: ReturnType<typeof deferred<{ output: string; cursor: number; skipped: boolean }>> }> = []
  const host: WorkerShellsHost = {
    onRunningShells(scope, listener) {
      const registration = { scope, listener, pending: deferred<() => void>(), unsubscribed: 0 }
      registrations.push(registration)
      return registration.pending.promise
    },
    readShellOutput(id, options) {
      const pending = deferred<{ output: string; cursor: number; skipped: boolean }>()
      reads.push({ id, options: options ?? {}, pending })
      return pending.promise
    },
  }
  const viewer = createWorkerShells(host)
  viewer.setContext("project-a")
  function render(sessionId = "worker-a") {
    return viewer.render(sessionId) as unknown as FakeElement
  }
  function click(root: FakeElement, label: string) {
    const button = findByText(root, "button", label)
    expect(button).not.toBeNull()
    button!.click()
  }
  function emit(index = 0, shells = [shell("one")], ended: WorkerShellsSnapshot["ended"] = []) {
    const registration = registrations[index]
    registration.listener({ kind: "shells", scope: registration.scope, shells, ended })
  }
  function register(index = 0) {
    const registration = registrations[index]
    registration.pending.resolve(() => { registration.unsubscribed += 1 })
  }
  async function show(root: FakeElement) {
    click(root, "Show commands")
    await flush()
    register(registrations.length - 1)
    await flush()
  }
  return { viewer, registrations, reads, render, click, emit, register, show }
}

let documentDescriptor: PropertyDescriptor | undefined
beforeEach(() => {
  documentDescriptor = Object.getOwnPropertyDescriptor(globalThis, "document")
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: { createElement: (tag: string) => new FakeElement(tag) },
  })
})
afterEach(() => {
  if (documentDescriptor) Object.defineProperty(globalThis, "document", documentDescriptor)
  else Reflect.deleteProperty(globalThis, "document")
})

describe("worker shell viewer", () => {
  test("removing the selected backlog worker releases its subscription and rejects detached actions", async () => {
    const state = fixture()
    state.viewer.retainWorkers(new Set(["worker-a", "worker-b"]))
    const root = state.render()
    await state.show(root)
    state.emit()
    const read = findByText(root, "button", "Read output")!
    read.click()
    state.viewer.retainWorkers(new Set(["worker-b"]))
    expect(state.registrations[0].unsubscribed).toBe(1)
    state.reads[0].pending.resolve({ output: "removed private output", cursor: 1, skipped: false })
    read.click()
    await flush()
    expect(collectText(root)).not.toContain("command one")
    expect(collectText(state.render())).not.toContain("removed private output")
    expect(findByText(state.render(), "button", "Show commands")).toBeNull()
    expect(state.reads).toHaveLength(1)
  })

  test("does nothing until Show commands and subscribes to the exact worker only", async () => {
    const state = fixture()
    const root = state.render()
    expect(state.registrations).toHaveLength(0)
    expect(state.reads).toHaveLength(0)
    await state.show(root)
    expect(state.registrations.map(({ scope }) => scope)).toEqual([{ kind: "session", sessionId: "worker-a" }])
    state.emit(0, [shell("own"), shell("child", "native-child"), shell("other", "worker-b")], [
      { ...shell("ended-child", "native-child"), status: "exited", exit: 0, endedAt: 2 },
    ])
    expect(collectText(root)).toContain("command own")
    expect(collectText(root)).not.toContain("command child")
    expect(collectText(root)).not.toContain("command other")
    expect(collectText(root)).not.toContain("command ended-child")
    expect(state.reads).toHaveLength(0)
  })

  test("ignores snapshots with the wrong scope, without declaring empty success", async () => {
    const state = fixture()
    const root = state.render()
    await state.show(root)
    state.registrations[0].listener({ kind: "shells", scope: { kind: "session", sessionId: "worker-b" }, shells: [], ended: [] })
    expect(collectText(root)).toContain("Waiting")
    expect(collectText(root)).not.toContain("No running")
    state.emit(0, [], [])
    expect(collectText(root)).toContain("No running or recently ended commands")
  })

  test("keeps only the newest ten running and ten ended commands after exact membership filtering", async () => {
    const state = fixture()
    const root = state.render()
    await state.show(root)
    const shells = Array.from({ length: 13 }, (_, index) => shell(`running-${index}`))
    const ended = Array.from({ length: 13 }, (_, index) => ({ ...shell(`ended-${index}`), status: "unknown" as const, endedAt: index }))
    state.emit(0, [...shells, shell("foreign", "native-child")], ended)
    expect(collectText(root)).not.toContain("command running-2")
    expect(collectText(root)).toContain("command running-3")
    expect(collectText(root)).toContain("command running-12")
    expect(collectText(root)).not.toContain("command ended-2")
    expect(collectText(root)).toContain("command ended-3")
    expect(collectText(root)).toContain("command ended-12")
  })

  test("shows foreground/background, running, and every ended status without inventing success", async () => {
    const state = fixture()
    const root = state.render()
    await state.show(root)
    state.emit(0, [shell("foreground"), { ...shell("background"), background: true }], [
      { ...shell("exit-zero"), status: "exited", exit: 0, endedAt: 2 },
      { ...shell("exit-one"), status: "exited", exit: 1, endedAt: 2 },
      { ...shell("exit-missing"), status: "exited", endedAt: 2 },
      ...(["timeout", "killed", "stopped", "unknown"] as const).map((status) => ({ ...shell(status), status, endedAt: 2 })),
    ])
    for (const text of ["Foreground", "Background", "Running", "Exited (code 0)", "Exited (code 1)", "Exited (code unknown)", "Timeout", "Killed", "Stopped", "Unknown end status"]) {
      expect(collectText(root)).toContain(text)
    }
    expect(collectText(root).toLowerCase()).not.toContain("succeeded")
  })

  test("reads only by click, requests a 16 KiB tail without cursor, and reports skipped earlier output", async () => {
    const state = fixture()
    const root = state.render()
    await state.show(root)
    state.emit()
    state.click(root, "Read output")
    expect(state.reads).toHaveLength(1)
    expect(state.reads[0].id).toBe("one")
    expect(state.reads[0].options).toEqual({ tailBytes: 16384 })
    state.reads[0].pending.resolve({ output: "tail text", cursor: 100, skipped: true })
    await flush()
    expect(collectText(root)).toContain("Earlier output skipped")
    expect(collectText(root)).toContain("16 KiB")
    expect(findByText(root, "pre", "tail text")).not.toBeNull()
    expect(state.reads).toHaveLength(1)
  })

  test("renders commands, output, and errors literally rather than interpreting HTML", async () => {
    const state = fixture()
    const root = state.render()
    await state.show(root)
    const payload = '<img src=x onerror="alert(1)"><script>bad()</script>'
    state.emit(0, [shell("one", "worker-a", payload)])
    expect(findByText(root, "code", payload)).not.toBeNull()
    state.click(root, "Read output")
    state.reads[0].pending.resolve({ output: payload, cursor: 1, skipped: false })
    await flush()
    expect(findByText(root, "pre", payload)).not.toBeNull()
    expect(findFirst(root, (node) => node.tagName === "img" || node.tagName === "script")).toBeNull()
  })

  test("keeps subscription and read pending guards through card rerenders and detached clicks", async () => {
    const state = fixture()
    const root = state.render()
    const originalShow = findByText(root, "button", "Show commands")!
    originalShow.click()
    originalShow.click()
    state.render()
    await flush()
    expect(state.registrations).toHaveLength(1)
    state.register()
    await flush()
    state.emit()
    const current = state.render()
    const originalRead = findByText(current, "button", "Read output")!
    originalRead.click()
    originalRead.click()
    const pendingCard = state.render()
    expect(findByText(pendingCard, "button", "Reading output…")?.disabled).toBe(true)
    expect(state.reads).toHaveLength(1)
    state.reads[0].pending.resolve({ output: "retained", cursor: 1, skipped: false })
    await flush()
    expect(collectText(state.render())).toContain("retained")
    expect(state.registrations).toHaveLength(1)
  })

  test("switching selected workers unsubscribes the previous worker", async () => {
    const state = fixture()
    const first = state.render()
    const second = state.render("worker-b")
    await state.show(first)
    state.emit()
    await state.show(second)
    expect(state.registrations[0].unsubscribed).toBe(1)
    expect(state.registrations[1].scope).toEqual({ kind: "session", sessionId: "worker-b" })
    expect(collectText(first)).not.toContain("command one")
    state.emit(0, [shell("stale")])
    expect(collectText(second)).not.toContain("command stale")
  })

  test("late subscription registration is disposed before the next worker subscribes", async () => {
    const state = fixture()
    const first = state.render()
    const second = state.render("worker-b")
    state.click(first, "Show commands")
    await flush()
    state.click(second, "Show commands")
    await flush()
    expect(state.registrations).toHaveLength(1)
    state.register(0)
    await flush()
    expect(state.registrations[0].unsubscribed).toBe(1)
    expect(state.registrations).toHaveLength(2)
    state.register(1)
    await flush()
    state.viewer.dispose()
    expect(state.registrations[1].unsubscribed).toBe(1)
  })

  test("hide cancels a pending registration and does not start another subscription", async () => {
    const state = fixture()
    const root = state.render()
    state.click(root, "Show commands")
    await flush()
    state.click(root, "Hide commands")
    state.register()
    await flush()
    expect(state.registrations[0].unsubscribed).toBe(1)
    expect(findByText(root, "button", "Show commands")).not.toBeNull()
    expect(state.registrations).toHaveLength(1)
  })

  test("context A/B/A drops stale snapshots, output success, and detached actions", async () => {
    const state = fixture()
    const oldRoot = state.render()
    await state.show(oldRoot)
    state.emit()
    const oldRead = findByText(oldRoot, "button", "Read output")!
    oldRead.click()
    state.viewer.setContext("project-b")
    state.viewer.setContext("project-a")
    const fresh = state.render()
    await state.show(fresh)
    state.emit(1, [shell("fresh")])
    state.emit(0, [shell("private-stale")])
    state.reads[0].pending.resolve({ output: "private output", cursor: 1, skipped: false })
    oldRead.click()
    await flush()
    expect(collectText(fresh)).toContain("command fresh")
    expect(collectText(fresh)).not.toContain("private")
    expect(collectText(oldRoot)).not.toContain("command one")
    expect(state.reads).toHaveLength(1)
  })

  test("worker A/B/A drops stale output rejection even when the shell ID repeats", async () => {
    const state = fixture()
    const first = state.render()
    const second = state.render("worker-b")
    await state.show(first)
    state.emit()
    state.click(first, "Read output")
    await state.show(second)
    await state.show(first)
    state.emit(2)
    state.reads[0].pending.reject({ code: "NOT_FOUND", message: "stale private failure" })
    await flush()
    expect(collectText(first)).not.toContain("stale private failure")
    expect(findByText(first, "button", "Read output")?.disabled).toBe(false)
  })

  test("reset and dispose clean pending registrations and cannot revive old card actions", async () => {
    for (const operation of ["reset", "dispose"] as const) {
      const state = fixture()
      const root = state.render()
      const oldShow = findByText(root, "button", "Show commands")!
      oldShow.click()
      await flush()
      state.viewer[operation]()
      state.register()
      await flush()
      oldShow.click()
      state.viewer.setContext("project-a")
      await flush()
      expect(state.registrations[0].unsubscribed).toBe(1)
      expect(state.registrations).toHaveLength(1)
      if (operation === "dispose") expect(collectText(state.render())).toContain("unavailable")
    }
  })

  test("same context rerenders preserve selected commands and output", async () => {
    const state = fixture()
    const root = state.render()
    await state.show(root)
    state.emit()
    state.click(root, "Read output")
    state.reads[0].pending.resolve({ output: "kept", cursor: 1, skipped: false })
    await flush()
    state.viewer.setContext("project-a")
    const next = state.render()
    expect(collectText(next)).toContain("command one")
    expect(collectText(next)).toContain("kept")
    expect(state.registrations).toHaveLength(1)
    state.emit()
    expect(collectText(next)).toContain("kept")
  })

  test.each(["NOT_GRANTED", "UNSUPPORTED", "NOT_FOUND"])("shows %s subscription failure rather than empty success", async (code) => {
    const state = fixture()
    const root = state.render()
    state.click(root, "Show commands")
    await flush()
    state.registrations[0].pending.reject({ code, message: "request refused" })
    await flush()
    expect(collectText(root)).toContain(code)
    expect(collectText(root)).toContain("request refused")
    expect(collectText(root)).not.toContain("No running")
    state.click(root, "Show commands")
    await flush()
    expect(state.registrations).toHaveLength(2)
  })

  test.each(["NOT_FOUND", "NOT_GRANTED", "UNSUPPORTED"])("shows %s output failure without claiming empty output", async (code) => {
    const state = fixture()
    const root = state.render()
    await state.show(root)
    state.emit()
    state.click(root, "Read output")
    state.reads[0].pending.reject({ code, message: "output unavailable <script>" })
    await flush()
    expect(collectText(root)).toContain(code)
    expect(collectText(root)).toContain("output unavailable <script>")
    expect(collectText(root)).not.toContain("No output")
    expect(findByText(root, "button", "Read output")?.disabled).toBe(false)
  })

  test("missing legacy host methods produce a visible unsupported state", async () => {
    for (const host of [{}, { onRunningShells: async () => () => {} }]) {
      const viewer = createWorkerShells(host)
      viewer.setContext("project-a")
      const root = viewer.render("worker-a") as unknown as FakeElement
      expect(collectText(root)).toContain("UNSUPPORTED")
      expect(findByText(root, "button", "Show commands")).toBeNull()
    }
    await flush()
  })

  test("removed commands cannot retain output or trigger stale reads", async () => {
    const state = fixture()
    const root = state.render()
    await state.show(root)
    state.emit()
    const readButton = findByText(root, "button", "Read output")!
    readButton.click()
    state.emit(0, [], [])
    state.reads[0].pending.resolve({ output: "removed private output", cursor: 1, skipped: false })
    await flush()
    readButton.click()
    expect(state.reads).toHaveLength(1)
    state.emit()
    expect(collectText(root)).not.toContain("removed private output")
  })

  test("a stale registration rejection cannot replace a new project's state", async () => {
    const state = fixture()
    const root = state.render()
    state.click(root, "Show commands")
    await flush()
    state.viewer.setContext("project-b")
    const fresh = state.render()
    state.click(fresh, "Show commands")
    state.registrations[0].pending.reject({ code: "NOT_GRANTED", message: "old context failure" })
    await flush()
    state.register(1)
    await flush()
    state.emit(1)
    expect(collectText(fresh)).toContain("command one")
    expect(collectText(fresh)).not.toContain("old context failure")
  })

  test("board rerenders preserve pending reads and do not duplicate subscriptions", async () => {
    let listener!: (snapshot: WorkerShellsSnapshot) => void
    let subscriptions = 0
    let reads = 0
    let root!: FakeElement
    const output = deferred<{ output: string; cursor: number; skipped: boolean }>()
    const viewer = createWorkerShells({
      async onRunningShells(_scope, callback) {
        subscriptions += 1
        listener = callback
        return () => {}
      },
      readShellOutput() {
        reads += 1
        return output.promise
      },
    })
    viewer.setContext("project-a")
    root = viewer.render("worker-a") as unknown as FakeElement
    findByText(root, "button", "Show commands")!.click()
    await flush()
    const snapshot: WorkerShellsSnapshot = { kind: "shells", scope: { kind: "session", sessionId: "worker-a" }, shells: [shell("one")], ended: [] }
    listener(snapshot)
    root = viewer.render("worker-a") as unknown as FakeElement
    findByText(root, "button", "Read output")!.click()
    listener(snapshot)
    root = viewer.render("worker-a") as unknown as FakeElement
    expect(findByText(root, "button", "Reading output…")?.disabled).toBe(true)
    output.resolve({ output: "still selected", cursor: 1, skipped: false })
    await flush()
    expect(collectText(root)).toContain("still selected")
    expect(subscriptions).toBe(1)
    expect(reads).toBe(1)
    viewer.dispose()
  })

  test("never invokes stopping, execution, persistence, or other host APIs", async () => {
    let forbiddenCalls = 0
    const forbidden = () => { forbiddenCalls += 1; throw new Error("forbidden host API") }
    const host = {
      async onRunningShells(_scope: unknown, listener: (snapshot: WorkerShellsSnapshot) => void) {
        listener({ kind: "shells", scope: { kind: "session", sessionId: "worker-a" }, shells: [shell("one")], ended: [] })
        return () => {}
      },
      async readShellOutput() { return { output: "local only", cursor: 1, skipped: false } },
      stopShell: forbidden,
      exec: forbidden,
      storage: { get: forbidden, set: forbidden },
    }
    const viewer = createWorkerShells(host)
    viewer.setContext("project-a")
    const root = viewer.render("worker-a") as unknown as FakeElement
    findByText(root, "button", "Show commands")!.click()
    await flush()
    findByText(root, "button", "Read output")!.click()
    await flush()
    viewer.reset()
    viewer.dispose()
    expect(forbiddenCalls).toBe(0)
  })
})
