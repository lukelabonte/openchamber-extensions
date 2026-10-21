import path from "node:path"

export interface CleanupPlan {
  taskId: string
  sourceDirectory: string
  targetDirectory: string
  evidenceDirectory: string
  branch: string
  head: string
  sourceHead: string
  landedHead: string
  workerSessionId: string
  coordinatorSessionId: string
  authorization: { kind: "verified-landing" | "explicit-cleanup"; reference: string }
}

export interface GitCleanupObservation {
  directory: string
  sourceDirectory: string
  sourceHead: string
  landedHead: string
  task: { id: string; directory: string; branch: string }
  exists: boolean
  registered: boolean
  branchHead?: string
  worktreeHead?: string
  worktreeBranch?: string
  tracked: string[]
  untracked: string[]
  ignored: string[]
  content: "ancestor" | "changed-file-parity" | "unique" | "unknown"
  landingVerified: boolean
  protectedBranches: string[]
}

export interface RuntimeIdentity { pid: number; version: string; url: string }
export interface LocationActivity {
  directory: string
  activeSessions: string[]
  pendingRequests: string[]
  queuedWork: string[]
  commands: string[]
  terminals: string[]
}
export interface CleanupRuntime {
  identity: RuntimeIdentity
  disposalContract: { operationId: string; method: string; locationParameter: string; successStatus: number }
  // Global reads only: this must not boot or resolve any target location.
  inspect(): Promise<{ identity: RuntimeIdentity; loadedLocations: string[]; activeLocations: string[]; activityKnown: boolean }>
  inspectLocation(directory: string): Promise<LocationActivity>
  dispose(directory: string): Promise<{ operationId: string; directory: string; status: number }>
}

export interface CleanupPorts {
  canonicalize(directory: string): Promise<string>
  worker(): Promise<{ sessionId: string; directory: string; cwd: string; known: boolean }>
  inspectGit(): Promise<GitCleanupObservation>
  // Stable fingerprint of source/unrelated HEADs, status (including ignored
  // paths), index, stash, and all retained evidence/recovery bundle hashes.
  protectedState(): Promise<string>
  // A worker-supplied passive OS/registry inventory, not a default CLI lookup.
  // complete requires every handle owner/ancestor and every relevant runtime.
  discover(): Promise<{ complete: boolean; runtimes: CleanupRuntime[]; handles: { pid: number; runtimePid?: number; idleForTarget: boolean }[] }>
  git(argumentsList: readonly string[]): Promise<{ code: number }>
  record(receipt: { phase: string; target: string; details?: unknown }): Promise<void>
}

export interface CleanupResult {
  status: "removed" | "already-clean" | "retained"
  worktreeRemoved: boolean
  branchRemoved: boolean
  released: { pid: number; directory: string }[]
  retainedPaths: string[]
  blocker?: string
}

// Worker-only safety/order runner. Discovery and observation adapters are built
// from the installed contracts by that worker; the coordinator never calls it.
// One attempt per invocation. No cached clearance, forced removal, remote push,
// process signal, service restart, permission change, or session interruption.
export async function cleanupTaskWorktree(plan: CleanupPlan, ports: CleanupPorts): Promise<CleanupResult> {
  const released: CleanupResult["released"] = []
  let worktreeRemoved = false
  let branchRemoved = false
  let evidenceReady = false
  try {
    if (!plan.authorization || !["verified-landing", "explicit-cleanup"].includes(plan.authorization.kind) || !plan.authorization.reference?.trim()) throw new Error("verified landing or explicit cleanup authorization with evidence is required")
    if (!plan.taskId || !plan.workerSessionId || plan.workerSessionId === plan.coordinatorSessionId || !plan.coordinatorSessionId) throw new Error("cleanup must belong to a worker, never the first mate")
    if (![plan.head, plan.sourceHead, plan.landedHead].every((head) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(head))) throw new Error("pin exact task, source checkout and landed commit heads")
    if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(plan.branch) || plan.branch.includes("..") || plan.branch.endsWith(".lock")) throw new Error("cleanup branch is invalid")
    for (const directory of [plan.sourceDirectory, plan.targetDirectory, plan.evidenceDirectory]) {
      if (!path.isAbsolute(directory) || path.normalize(directory) !== directory || directory.includes("\0") || await ports.canonicalize(directory) !== directory) throw new Error("cleanup paths must be absolute, canonical, and unchanged")
    }
    if (plan.targetDirectory === path.parse(plan.targetDirectory).root || within(plan.sourceDirectory, plan.targetDirectory) || within(plan.evidenceDirectory, plan.targetDirectory)) throw new Error("source checkout and evidence must be outside the removed worktree")
    await checkWorker()
    evidenceReady = true
    const initialGit = await checkGit()
    const protectedState = await ports.protectedState()
    if (typeof protectedState !== "string" || protectedState === "") throw new Error("protected source, unrelated worktrees and evidence state is unknown")
    const discovery = await ports.discover()
    checkInventory(discovery)
    const runtimeKeys = discovery.runtimes.map((runtime) => identityKey(runtime.identity)).sort()
    const releases: { runtime: CleanupRuntime; directory: string }[] = []
    // Inspect every owner before disposing anything. One active/uncertain owner
    // blocks the target across all runtimes, including loaded descendants.
    for (const runtime of discovery.runtimes) {
      const global = await checkGlobal(runtime)
      const locations = [...new Set(global.loadedLocations.filter((directory) => within(directory, plan.targetDirectory)))].sort((left, right) => right.length - left.length)
      if (locations.length > 0) {
        const contract = runtime.disposalContract
        if (contract?.operationId !== "debug.location.evict" || contract.method !== "DELETE" || contract.locationParameter !== "location[directory]" || contract.successStatus !== 204) throw new Error(`runtime ${runtime.identity.pid} has no verified supported per-location disposal contract`)
      }
      if (discovery.handles.some((owner) => owner.runtimePid === runtime.identity.pid) && locations.length === 0) throw new Error(`runtime ${runtime.identity.pid} holds the target without an attributable loaded location`)
      for (const directory of locations) {
        const activity = await runtime.inspectLocation(directory)
        if (activity.directory !== directory) throw new Error(`runtime ${runtime.identity.pid} returned the wrong directory`)
        for (const key of ["activeSessions", "pendingRequests", "queuedWork", "commands", "terminals"] as const) {
          if (!Array.isArray(activity[key]) || activity[key].length !== 0) throw new Error(`${directory} has active or unknown ${key} in runtime ${runtime.identity.pid}`)
        }
        releases.push({ runtime, directory })
      }
    }
    await ports.record({ phase: "preflight", target: plan.targetDirectory, details: { authorization: plan.authorization, taskId: plan.taskId, branch: plan.branch, head: plan.head, sourceHead: plan.sourceHead, landedHead: plan.landedHead, runtimes: runtimeKeys } })
    await checkWorker()
    await checkGit()
    await checkProtected()
    for (const { runtime, directory } of releases) {
      await checkGlobal(runtime)
      await ports.record({ phase: "before-disposal", target: directory, details: runtime.identity })
      const outcome = await runtime.dispose(directory)
      if (outcome.operationId !== "debug.location.evict" || outcome.directory !== directory || outcome.status !== 204) throw new Error(`runtime ${runtime.identity.pid} did not confirm exact-location disposal`)
      released.push({ pid: runtime.identity.pid, directory })
      await ports.record({ phase: "disposed", target: directory, details: runtime.identity })
    }
    // From this point forward, no target-scoped API reads are permitted.
    await finalGuard()
    let latest = await checkGit()
    if (!latest.exists && !latest.registered && latest.branchHead === undefined) {
      await ports.record({ phase: "already-clean", target: plan.targetDirectory })
      return { status: "already-clean", worktreeRemoved: true, branchRemoved: true, released, retainedPaths: [] }
    }
    if (latest.exists) {
      await ports.record({ phase: "before-worktree-removal", target: plan.targetDirectory })
      await finalGuard()
      const removal = await ports.git(["--no-optional-locks", "-C", plan.sourceDirectory, "worktree", "remove", "--", plan.targetDirectory])
      if (removal.code !== 0) throw new Error("non-forced worktree removal failed; retain and inspect the target")
      latest = await checkGit()
      if (latest.exists || latest.registered) throw new Error("worktree removal was not confirmed by a fresh Git/filesystem read")
    }
    worktreeRemoved = true
    if (latest.branchHead !== undefined) {
      await ports.record({ phase: "before-local-branch-removal", target: plan.branch, details: { head: plan.head } })
      await finalGuard()
      const removal = await ports.git(["--no-optional-locks", "-C", plan.sourceDirectory, "branch", "-d", "--", plan.branch])
      if (removal.code !== 0) throw new Error("non-forced local branch deletion failed; retain the branch, including after a squash merge")
    }
    latest = await checkGit()
    if (latest.exists || latest.registered || latest.branchHead !== undefined) throw new Error("local cleanup is not confirmed complete")
    branchRemoved = true
    await checkProtected()
    await ports.record({ phase: "removed", target: plan.targetDirectory, details: { branch: plan.branch, remoteBranches: "untouched" } })
    return { status: initialGit.exists || initialGit.branchHead !== undefined ? "removed" : "already-clean", worktreeRemoved, branchRemoved, released, retainedPaths: [] }

    async function checkWorker(): Promise<void> {
      const worker = await ports.worker()
      if (worker.known !== true || worker.sessionId !== plan.workerSessionId || !path.isAbsolute(worker.directory) || !path.isAbsolute(worker.cwd) || within(worker.directory, plan.targetDirectory) || within(worker.cwd, plan.targetDirectory) || await ports.canonicalize(worker.directory) !== worker.directory || await ports.canonicalize(worker.cwd) !== worker.cwd) throw new Error("move the cleanup worker session and command cwd outside the target; unknown state blocks cleanup")
    }
    async function checkGit(): Promise<GitCleanupObservation> {
      const observation = await ports.inspectGit()
      if (observation.directory !== plan.targetDirectory || observation.sourceDirectory !== plan.sourceDirectory || observation.sourceHead !== plan.sourceHead || observation.landedHead !== plan.landedHead || observation.task?.id !== plan.taskId || observation.task.directory !== plan.targetDirectory || observation.task.branch !== plan.branch) throw new Error("task ownership, pinned source checkout, or pinned landed-content head does not match")
      if (typeof observation.exists !== "boolean" || typeof observation.registered !== "boolean" || observation.exists !== observation.registered) throw new Error("worktree path/registration state is uncertain")
      if (observation.branchHead !== undefined && observation.branchHead !== plan.head || observation.exists && (observation.worktreeHead !== plan.head || observation.branchHead !== plan.head)) throw new Error("the worktree or branch head changed")
      if (observation.exists && observation.worktreeBranch !== plan.branch) throw new Error("the worktree is no longer checked out on its recorded task branch")
      if (!Array.isArray(observation.protectedBranches) || observation.protectedBranches.length === 0 || observation.protectedBranches.includes(plan.branch)) throw new Error("source/default branch protection is unknown or includes the cleanup branch")
      for (const key of ["tracked", "untracked", "ignored"] as const) if (!Array.isArray(observation[key]) || observation[key].length !== 0) throw new Error(`the target has dirty or unknown ${key} state`)
      if (!["ancestor", "changed-file-parity"].includes(observation.content)) throw new Error("unique unlanded content is present or cannot be ruled out")
      if (plan.authorization.kind === "verified-landing" && observation.landingVerified !== true) throw new Error("landing evidence is not verified")
      return observation
    }
    async function checkProtected(): Promise<void> {
      if (await ports.protectedState() !== protectedState) throw new Error("protected source, unrelated worktree, history or evidence state changed")
    }
    function checkInventory(inventory: Awaited<ReturnType<CleanupPorts["discover"]>>): void {
      if (inventory.complete !== true || !Array.isArray(inventory.runtimes) || !Array.isArray(inventory.handles)) throw new Error("all-runtime and handle discovery is incomplete")
      const pids = new Set<number>()
      for (const runtime of inventory.runtimes) {
        identityKey(runtime.identity)
        if (pids.has(runtime.identity.pid)) throw new Error("deduplicate runtime aliases before cleanup; runtime ownership is ambiguous")
        pids.add(runtime.identity.pid)
      }
      if (inventory.handles.some((owner) => !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || !pids.has(owner.runtimePid))) throw new Error("a target handle owner has no verified runtime identity")
      if (inventory.handles.some((owner) => owner.idleForTarget !== true)) throw new Error("a target handle owner is active or its idle state cannot be verified")
    }
    async function checkGlobal(runtime: CleanupRuntime) {
      const global = await runtime.inspect()
      if (identityKey(global.identity) !== identityKey(runtime.identity)) throw new Error("runtime identity changed; rediscover after a restart")
      if (global.activityKnown !== true || !Array.isArray(global.activeLocations) || !Array.isArray(global.loadedLocations) || [...global.activeLocations, ...global.loadedLocations].some((directory) => typeof directory !== "string" || !path.isAbsolute(directory))) throw new Error("runtime global activity or loaded locations are unknown")
      for (const directory of [...global.activeLocations, ...global.loadedLocations]) if (path.normalize(directory) !== directory || await ports.canonicalize(directory) !== directory) throw new Error("runtime returned an unverified or redirected location path")
      if (global.activeLocations.some((directory) => within(directory, plan.targetDirectory))) throw new Error("an active session uses the target location")
      return global
    }
    async function finalGuard(): Promise<void> {
      await checkWorker()
      const latestInventory = await ports.discover()
      checkInventory(latestInventory)
      if (JSON.stringify(latestInventory.runtimes.map((runtime) => identityKey(runtime.identity)).sort()) !== JSON.stringify(runtimeKeys)) throw new Error("runtime ownership changed; fresh discovery and preflight are required")
      if (latestInventory.handles.length !== 0) throw new Error("target directory handles remain or reappeared after disposal")
      for (const runtime of latestInventory.runtimes) if ((await checkGlobal(runtime)).loadedLocations.some((directory) => within(directory, plan.targetDirectory))) throw new Error("the target location was recreated after disposal")
      await checkGit()
      await checkProtected()
    }
  } catch (error) {
    let blocker = error instanceof Error ? error.message : "cleanup state is unknown"
    if (evidenceReady) try { await ports.record({ phase: "retained", target: plan.targetDirectory, details: { blocker, released, worktreeRemoved, branchRemoved } }) } catch { blocker += "; cleanup evidence could not be saved" }
    return { status: "retained", worktreeRemoved, branchRemoved, released, retainedPaths: [...(worktreeRemoved ? [] : [plan.targetDirectory]), ...(branchRemoved ? [] : [`refs/heads/${plan.branch}`])], blocker }
  }
}

function within(directory: string, root: string): boolean {
  return directory === root || directory.startsWith(`${root}${path.sep}`)
}

function identityKey(identity: RuntimeIdentity): string {
  const url = new URL(identity.url)
  if (!Number.isSafeInteger(identity.pid) || identity.pid <= 0 || !identity.version || url.protocol !== "http:" || !["127.0.0.1", "[::1]"].includes(url.hostname) || url.username || url.password || url.pathname !== "/" || url.search || url.hash) throw new Error("runtime identity or loopback endpoint is unverifiable")
  return `${identity.pid}:${identity.version}:${url.origin}`
}
