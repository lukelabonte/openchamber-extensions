// Structural SDK subset so an older host can render an unsupported state.
// Commands/output are ephemeral: never persisted, logged, executed, or stopped.
export interface WorkerShell {
  id: string
  sessionID: string
  command: string
  startedAt: number
  background: boolean
}

type EndedShell = WorkerShell & {
  status: "exited" | "timeout" | "killed" | "stopped" | "unknown"
  exit?: number
  endedAt: number
}

export interface WorkerShellsSnapshot {
  kind: "shells"
  scope: { kind: "session"; sessionId: string } | { kind: "project"; projectId: string } | { kind: "global" }
  shells: WorkerShell[]
  ended: EndedShell[]
}

export interface WorkerShellsHost {
  onRunningShells?: (
    scope: { kind: "session"; sessionId: string },
    listener: (snapshot: WorkerShellsSnapshot) => void,
  ) => Promise<() => void>
  readShellOutput?: (shellId: string, options?: { tailBytes?: number }) => Promise<{ output: string; cursor: number; skipped: boolean }>
}

type OutputState = { pending: boolean; output?: string; skipped?: boolean; error?: string }
type Selection = {
  sessionId: string
  generation: number
  received: boolean
  shells: WorkerShell[]
  ended: EndedShell[]
  outputs: Map<string, OutputState>
  error?: string
}

function failureText(error: unknown): string {
  if (error && typeof error === "object") {
    const { code, message } = error as { code?: unknown; message?: unknown }
    const parts = [code, message].filter((value): value is string => typeof value === "string" && value.length > 0)
    if (parts.length) return parts.join(": ")
  }
  return typeof error === "string" ? error : "Request failed"
}

function endedStatus(shell: EndedShell): string {
  switch (shell.status) {
    case "exited": return `Exited (code ${shell.exit ?? "unknown"})`
    case "timeout": return "Timeout"
    case "killed": return "Killed"
    case "stopped": return "Stopped"
    default: return "Unknown end status"
  }
}

/** Render only known backlog worker IDs; native subagent membership is not inferred. */
export function createWorkerShells(host: WorkerShellsHost) {
  let context: string | null = null
  let generation = 0
  let disposed = false
  let selected: Selection | null = null
  let allowedSessions: ReadonlySet<string> | undefined
  let unsubscribe: (() => void) | undefined
  // A late registration must be released before registering its replacement.
  let registration = Promise.resolve()
  const roots = new Map<string, HTMLElement>()

  function isCurrent(selection: Selection): boolean {
    return !disposed && context !== null && selected === selection && generation === selection.generation
  }

  function release() {
    generation += 1
    selected = null
    const previous = unsubscribe
    unsubscribe = undefined
    previous?.()
  }

  function element<Tag extends keyof HTMLElementTagNameMap>(tag: Tag, text?: string) {
    const node = document.createElement(tag)
    if (text !== undefined) node.textContent = text
    return node
  }

  function notify() {
    for (const [sessionId, root] of roots) draw(root, sessionId)
  }

  function show(sessionId: string) {
    if (disposed || context === null || (allowedSessions !== undefined && !allowedSessions.has(sessionId)) || (selected?.sessionId === sessionId && !selected.error)) return
    release()
    const selection: Selection = {
      sessionId, generation, received: false, shells: [], ended: [], outputs: new Map(),
    }
    selected = selection
    notify()
    registration = registration.then(async () => {
      if (!isCurrent(selection)) return
      try {
        const disposeSubscription = await host.onRunningShells!(
          { kind: "session", sessionId },
          (snapshot) => {
            if (!isCurrent(selection) || selection.error || snapshot.scope.kind !== "session" || snapshot.scope.sessionId !== sessionId) return
            // Session scopes also include native children; only the exact backlog
            // worker is authorized for display here. Filter before applying limits.
            selection.shells = snapshot.shells.filter((shell) => shell.sessionID === sessionId).slice(-10)
            selection.ended = snapshot.ended.filter((shell) => shell.sessionID === sessionId).slice(-10)
            selection.received = true
            const visibleIds = new Set([...selection.shells, ...selection.ended].map((shell) => shell.id))
            for (const id of selection.outputs.keys()) {
              if (!visibleIds.has(id)) selection.outputs.delete(id)
            }
            notify()
          },
        )
        if (isCurrent(selection)) unsubscribe = disposeSubscription
        else disposeSubscription()
      } catch (error) {
        if (!isCurrent(selection)) return
        selection.error = failureText(error)
        selection.shells = []
        selection.ended = []
        selection.outputs.clear()
        notify()
      }
    })
  }

  async function read(selection: Selection, shellId: string) {
    if (!isCurrent(selection) || selection.error || selection.outputs.get(shellId)?.pending) return
    if (![...selection.shells, ...selection.ended].some((shell) => shell.id === shellId)) return
    const output: OutputState = { pending: true }
    selection.outputs.set(shellId, output)
    notify()
    try {
      const result = await host.readShellOutput!(shellId, { tailBytes: 16384 })
      if (!isCurrent(selection) || selection.outputs.get(shellId) !== output) return
      output.output = result.output
      output.skipped = result.skipped
    } catch (error) {
      if (!isCurrent(selection) || selection.outputs.get(shellId) !== output) return
      output.error = failureText(error)
    } finally {
      if (isCurrent(selection) && selection.outputs.get(shellId) === output) {
        output.pending = false
        notify()
      }
    }
  }

  function drawShell(selection: Selection, shell: WorkerShell, status: string): HTMLElement {
    const row = element("div")
    row.className = "fm-worker-shell"
    const command = element("code", shell.command)
    command.className = "fm-mono"
    row.append(command, element("p", `${shell.background ? "Background" : "Foreground"} · ${status}`))
    const output = selection.outputs.get(shell.id)
    const button = element("button", output?.pending ? "Reading output…" : "Read output")
    button.className = "fm-button"
    button.type = "button"
    button.disabled = output?.pending ?? false
    button.addEventListener("click", () => { void read(selection, shell.id) })
    row.append(button)
    if (output?.error) row.append(element("p", `Output unavailable: ${output.error}`))
    if (output?.output !== undefined) {
      row.append(element("p", `Bounded output tail (up to 16 KiB).${output.skipped ? " Earlier output skipped." : ""}`))
      const pre = element("pre", output.output)
      pre.setAttribute("style", "white-space:pre-wrap;overflow-wrap:anywhere;max-height:16rem;overflow:auto")
      row.append(pre)
      if (output.output === "") row.append(element("p", "No output in the returned tail."))
    }
    return row
  }

  function draw(root: HTMLElement, sessionId: string) {
    root.replaceChildren()
    if (disposed || context === null || (allowedSessions !== undefined && !allowedSessions.has(sessionId))) {
      root.append(element("p", "Worker commands unavailable without an active project."))
      return
    }
    if (typeof host.onRunningShells !== "function" || typeof host.readShellOutput !== "function") {
      root.append(element("p", "UNSUPPORTED: Worker commands require a host with the shells API."))
      return
    }
    const selection = selected?.sessionId === sessionId ? selected : null
    const currentGeneration = generation
    const button = element("button", selection && !selection.error ? "Hide commands" : "Show commands")
    button.className = "fm-button"
    button.type = "button"
    button.addEventListener("click", () => {
      if (disposed || context === null || generation !== currentGeneration) return
      if (selection && isCurrent(selection) && !selection.error) {
        release()
        notify()
      } else show(sessionId)
    })
    root.append(button)
    if (!selection) return
    if (selection.error) {
      root.append(element("p", `Commands unavailable: ${selection.error}`))
      return
    }
    if (!selection.received) {
      root.append(element("p", "Waiting for commands…"))
      return
    }
    root.append(element("p", "Latest 10 running and 10 recently ended commands for this worker only. Ended history is temporary."))
    if (!selection.shells.length && !selection.ended.length) {
      root.append(element("p", "No running or recently ended commands observed."))
    }
    for (const shell of selection.shells) root.append(drawShell(selection, shell, "Running"))
    for (const shell of selection.ended) root.append(drawShell(selection, shell, endedStatus(shell)))
  }

  function clearRoots() {
    for (const root of roots.values()) {
      root.replaceChildren()
      root.append(element("p", "Worker commands unavailable after context change."))
    }
    roots.clear()
  }

  return {
    setContext(projectId: string | null) {
      if (disposed || context === projectId) return
      release()
      context = projectId
      allowedSessions = undefined
      clearRoots()
    },
    retainWorkers(sessionIds: ReadonlySet<string>) {
      allowedSessions = new Set(sessionIds)
      if (selected !== null && !sessionIds.has(selected.sessionId)) release()
      for (const [sessionId, root] of roots) {
        if (sessionIds.has(sessionId)) continue
        root.replaceChildren()
        root.append(element("p", "Worker commands unavailable outside the current board."))
        roots.delete(sessionId)
      }
    },
    reset() {
      release()
      context = null
      allowedSessions = undefined
      clearRoots()
    },
    dispose() {
      disposed = true
      release()
      context = null
      allowedSessions = undefined
      clearRoots()
    },
    render(sessionId: string): HTMLElement {
      const root = element("div")
      root.className = "fm-worker-shells"
      roots.set(sessionId, root)
      draw(root, sessionId)
      return root
    },
  }
}
