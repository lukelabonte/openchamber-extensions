import { describe, expect, test } from "bun:test"
import { cleanupTaskWorktree, type CleanupPlan, type CleanupPorts, type CleanupRuntime, type GitCleanupObservation } from "../service/worktree-cleanup"

const head = "a".repeat(40)
const landedHead = "b".repeat(40)
const plan: CleanupPlan = {
  taskId: "search", targetDirectory: "/repo/worktrees/search", sourceDirectory: "/repo/source", evidenceDirectory: "/evidence/search",
  branch: "fm/search", head, landedHead, workerSessionId: "ses_cleanup", coordinatorSessionId: "ses_mate",
  authorization: { kind: "verified-landing", reference: "reports/search.md: verified merged PR" },
}

function fixture() {
  let observation: GitCleanupObservation = {
    directory: plan.targetDirectory, sourceDirectory: plan.sourceDirectory, sourceHead: landedHead,
    task: { id: plan.taskId, directory: plan.targetDirectory, branch: plan.branch },
    exists: true, registered: true, branchHead: head, worktreeHead: head, worktreeBranch: plan.branch,
    tracked: [], untracked: [], ignored: [], content: "ancestor", landingVerified: true, protectedBranches: ["main"],
  }
  const calls: string[] = []
  let state = "source/unrelated worktrees/evidence/bundle unchanged"
  let handles = [{ pid: 101, runtimePid: 11, idleForTarget: true }, { pid: 202, runtimePid: 22, idleForTarget: true }]
  let complete = true
  let active: string[] = []
  let scope = plan.targetDirectory
  let pending: string[] = []
  let failDisposal = false
  let restart = false
  const loaded = new Map([[11, [plan.targetDirectory]], [22, [plan.targetDirectory]]])
  function runtime(pid: number): CleanupRuntime {
    return {
      identity: { pid, version: "2.test", url: `http://127.0.0.1:${pid}` },
      disposalContract: { operationId: "debug.location.evict", method: "DELETE", locationParameter: "location[directory]", successStatus: 204 },
      inspect: async () => { calls.push(`global:${pid}`); return { identity: { pid: restart ? pid + 1 : pid, version: "2.test", url: `http://127.0.0.1:${pid}` }, loadedLocations: [...loaded.get(pid)], activeLocations: active, activityKnown: true } },
      inspectLocation: async (directory) => { calls.push(`scoped:${pid}:${directory}`); return { directory: scope, activeSessions: [], pendingRequests: pending, queuedWork: [], commands: [], terminals: [] } },
      dispose: async (directory) => {
        calls.push(`evict:${pid}:${directory}`)
        if (failDisposal) throw new Error("disposal unavailable")
        loaded.set(pid, loaded.get(pid).filter((entry) => entry !== directory))
        handles = handles.filter((entry) => entry.runtimePid !== pid)
        return { operationId: "debug.location.evict", directory, status: 204 }
      },
    }
  }
  const runtimes = [runtime(11), runtime(22)]
  const ports: CleanupPorts = {
    canonicalize: async (directory) => directory,
    worker: async () => ({ sessionId: "ses_cleanup", directory: "/repo/source", cwd: "/repo/source", known: true }),
    inspectGit: async () => ({ ...observation }),
    protectedState: async () => state,
    discover: async () => { calls.push("discover"); return { complete, runtimes, handles: [...handles] } },
    git: async (args) => {
      calls.push(`git:${args.join(" ")}`)
      if (args.includes("worktree")) observation = { ...observation, exists: false, registered: false, worktreeHead: undefined }
      else observation = { ...observation, branchHead: undefined }
      return { code: 0 }
    },
    record: async (receipt) => { calls.push(`record:${receipt.phase}`) },
  }
  return {
    ports, calls, runtimes, loaded,
    changeGit(value: Partial<GitCleanupObservation>) { observation = { ...observation, ...value } },
    setComplete(value: boolean) { complete = value },
    setActive(value: string[]) { active = value },
    setScope(value: string) { scope = value },
    setPending(value: string[]) { pending = value },
    failDisposal() { failDisposal = true },
    restart() { restart = true },
    changeProtectedState() { state = "changed" },
    setHandles(value: typeof handles) { handles = value },
  }
}

describe("worker-owned authorized worktree cleanup", () => {
  test("releases idle tooling in every runtime, then removes only the owned worktree and local branch without force", async () => {
    const { ports, calls, loaded } = fixture()
    const result = await cleanupTaskWorktree(plan, ports)
    expect(result.status).toBe("removed")
    expect(result.released).toHaveLength(2)
    expect(loaded.get(11)).toEqual([])
    expect(calls.filter((call) => call.startsWith("git:"))).toEqual([
      `git:--no-optional-locks -C /repo/source worktree remove -- ${plan.targetDirectory}`,
      "git:--no-optional-locks -C /repo/source branch -d -- fm/search",
    ])
    const firstEviction = calls.findIndex((call) => call.startsWith("evict:"))
    expect(calls.slice(firstEviction).some((call) => call.startsWith("scoped:"))).toBe(false)
    expect(calls.some((call) => /kill|restart|interrupt|--force|branch -D|push/.test(call))).toBe(false)
    expect((await cleanupTaskWorktree(plan, ports)).status).toBe("already-clean")
    expect(calls.filter((call) => call.startsWith("git:"))).toHaveLength(2)
  })

  test.each([
    { tracked: ["modified.txt"] }, { untracked: ["notes.txt"] }, { ignored: ["cache"] },
    { content: "unique" }, { content: "unknown" }, { branchHead: "c".repeat(40) },
    { worktreeBranch: "other-task" },
    { protectedBranches: [plan.branch] }, { protectedBranches: undefined },
    { landingVerified: false }, { task: { id: "other", directory: plan.targetDirectory, branch: plan.branch } },
  ] as Partial<GitCleanupObservation>[]) ("retains dirty, unlanded, moved-head or unowned work: %j", async (change) => {
    const { ports, calls, changeGit } = fixture()
    changeGit(change)
    const result = await cleanupTaskWorktree(plan, ports)
    expect(result.status).toBe("retained")
    expect(result.blocker).toBeTruthy()
    expect(calls.some((call) => call.startsWith("evict:") || call.startsWith("git:"))).toBe(false)
  })

  test("a finished turn without cleanup authorization never disposes or deletes anything", async () => {
    const { ports, calls } = fixture()
    expect((await cleanupTaskWorktree({ ...plan, authorization: undefined }, ports)).status).toBe("retained")
    expect(calls).toHaveLength(0)
  })

  test.each(["active", "pending", "uncertain", "wrong-directory", "unknown-owner"]) ("retains %s targets", async (condition) => {
    const environment = fixture()
    if (condition === "active") environment.setActive([plan.targetDirectory])
    if (condition === "pending") environment.setPending(["permission"])
    if (condition === "uncertain") environment.setComplete(false)
    if (condition === "wrong-directory") environment.setScope("/repo/unrelated")
    if (condition === "unknown-owner") environment.setHandles([{ pid: 999, runtimePid: 999, idleForTarget: true }])
    const result = await cleanupTaskWorktree(plan, environment.ports)
    expect(result.status).toBe("retained")
    expect(environment.calls.some((call) => call.startsWith("evict:") || call.startsWith("git:"))).toBe(false)
  })

  test("checks every runtime before any disposal, so a later active runtime blocks the entire target", async () => {
    const { ports, calls, runtimes } = fixture()
    const original = runtimes[1].inspectLocation
    runtimes[1].inspectLocation = async (directory) => ({ ...await original(directory), terminals: ["active terminal"] })
    expect((await cleanupTaskWorktree(plan, ports)).status).toBe("retained")
    expect(calls.some((call) => call.startsWith("evict:"))).toBe(false)
  })

  test("disposes loaded descendants with separator boundaries and preserves similarly prefixed unrelated locations", async () => {
    const { ports, calls, loaded } = fixture()
    loaded.set(11, [plan.targetDirectory, `${plan.targetDirectory}/nested`, `${plan.targetDirectory}-keep`])
    const original = ports.discover
    ports.discover = async () => {
      const discovered = await original()
      for (const runtime of discovered.runtimes) runtime.inspectLocation = async (directory) => ({ directory, activeSessions: [], pendingRequests: [], queuedWork: [], commands: [], terminals: [] })
      return discovered
    }
    expect((await cleanupTaskWorktree(plan, ports)).status).toBe("removed")
    expect(loaded.get(11)).toEqual([`${plan.targetDirectory}-keep`])
    expect(calls.indexOf(`evict:11:${plan.targetDirectory}/nested`)).toBeLessThan(calls.indexOf(`evict:11:${plan.targetDirectory}`))
  })

  test("failed disposal preserves Git state and a fresh invocation safely finishes partial release", async () => {
    const { ports, calls, runtimes } = fixture()
    const dispose = runtimes[1].dispose
    runtimes[1].dispose = async () => { throw new Error("unavailable") }
    expect((await cleanupTaskWorktree(plan, ports)).status).toBe("retained")
    expect(calls.some((call) => call.startsWith("git:"))).toBe(false)
    runtimes[1].dispose = dispose
    expect((await cleanupTaskWorktree(plan, ports)).status).toBe("removed")
    expect(calls.filter((call) => call === `evict:11:${plan.targetDirectory}`)).toHaveLength(1)
  })

  test.each(["before", "after"]) ("a runtime restart %s disposal requires fresh discovery, not cached clearance", async (phase) => {
    const environment = fixture()
    if (phase === "before") environment.restart()
    else {
      const dispose = environment.runtimes[1].dispose
      environment.runtimes[1].dispose = async (directory) => { const result = await dispose(directory); environment.restart(); return result }
    }
    expect((await cleanupTaskWorktree(plan, environment.ports)).status).toBe("retained")
    expect(environment.calls.some((call) => call.startsWith("git:"))).toBe(false)
  })

  test("retains the target if handles reappear or protected source/artifact state changes after release", async () => {
    for (const condition of ["handles", "protected"] as const) {
      const environment = fixture()
      const dispose = environment.runtimes[1].dispose
      environment.runtimes[1].dispose = async (directory) => {
        const result = await dispose(directory)
        if (condition === "handles") environment.setHandles([{ pid: 999, runtimePid: 22, idleForTarget: true }])
        else environment.changeProtectedState()
        return result
      }
      expect((await cleanupTaskWorktree(plan, environment.ports)).status).toBe("retained")
      expect(environment.calls.some((call) => call.startsWith("git:"))).toBe(false)
    }
  })

  test("worker session and command cwd must be outside the target before discovery", async () => {
    const { ports, calls } = fixture()
    ports.worker = async () => ({ sessionId: "ses_cleanup", directory: plan.targetDirectory, cwd: "/repo/source", known: true })
    expect((await cleanupTaskWorktree(plan, ports)).status).toBe("retained")
    expect(calls.some((call) => call === "discover")).toBe(false)
  })

  test.each(["activeSessions", "pendingRequests", "queuedWork", "commands", "terminals"]) ("a nonempty or unknown %s result blocks disposal", async (field) => {
    for (const value of [["busy"], undefined]) {
      const { ports, runtimes, calls } = fixture()
      const observe = runtimes[0].inspectLocation
      runtimes[0].inspectLocation = async (directory) => ({ ...await observe(directory), [field]: value })
      expect((await cleanupTaskWorktree(plan, ports)).status).toBe("retained")
      expect(calls.some((call) => call.startsWith("evict:") || call.startsWith("git:"))).toBe(false)
    }
  })

  test("a refused non-forced branch deletion reports partial cleanup without claiming success or retrying", async () => {
    const { ports, calls } = fixture()
    const git = ports.git
    ports.git = async (args) => args.includes("branch") ? { code: 1 } : git(args)
    const result = await cleanupTaskWorktree(plan, ports)
    expect(result.status).toBe("retained")
    expect(result.worktreeRemoved).toBe(true)
    expect(result.branchRemoved).toBe(false)
    expect(result.retainedPaths).toEqual(["refs/heads/fm/search"])
    expect(result.blocker).toContain("non-forced local branch deletion failed")
    expect(calls.some((call) => /--force|branch -D|push/.test(call))).toBe(false)
  })

  test.each([200, 500]) ("a disposal status of %s isn't clearance", async (status) => {
    const { ports, runtimes, calls } = fixture()
    runtimes[0].dispose = async (directory) => ({ operationId: "debug.location.evict", directory, status })
    expect((await cleanupTaskWorktree(plan, ports)).status).toBe("retained")
    expect(calls.some((call) => call.startsWith("git:"))).toBe(false)
  })

  test("duplicate loaded-location entries don't repeat disposal", async () => {
    const { ports, loaded, calls } = fixture()
    loaded.set(11, [plan.targetDirectory, plan.targetDirectory])
    expect((await cleanupTaskWorktree(plan, ports)).status).toBe("removed")
    expect(calls.filter((call) => call === `evict:11:${plan.targetDirectory}`)).toHaveLength(1)
  })

  test("mapping a handle to a runtime isn't itself proof that the owner is idle for this target", async () => {
    const { ports, calls, setHandles } = fixture()
    setHandles([{ pid: 101, runtimePid: 11, idleForTarget: false }])
    const result = await cleanupTaskWorktree(plan, ports)
    expect(result.status).toBe("retained")
    expect(result.blocker).toContain("idle state cannot be verified")
    expect(calls.some((call) => call.startsWith("evict:") || call.startsWith("git:"))).toBe(false)
  })

  test("an unsupported or undiscovered disposal contract blocks every owner before release", async () => {
    const { ports, calls, runtimes } = fixture()
    runtimes[1].disposalContract = undefined
    expect((await cleanupTaskWorktree(plan, ports)).status).toBe("retained")
    expect(calls.some((call) => call.startsWith("evict:") || call.startsWith("git:"))).toBe(false)
  })
})
