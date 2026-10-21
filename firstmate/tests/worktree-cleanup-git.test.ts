import { afterEach, describe, expect, test } from "bun:test"
import { execFileSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createHash } from "node:crypto"
import os from "node:os"
import path from "node:path"
import { cleanupTaskWorktree, type CleanupPlan, type CleanupPorts } from "../service/worktree-cleanup"

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), "firstmate-cleanup-git-")))
  roots.push(root)
  const sourceDirectory = path.join(root, "source")
  const targetDirectory = path.join(root, "task")
  const evidenceDirectory = path.join(root, "evidence")
  mkdirSync(sourceDirectory)
  mkdirSync(evidenceDirectory)
  function git(...args: string[]): string { return execFileSync("git", ["--no-optional-locks", "-C", sourceDirectory, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim() }
  git("init", "--initial-branch=main")
  git("config", "user.name", "Cleanup Fixture")
  git("config", "user.email", "cleanup@example.invalid")
  writeFileSync(path.join(sourceDirectory, ".gitignore"), "ignored/\n")
  writeFileSync(path.join(sourceDirectory, "source.txt"), "protected source\n")
  git("add", ".")
  git("commit", "-m", "Seed fixture")
  const head = git("rev-parse", "HEAD")
  git("worktree", "add", "-b", "fm/task", targetDirectory, head)
  const plan: CleanupPlan = { taskId: "task", sourceDirectory, targetDirectory, evidenceDirectory, branch: "fm/task", head, landedHead: head, workerSessionId: "ses_worker", coordinatorSessionId: "ses_mate", authorization: { kind: "explicit-cleanup", reference: "fixture captain-approved cleanup brief" } }
  let loaded = true
  let disposed = 0
  const identity = { pid: 100, version: "fixture", url: "http://127.0.0.1:12345" }
  const ports: CleanupPorts = {
    canonicalize: async (directory) => existsSync(directory) ? realpathSync(directory) : path.join(realpathSync(path.dirname(directory)), path.basename(directory)),
    worker: async () => ({ sessionId: "ses_worker", directory: sourceDirectory, cwd: sourceDirectory, known: true }),
    protectedState: async () => JSON.stringify({ head: git("rev-parse", "HEAD"), status: git("status", "--porcelain=v1", "--untracked-files=all", "--ignored"), index: createHash("sha256").update(readFileSync(path.join(sourceDirectory, ".git", "index"))).digest("hex"), stash: git("stash", "list"), source: readFileSync(path.join(sourceDirectory, "source.txt"), "utf8") }),
    inspectGit: async () => {
      let branchHead: string
      try { branchHead = git("rev-parse", "--verify", "refs/heads/fm/task") } catch { branchHead = undefined }
      const exists = existsSync(targetDirectory)
      const status = exists ? execFileSync("git", ["--no-optional-locks", "-C", targetDirectory, "status", "--porcelain=v1", "--untracked-files=all", "--ignored"], { encoding: "utf8" }).split("\n").filter(Boolean) : []
      return {
        directory: targetDirectory, sourceDirectory, sourceHead: git("rev-parse", "HEAD"), task: { id: "task", directory: targetDirectory, branch: "fm/task" },
        exists, registered: git("worktree", "list", "--porcelain").split("\n").includes(`worktree ${targetDirectory}`), branchHead,
        worktreeHead: exists ? execFileSync("git", ["-C", targetDirectory, "rev-parse", "HEAD"], { encoding: "utf8" }).trim() : undefined,
        worktreeBranch: exists ? execFileSync("git", ["-C", targetDirectory, "symbolic-ref", "--short", "HEAD"], { encoding: "utf8" }).trim() : undefined,
        tracked: status.filter((line) => !line.startsWith("??") && !line.startsWith("!!")), untracked: status.filter((line) => line.startsWith("??")), ignored: status.filter((line) => line.startsWith("!!")),
        content: git("merge-base", head, plan.landedHead) === head ? "ancestor" : "unique", landingVerified: false, protectedBranches: ["main"],
      }
    },
    discover: async () => ({ complete: true, handles: loaded ? [{ pid: 101, runtimePid: 100, idleForTarget: true }] : [], runtimes: [{
      identity,
      disposalContract: { operationId: "debug.location.evict", method: "DELETE", locationParameter: "location[directory]", successStatus: 204 },
      inspect: async () => ({ identity, loadedLocations: loaded ? [targetDirectory] : [], activeLocations: [], activityKnown: true }),
      inspectLocation: async (directory) => ({ directory, activeSessions: [], pendingRequests: [], queuedWork: [], commands: [], terminals: [] }),
      dispose: async (directory) => { loaded = false; disposed += 1; return { operationId: "debug.location.evict", directory, status: 204 } },
    }] }),
    git: async (args) => { try { execFileSync("git", [...args], { stdio: ["ignore", "pipe", "pipe"] }); return { code: 0 } } catch { return { code: 1 } } },
    record: async (receipt) => { writeFileSync(path.join(evidenceDirectory, `${receipt.phase}.json`), JSON.stringify(receipt)) },
  }
  return { plan, ports, git, getDisposed: () => disposed }
}

describe("cleanup runner against disposable Git fixtures", () => {
  test("releases fixture tooling, removes the exact worktree/branch, preserves source and evidence, and is idempotent", async () => {
    const { plan, ports, git, getDisposed } = fixture()
    const before = await ports.protectedState()
    expect((await cleanupTaskWorktree(plan, ports)).status).toBe("removed")
    expect(getDisposed()).toBe(1)
    expect(existsSync(plan.targetDirectory)).toBe(false)
    expect(git("branch", "--list", plan.branch)).toBe("")
    expect(await ports.protectedState()).toBe(before)
    expect(existsSync(path.join(plan.evidenceDirectory, "removed.json"))).toBe(true)
    expect((await cleanupTaskWorktree(plan, ports)).status).toBe("already-clean")
    expect(getDisposed()).toBe(1)
  })

  test.each(["tracked", "untracked", "ignored"]) ("preserves a fixture with %s changes before disposing services", async (kind) => {
    const { plan, ports, getDisposed, git } = fixture()
    if (kind === "tracked") writeFileSync(path.join(plan.targetDirectory, "source.txt"), "unique work\n")
    if (kind === "untracked") writeFileSync(path.join(plan.targetDirectory, "notes.txt"), "unique notes\n")
    if (kind === "ignored") { mkdirSync(path.join(plan.targetDirectory, "ignored")); writeFileSync(path.join(plan.targetDirectory, "ignored", "data"), "retained data\n") }
    const result = await cleanupTaskWorktree(plan, ports)
    expect(result.status).toBe("retained")
    expect(result.blocker).toContain(kind)
    expect(existsSync(plan.targetDirectory)).toBe(true)
    expect(git("branch", "--list", plan.branch)).not.toBe("")
    expect(getDisposed()).toBe(0)
  })
})
