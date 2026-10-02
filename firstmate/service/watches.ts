import type { FileSystemPort } from "./file-system"
import { loadRegistry, type Registration } from "./registry"
import { computeNextRun, extractScheduleComment, parseCronExpression } from "./watch-schedule"

// Watches: executable scripts in a home's shared/watches/ (available to every
// project, executed in each project's context) and projects/<slug>/watches/,
// run on a crontab-style `# schedule:` comment while the service lives. The
// service is the only scheduler, so a run missed while OpenChamber was not
// running is never made up; the first tick of a fresh service starts from
// "next run after now", never from history.

export type WatchSource = "shared" | "project"

export type WatchOutcome = "ok" | "empty" | "failed"

export interface WatchInfo {
  name: string
  source: WatchSource
  schedule: string
  enabled: boolean
  /** Present when the schedule expression does not parse; such a watch never runs. */
  error?: string
  lastRunAt?: string
  lastOutcome?: WatchOutcome
  lastOutput?: string
}

export interface WatchNotification {
  slug: string
  coordinatorSessionId: string
  homeDirectory: string
  message: string
}

export interface WatchExecution {
  stdout: string
  exitCode: number | null
  timedOut: boolean
}

// The declared exec permission covers user-owned watch scripts; they carry
// shebangs and are run directly, never through sh.
export type WatchExecPort = (input: {
  scriptPath: string
  cwd: string
  env: Record<string, string>
  timeoutMs: number
}) => Promise<WatchExecution>

export interface WatchRunner {
  /** One scheduling round over every registered project. Never throws. */
  tick(): Promise<{ notifications: WatchNotification[] }>
  listWatches(slug: string): Promise<WatchInfo[]>
  setEnabled(
    slug: string,
    source: WatchSource | undefined,
    name: string,
    enabled: boolean,
  ): Promise<"ok" | "unknown-watch" | "ambiguous-watch">
}

// The project's settings.json is the switch board for its watches; a file
// that cannot be parsed must stop the toggle instead of being overwritten.
export class WatchSettingsError extends Error {
  constructor(settingsPath: string, cause: string) {
    super(`FirstMate settings file ${settingsPath} is unreadable (${cause}). Fix or delete it, then toggle the watch again.`)
    this.name = "WatchSettingsError"
  }
}

interface RunState {
  nextRunAtMs: number
  lastRunAt?: string
  lastOutcome?: WatchOutcome
  lastOutput?: string
  /** Set while a failure has been reported; reset by the next success. */
  reportedFailure?: boolean
}

const lastOutputMaxLength = 2000
export const watchTimeoutMs = 60_000

interface DiscoveredWatch {
  name: string
  source: WatchSource
  schedule: string
  scriptPath: string
  /** Present when the schedule expression does not parse; such a watch never runs. */
  error?: string
}

export function createWatchRunner(input: {
  filesystem: FileSystemPort
  exec: WatchExecPort
  clock: { nowMs(): number }
  homeRoot: string
  timeoutMs?: number
}): WatchRunner {
  const { filesystem, exec, clock, homeRoot } = input
  const timeoutMs = input.timeoutMs ?? watchTimeoutMs
  // Run state is in-memory like every other supervision state: a service
  // restart re-derives "next run after now" and the card loses last-run
  // details. The enabled switch is the only persisted piece (settings.json).
  const runStates = new Map<string, RunState>()

  const stateKey = (slug: string, source: WatchSource, name: string): string => `${slug}\n${source}\n${name}`

  async function discoverWatches(slug: string): Promise<DiscoveredWatch[]> {
    const directories: { source: WatchSource; directory: string }[] = [
      { source: "shared", directory: `${homeRoot}/shared/watches` },
      { source: "project", directory: `${homeRoot}/projects/${slug}/watches` },
    ]
    const discovered: DiscoveredWatch[] = []
    for (const { source, directory } of directories) {
      for (const name of await filesystem.listExecutableFiles(directory)) {
        const scriptPath = `${directory}/${name}`
        let scriptText: string
        try {
          scriptText = await filesystem.readFile(scriptPath)
        } catch {
          continue
        }
        const expression = extractScheduleComment(scriptText)
        if (expression === undefined) continue
        let error: string | undefined
        try {
          parseCronExpression(expression)
        } catch (parseError) {
          error = parseError instanceof Error ? parseError.message : String(parseError)
        }
        discovered.push({
          name,
          source,
          schedule: expression,
          ...(error !== undefined ? { error } : {}),
          scriptPath,
        })
      }
    }
    return discovered
  }

  async function loadEnabledOverrides(slug: string): Promise<EnabledOverrides> {
    const settingsPath = `${homeRoot}/projects/${slug}/settings.json`
    if (!(await filesystem.exists(settingsPath))) return {}
    let settings: unknown
    try {
      settings = JSON.parse(await filesystem.readFile(settingsPath))
    } catch {
      // The read path stays tolerant (a watch defaults to enabled); the
      // toggle path is the one that reports a corrupt file.
      return {}
    }
    if (!isPlainObject(settings)) return {}
    const watches = settings.watches
    if (!isPlainObject(watches)) return {}
    const overrides: EnabledOverrides = {}
    for (const source of ["shared", "project"] as const) {
      if (isPlainObject(watches[source])) overrides[source] = watches[source] as Record<string, unknown>
    }
    return overrides
  }

  async function tick(): Promise<{ notifications: WatchNotification[] }> {
    const notifications: WatchNotification[] = []
    let registrations: Record<string, Registration>
    try {
      registrations = await loadRegistry(filesystem, homeRoot)
    } catch {
      // The board endpoint surfaces a corrupt registry itself.
      return { notifications }
    }
    const nowMs = clock.nowMs()
    const now = new Date(nowMs)
    for (const registration of Object.values(registrations)) {
      const { slug, homeDirectory, coordinatorSessionId } = registration
      const watches = await discoverWatches(slug)
      if (watches.length === 0) continue
      const enabledOverrides = await loadEnabledOverrides(slug)
      for (const watch of watches) {
        if (watch.error !== undefined) continue
        if (!isEnabled(enabledOverrides, watch.source, watch.name)) continue
        const key = stateKey(slug, watch.source, watch.name)
        let runState = runStates.get(key)
        if (runState === undefined) {
          // First sight: start from "next run after now". Nothing is made up
          // for the time this service was not running. A null sentinel (an
          // impossible schedule that slipped past parse validation) is never
          // due.
          const next = computeNextRun(parseCronExpression(watch.schedule), now)
          runState = { nextRunAtMs: next === null ? Number.POSITIVE_INFINITY : next.getTime() }
          runStates.set(key, runState)
        }
        if (nowMs < runState.nextRunAtMs) continue
        await runWatch(registration, watch, runState, notifications)
        const following = computeNextRun(parseCronExpression(watch.schedule), new Date(clock.nowMs()))
        runState.nextRunAtMs = following === null ? Number.POSITIVE_INFINITY : following.getTime()
      }
    }
    return { notifications }
  }

  async function runWatch(
    registration: Registration,
    watch: DiscoveredWatch,
    runState: RunState,
    notifications: WatchNotification[],
  ): Promise<void> {
    const { slug, homeDirectory, coordinatorSessionId } = registration
    const stateDirectory = `${homeDirectory}/watch-state/${watch.name}`
    runState.lastRunAt = new Date(clock.nowMs()).toISOString()
    let execution: WatchExecution | undefined
    let execError: string | undefined
    try {
      // A state directory that cannot be created is this watch's failure —
      // recorded and reported through its streak — never a round throw.
      await filesystem.createDirectory(stateDirectory)
      execution = await exec({
        scriptPath: watch.scriptPath,
        cwd: homeDirectory,
        env: {
          FIRSTMATE_HOME: homeDirectory,
          FIRSTMATE_BACKLOG: `${homeDirectory}/backlog.md`,
          FIRSTMATE_WATCH_STATE: stateDirectory,
        },
        timeoutMs,
      })
    } catch (error) {
      execError = error instanceof Error ? error.message : String(error)
    }

    const failed = execError !== undefined || execution === undefined || execution.timedOut || execution.exitCode !== 0
    if (failed) {
      const reason =
        execError ??
        (execution?.timedOut === true
          ? `timed out after ${timeoutMs} ms`
          : execution?.exitCode === null
            ? "was killed without an exit code"
            : `exited with code ${execution?.exitCode}`)
      // Reported to the coordinator once per failure streak; the next
      // successful run resets the streak.
      runState.lastOutcome = "failed"
      runState.lastOutput = execution === undefined ? "" : presentOutput(execution.stdout.trim())
      if (runState.reportedFailure !== true) {
        runState.reportedFailure = true
        notifications.push({
          slug,
          coordinatorSessionId,
          homeDirectory,
          message: `FirstMate (${slug}) watch ${watch.name} failed: ${reason}`,
        })
      }
      return
    }
    runState.reportedFailure = false
    const output = presentOutput(execution.stdout.trim())
    if (output === "") {
      runState.lastOutcome = "empty"
      runState.lastOutput = ""
      return
    }
    runState.lastOutcome = "ok"
    runState.lastOutput = output
    notifications.push({
      slug,
      coordinatorSessionId,
      homeDirectory,
      message: `FirstMate (${slug}) watch ${watch.name}:\n${output}`,
    })
  }

  async function listWatches(slug: string): Promise<WatchInfo[]> {
    const watches = await discoverWatches(slug)
    const enabledOverrides = await loadEnabledOverrides(slug)
    return watches.map((watch) => {
      const runState = runStates.get(stateKey(slug, watch.source, watch.name))
      return {
        name: watch.name,
        source: watch.source,
        schedule: watch.schedule,
        enabled: isEnabled(enabledOverrides, watch.source, watch.name),
        ...(watch.error !== undefined ? { error: watch.error } : {}),
        ...(runState?.lastRunAt !== undefined ? { lastRunAt: runState.lastRunAt } : {}),
        ...(runState?.lastOutcome !== undefined ? { lastOutcome: runState.lastOutcome } : {}),
        ...(runState?.lastOutput !== undefined && runState.lastOutput !== "" ? { lastOutput: runState.lastOutput } : {}),
      }
    })
  }

  // The enabled switch persists per source + name, so a shared watch and a
  // project watch that share a file name switch independently. Writes are
  // atomic (temp file + rename, the registry's discipline) and a corrupt
  // settings file stops the toggle with a named error instead of being
  // silently overwritten.
  async function setEnabled(
    slug: string,
    source: WatchSource | undefined,
    name: string,
    enabled: boolean,
  ): Promise<"ok" | "unknown-watch" | "ambiguous-watch"> {
    const candidates = (await discoverWatches(slug)).filter((watch) => watch.name === name)
    const targets = source === undefined ? candidates : candidates.filter((watch) => watch.source === source)
    if (targets.length === 0) return "unknown-watch"
    if (targets.length > 1) return "ambiguous-watch"
    const target = targets[0]
    const settingsPath = `${homeRoot}/projects/${slug}/settings.json`
    let settings: Record<string, unknown> = {}
    if (await filesystem.exists(settingsPath)) {
      let parsed: unknown
      try {
        parsed = JSON.parse(await filesystem.readFile(settingsPath))
      } catch (error) {
        throw new WatchSettingsError(settingsPath, error instanceof Error ? error.message : "not valid JSON")
      }
      if (!isPlainObject(parsed)) {
        throw new WatchSettingsError(settingsPath, "not a JSON object")
      }
      settings = parsed
    }
    const stored = isPlainObject(settings.watches) ? { ...settings.watches } : {}
    const forSource = isPlainObject(stored[target.source]) ? { ...(stored[target.source] as Record<string, unknown>) } : {}
    const entry = isPlainObject(forSource[name]) ? { ...(forSource[name] as Record<string, unknown>) } : {}
    entry.enabled = enabled
    forSource[name] = entry
    stored[target.source] = forSource
    settings.watches = stored
    const tempPath = `${settingsPath}.${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`
    await filesystem.writeFile(tempPath, `${JSON.stringify(settings, null, 2)}\n`)
    await filesystem.rename(tempPath, settingsPath)
    return "ok"
  }

  return { tick, listWatches, setEnabled }
}

type EnabledOverrides = Partial<Record<WatchSource, Record<string, unknown>>>

function isEnabled(overrides: EnabledOverrides, source: WatchSource, name: string): boolean {
  const entry = overrides[source]?.[name]
  return !(isPlainObject(entry) && entry.enabled === false)
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

// Latest log lines matter most: when output exceeds the cap, keep the tail
// and say how much was dropped. Applies to the coordinator message and the
// card's last output alike.
function presentOutput(text: string): string {
  if (text.length <= lastOutputMaxLength) return text
  const dropped = text.length - lastOutputMaxLength
  return `…[truncated ${dropped} chars]\n${text.slice(-lastOutputMaxLength)}`
}
