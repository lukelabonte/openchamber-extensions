import type { FileSystemPort } from "./file-system"
import type { QueuedWatchNote, WatchNotification, WatchOutcome, WatchSource } from "./watches"

export interface StoredWatchRun {
  lastRunAt: string
  lastOutcome: WatchOutcome
  lastOutput: string
  lastError?: string
  reportedFailure: boolean
}

interface WatchStoreState {
  version: 1
  runs: Record<string, StoredWatchRun>
  pending: QueuedWatchNote[]
  delivered: QueuedWatchNote[]
  dropped: number
}

export class WatchStoreError extends Error {
  constructor(filePath: string, cause: string) {
    super(`FirstMate watch store ${filePath} is unavailable (${cause}). Fix the file before running or delivering watches.`)
    this.name = "WatchStoreError"
  }
}

export function watchStorePath(homeDirectory: string): string {
  return `${homeDirectory}/watch-runner.json`
}

export function watchRunKey(source: WatchSource, name: string): string {
  return `${source}\n${name}`
}

export function createWatchStore(filesystem: FileSystemPort) {
  const updates = new Map<string, Promise<void>>()

  // Reads join the same project queue as writes. Every transaction reloads the
  // durable file, so acknowledgement and overlapping watch runs cannot replace
  // each other's changes with an old snapshot. Failed writes never enter a cache.
  function serialize<Value>(homeDirectory: string, operation: () => Promise<Value>): Promise<Value> {
    const previous = updates.get(homeDirectory) ?? Promise.resolve()
    const result = previous.then(operation)
    const settled = result.then(() => {}, () => {})
    updates.set(homeDirectory, settled)
    void settled.then(() => {
      if (updates.get(homeDirectory) === settled) updates.delete(homeDirectory)
    })
    return result
  }

  async function load(homeDirectory: string): Promise<WatchStoreState> {
    const filePath = watchStorePath(homeDirectory)
    try {
      if (!(await filesystem.exists(filePath))) return { version: 1, runs: {}, pending: [], delivered: [], dropped: 0 }
      const parsed: unknown = JSON.parse(await filesystem.readFile(filePath))
      if (!isStoreState(parsed, homeDirectory)) throw new Error("invalid watch state")
      return parsed
    } catch (error) {
      throw new WatchStoreError(filePath, error instanceof Error ? error.message : String(error))
    }
  }

  async function save(homeDirectory: string, state: WatchStoreState): Promise<void> {
    const filePath = watchStorePath(homeDirectory)
    const tempPath = `${filePath}.${crypto.randomUUID()}.tmp`
    try {
      await filesystem.writeFile(tempPath, `${JSON.stringify(state, null, 2)}\n`)
      await filesystem.rename(tempPath, filePath)
    } catch (error) {
      throw new WatchStoreError(filePath, error instanceof Error ? error.message : String(error))
    }
  }

  function read(homeDirectory: string): Promise<WatchStoreState> {
    return serialize(homeDirectory, () => load(homeDirectory))
  }

  function recordRun(homeDirectory: string, key: string, run: StoredWatchRun, notification?: WatchNotification): Promise<void> {
    return serialize(homeDirectory, async () => {
      const state = await load(homeDirectory)
      state.runs[key] = run
      if (notification !== undefined) {
        state.pending.push({ id: crypto.randomUUID(), createdAt: run.lastRunAt, notification })
        const overflow = Math.max(0, state.pending.length - 20)
        state.pending = state.pending.slice(-20)
        state.dropped += overflow
      }
      await save(homeDirectory, state)
    })
  }

  function acknowledge(homeDirectory: string, ids: readonly string[], droppedCount = 0): Promise<void> {
    return serialize(homeDirectory, async () => {
      if (!Number.isSafeInteger(droppedCount) || droppedCount < 0) throw new Error("invalid dropped watch notification count")
      const state = await load(homeDirectory)
      const deliveredIds = new Set(ids)
      const delivered = state.pending.filter((note) => deliveredIds.has(note.id))
      if (delivered.length === 0 && droppedCount === 0) return
      state.pending = state.pending.filter((note) => !deliveredIds.has(note.id))
      state.delivered = [...state.delivered, ...delivered].slice(-50)
      // A flush acknowledges its snapshot's dropped count, not drops caused
      // by another run while that snapshot was being delivered.
      state.dropped = Math.max(0, state.dropped - droppedCount)
      await save(homeDirectory, state)
    })
  }

  return { read, recordRun, acknowledge }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isDateString(value: unknown): value is string {
  return typeof value === "string" && Number.isFinite(Date.parse(value))
}

function isStoredRun(value: unknown): value is StoredWatchRun {
  return isPlainObject(value) &&
    isDateString(value.lastRunAt) &&
    ["ok", "empty", "failed"].includes(value.lastOutcome as string) &&
    typeof value.lastOutput === "string" && value.lastOutput.length <= 16_000 &&
    (value.lastError === undefined || (typeof value.lastError === "string" && value.lastError.length <= 16_000)) &&
    typeof value.reportedFailure === "boolean"
}

function isNote(value: unknown, homeDirectory: string): value is QueuedWatchNote {
  if (!isPlainObject(value) || typeof value.id !== "string" || value.id === "" || !isDateString(value.createdAt)) return false
  const notification = value.notification
  return isPlainObject(notification) &&
    typeof notification.slug === "string" &&
    typeof notification.coordinatorSessionId === "string" &&
    notification.homeDirectory === homeDirectory &&
    typeof notification.message === "string" && notification.message.length <= 16_000 &&
    (notification.watchName === undefined || typeof notification.watchName === "string") &&
    (notification.source === undefined || notification.source === "shared" || notification.source === "project")
}

function isStoreState(value: unknown, homeDirectory: string): value is WatchStoreState {
  if (!isPlainObject(value) || value.version !== 1 || !isPlainObject(value.runs)) return false
  if (!Object.entries(value.runs).every(([key, run]) => /^(shared|project)\n.+$/s.test(key) && isStoredRun(run))) return false
  if (!Array.isArray(value.pending) || value.pending.length > 20 || !value.pending.every((note) => isNote(note, homeDirectory))) return false
  if (!Array.isArray(value.delivered) || value.delivered.length > 50 || !value.delivered.every((note) => isNote(note, homeDirectory))) return false
  const notes = [...value.pending, ...value.delivered]
  return new Set(notes.map((note) => note.id)).size === notes.length &&
    typeof value.dropped === "number" && Number.isSafeInteger(value.dropped) && value.dropped >= 0
}
