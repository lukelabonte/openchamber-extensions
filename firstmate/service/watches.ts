import type { FileSystemPort } from "./file-system"
import type { HttpFetcher, InterruptSupport } from "./interrupt"
import { notifyCaptain } from "./notifications"
import { loadRegistry, type Registration } from "./registry"
import { computeNextRun, extractScheduleComment, parseCronExpression, scheduleLinePattern } from "./watch-schedule"

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
  /** Epoch ms of the next scheduled run; null when disabled, broken, or never due. */
  nextRun: number | null
  /** Absolute path of the script file on disk. */
  path: string
  /** Present when the schedule expression does not parse; such a watch never runs. */
  error?: string
  lastRunAt?: string
  lastOutcome?: WatchOutcome
  lastOutput?: string
  /** Present when the last run failed: the timeout, exit, or exception reason; cleared by the next successful run. */
  lastError?: string
}

// The optional watch attribution lets the delivery path record a lost
// coordinator delivery per watch; the fields stay optional so any existing
// constructor of a notification keeps compiling unchanged.
export interface WatchNotification {
  slug: string
  coordinatorSessionId: string
  homeDirectory: string
  message: string
  watchName?: string
  source?: WatchSource
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

// The result of a manual run-now: the resolution failures the panel must
// answer for (unknown slug/watch, an ambiguous same-name pair, a broken
// schedule, an in-flight execution) and the completed run — whose
// notifications are main's to deliver, never delivered by the runner.
export type RunNowResult =
  | { kind: "unknown-slug" }
  | { kind: "unknown-watch" }
  | { kind: "ambiguous-watch" }
  | { kind: "invalid-schedule"; error: string }
  | { kind: "already-running" }
  | {
      kind: "ran"
      name: string
      source: WatchSource
      lastOutcome: WatchOutcome
      lastError?: string
      notifications: WatchNotification[]
    }

export interface WatchRunner {
  /** One scheduling round over every registered project. Never throws. */
  tick(): Promise<{ notifications: WatchNotification[] }>
  /**
   * Runs the named watch immediately through the scheduler's own execution
   * path — the same executor, run state, streak, env, and timeout. A
   * disabled watch may be run explicitly (the switch toggles automatic
   * scheduling only); a broken-schedule watch refuses; an in-flight
   * execution, scheduled or manual, answers "already-running". Never
   * delivers: the returned notifications are main's to deliver.
   */
  runNow(slug: string, source: WatchSource | undefined, name: string): Promise<RunNowResult>
  listWatches(slug: string): Promise<WatchInfo[]>
  setEnabled(
    slug: string,
    source: WatchSource | undefined,
    name: string,
    enabled: boolean,
  ): Promise<"ok" | "unknown-watch" | "ambiguous-watch">
  /** Rewrites only the `# schedule:` line of the named watch's script. */
  setSchedule(
    slug: string,
    source: WatchSource | undefined,
    name: string,
    schedule: string,
  ): Promise<"ok" | "unknown-watch" | "ambiguous-watch">
  /** Writes a new executable watch script into the project's watches/ directory. */
  createWatch(slug: string, name: string, schedule: string, command: string): Promise<"ok" | "duplicate-watch">
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
  /** The timeout/exit/exception reason of the last failed run; cleared by the next success. */
  lastError?: string
  /** Set while a failure has been reported; reset by the next success. */
  reportedFailure?: boolean
}

// What one execution of a watch produced: the outcome the run state and
// the run-now result both carry, plus the failure reason.
interface WatchRunResult {
  outcome: WatchOutcome
  lastError?: string
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
  fetcher: HttpFetcher
  // Support is resolved lazily at emit time, like the poller's: a host that
  // gains or loses the desktop proxy between service start and a later run
  // must not be frozen out by a boot-time answer.
  resolveSupport: () => Promise<InterruptSupport>
  timeoutMs?: number
}): WatchRunner {
  const { filesystem, exec, clock, homeRoot, fetcher, resolveSupport } = input
  const timeoutMs = input.timeoutMs ?? watchTimeoutMs
  // Run state is in-memory like every other supervision state: a service
  // restart re-derives "next run after now" and the card loses last-run
  // details. The enabled switch is the only persisted piece (settings.json).
  const runStates = new Map<string, RunState>()
  // Watches whose execution is in flight right now, scheduled or manual,
  // keyed like the run state. The check-and-set happens before the first
  // await, so a run-now racing a due scheduled run (or a second run-now)
  // resolves to one execution and one "already-running" refusal.
  const inFlightWatches = new Set<string>()

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
    for (const registration of Object.values(registrations)) {
      const { slug } = registration
      const watches = await discoverWatches(slug)
      if (watches.length === 0) continue
      const enabledOverrides = await loadEnabledOverrides(slug)
      for (const watch of watches) {
        if (watch.error !== undefined) continue
        if (!isEnabled(enabledOverrides, watch.source, watch.name)) continue
        const key = stateKey(slug, watch.source, watch.name)
        const runState = ensureRunState(key, watch)
        if (nowMs < runState.nextRunAtMs) continue
        // A manual run in flight holds this watch's lock and consumes the due
        // slot itself when it finishes; the tick simply moves on.
        await executeWatch(registration, watch, runState, notifications)
      }
    }
    return { notifications }
  }

  // First sight on either path — a scheduled tick or a manual run — starts
  // from "next run after now": nothing is made up for the time this service
  // was not running. A null sentinel (an impossible schedule that slipped
  // past parse validation) is never due.
  function ensureRunState(key: string, watch: DiscoveredWatch): RunState {
    let runState = runStates.get(key)
    if (runState === undefined) {
      const next = computeNextRun(parseCronExpression(watch.schedule), new Date(clock.nowMs()))
      runState = { nextRunAtMs: next === null ? Number.POSITIVE_INFINITY : next.getTime() }
      runStates.set(key, runState)
    }
    return runState
  }

  // The one execution path the scheduler's tick and a manual run-now share:
  // the per-watch lock (acquired before the first await, released in finally
  // so even an exception never wedges a watch), the run itself, and the
  // next-run advance afterwards. Keeping the advance here — one executor
  // path — means a manual run of a due watch consumes the due slot exactly
  // like a scheduled one, so the next tick never immediately repeats it.
  // Returns undefined when another execution already holds the lock.
  async function executeWatch(
    registration: Registration,
    watch: DiscoveredWatch,
    runState: RunState,
    notifications: WatchNotification[],
  ): Promise<WatchRunResult | undefined> {
    const key = stateKey(registration.slug, watch.source, watch.name)
    if (inFlightWatches.has(key)) return undefined
    inFlightWatches.add(key)
    try {
      const result = await runWatch(registration, watch, runState, notifications)
      const following = computeNextRun(parseCronExpression(watch.schedule), new Date(clock.nowMs()))
      runState.nextRunAtMs = following === null ? Number.POSITIVE_INFINITY : following.getTime()
      return result
    } finally {
      inFlightWatches.delete(key)
    }
  }

  async function runWatch(
    registration: Registration,
    watch: DiscoveredWatch,
    runState: RunState,
    notifications: WatchNotification[],
  ): Promise<WatchRunResult> {
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
      runState.lastOutcome = "failed"
      runState.lastOutput = execution === undefined ? "" : presentOutput(execution.stdout.trim())
      runState.lastError = reason
      // Reported to the coordinator and the captain's desktop once per
      // failure streak; the next successful run — empty stdout included —
      // resets the streak, so neither repeats on every failed run.
      if (runState.reportedFailure !== true) {
        runState.reportedFailure = true
        notifications.push({
          slug,
          coordinatorSessionId,
          homeDirectory,
          message: `FirstMate (${slug}) watch ${watch.name} failed: ${reason}`,
          watchName: watch.name,
          source: watch.source,
        })
        const captain = captainWatchNotification(watch.name, "failed", reason)
        try {
          await notifyCaptain({ fetcher, support: await resolveSupport(), title: captain.title, body: captain.body })
        } catch {
          // Best effort: never throws into the run.
        }
      }
      return { outcome: "failed", lastError: reason }
    }
    runState.reportedFailure = false
    runState.lastError = undefined
    const output = presentOutput(execution.stdout.trim())
    if (output === "") {
      runState.lastOutcome = "empty"
      runState.lastOutput = ""
      return { outcome: "empty" }
    }
    runState.lastOutcome = "ok"
    runState.lastOutput = output
    notifications.push({
      slug,
      coordinatorSessionId,
      homeDirectory,
      message: `FirstMate (${slug}) watch ${watch.name}:\n${output}`,
      watchName: watch.name,
      source: watch.source,
    })
    // The captain hears a firing watch on the desktop too, with the same
    // output capped to the host's limits. Best effort — like the emit
    // route itself, a failed or rate-limited notification never fails
    // the run.
    const captain = captainWatchNotification(watch.name, "fired", output)
    try {
      await notifyCaptain({ fetcher, support: await resolveSupport(), title: captain.title, body: captain.body })
    } catch {
      // Best effort: never throws into the run.
    }
    return { outcome: "ok" }
  }

  async function listWatches(slug: string): Promise<WatchInfo[]> {
    const watches = await discoverWatches(slug)
    const enabledOverrides = await loadEnabledOverrides(slug)
    const now = new Date(clock.nowMs())
    return watches.map((watch) => {
      const runState = runStates.get(stateKey(slug, watch.source, watch.name))
      const enabled = isEnabled(enabledOverrides, watch.source, watch.name)
      return {
        name: watch.name,
        source: watch.source,
        schedule: watch.schedule,
        enabled,
        path: watch.scriptPath,
        ...(watch.error !== undefined ? { error: watch.error } : {}),
        // Enabled watches show their next scheduled run; disabled and
        // broken watches show none.
        nextRun:
          enabled && watch.error === undefined
            ? computeNextRun(parseCronExpression(watch.schedule), now)?.getTime() ?? null
            : null,
        ...(runState?.lastRunAt !== undefined ? { lastRunAt: runState.lastRunAt } : {}),
        ...(runState?.lastOutcome !== undefined ? { lastOutcome: runState.lastOutcome } : {}),
        ...(runState?.lastOutput !== undefined && runState.lastOutput !== "" ? { lastOutput: runState.lastOutput } : {}),
        ...(runState?.lastError !== undefined ? { lastError: runState.lastError } : {}),
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

  // The schedule edit resolves the watch exactly like the toggle (by name,
  // optionally narrowed to a source) and rewrites only the `# schedule:` line
  // the loader matches, leaving every other byte of the script alone. The
  // file is written in place, so its exec permission — the property discovery
  // depends on — is never touched. The in-memory run state is dropped so the
  // new schedule takes effect on the next tick ("next run after now", like a
  // first sight).
  async function setSchedule(
    slug: string,
    source: WatchSource | undefined,
    name: string,
    schedule: string,
  ): Promise<"ok" | "unknown-watch" | "ambiguous-watch"> {
    const candidates = (await discoverWatches(slug)).filter((watch) => watch.name === name)
    const targets = source === undefined ? candidates : candidates.filter((watch) => watch.source === source)
    if (targets.length === 0) return "unknown-watch"
    if (targets.length > 1) return "ambiguous-watch"
    const target = targets[0]
    const lines = (await filesystem.readFile(target.scriptPath)).split("\n")
    // The comment must live in the first 20 lines — the loader's own bound.
    for (let index = 0; index < Math.min(lines.length, 20); index += 1) {
      if (!scheduleLinePattern.test(lines[index])) continue
      lines[index] = `# schedule: ${schedule}`
      await filesystem.writeFile(target.scriptPath, lines.join("\n"))
      runStates.delete(stateKey(slug, target.source, name))
      return "ok"
    }
    return "unknown-watch"
  }

  // Creation mirrors the provision mechanism for template watches: write the
  // script, then set the exec bit — discovery lists executable files only, so
  // a created watch must carry it from birth. The duplicate check covers both
  // sources; a created script is discovered under its file name, so a name
  // collides with or without the .sh suffix.
  async function createWatch(slug: string, name: string, schedule: string, command: string): Promise<"ok" | "duplicate-watch"> {
    const existing = await discoverWatches(slug)
    if (existing.some((watch) => watch.name === name || watch.name === `${name}.sh`)) {
      return "duplicate-watch"
    }
    const watchesDirectory = `${homeRoot}/projects/${slug}/watches`
    await filesystem.createDirectory(watchesDirectory)
    const scriptPath = `${watchesDirectory}/${name}.sh`
    await filesystem.writeFile(scriptPath, `#!/bin/sh\n# schedule: ${schedule}\n${command}\n`)
    await filesystem.setExecutable(scriptPath)
    return "ok"
  }

  // A manual run-now resolves the watch exactly like the toggle (by name,
  // optionally narrowed to a source) and drives the same execution path
  // the scheduler's tick drives — run state, streak, env, and timeout are
  // all shared, so a manual run's records and streak resets land exactly
  // where a scheduled run's would. A disabled watch may be run explicitly
  // (the switch toggles automatic scheduling only); a broken-schedule
  // watch refuses — the panel disables its button. Never delivers: the
  // notifications ride the result for main's shared delivery path.
  async function runNow(slug: string, source: WatchSource | undefined, name: string): Promise<RunNowResult> {
    const registrations = await loadRegistry(filesystem, homeRoot)
    const registration = registrations[slug]
    if (registration === undefined) return { kind: "unknown-slug" }
    const candidates = (await discoverWatches(slug)).filter((watch) => watch.name === name)
    const targets = source === undefined ? candidates : candidates.filter((watch) => watch.source === source)
    if (targets.length === 0) return { kind: "unknown-watch" }
    if (targets.length > 1) return { kind: "ambiguous-watch" }
    const watch = targets[0]
    if (watch.error !== undefined) return { kind: "invalid-schedule", error: watch.error }
    const key = stateKey(slug, watch.source, watch.name)
    const runState = ensureRunState(key, watch)
    const notifications: WatchNotification[] = []
    const run = await executeWatch(registration, watch, runState, notifications)
    if (run === undefined) return { kind: "already-running" }
    return {
      kind: "ran",
      name: watch.name,
      source: watch.source,
      lastOutcome: run.outcome,
      ...(run.lastError !== undefined ? { lastError: run.lastError } : {}),
      notifications,
    }
  }

  return { tick, runNow, listWatches, setEnabled, setSchedule, createWatch }
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

// The desktop emit route carries only so much: the 500-character body limit
// the firing notification has always honored, and a title cap that binds
// only for absurdly long watch names (created names max out at 40 plus
// ".sh"). Both captain notifications a watch produces — fired and failed —
// go through this one helper, so neither can exceed the host's limits.
const captainTitleMaxLength = 100
const captainBodyMaxLength = 500

function captainWatchNotification(watchName: string, event: "fired" | "failed", body: string): { title: string; body: string } {
  return {
    title: `FirstMate — ${watchName} ${event}`.slice(0, captainTitleMaxLength),
    body: body.slice(0, captainBodyMaxLength),
  }
}
