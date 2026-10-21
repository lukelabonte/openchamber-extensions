#!/usr/bin/env node
import { spawn } from "node:child_process"
import { readFile, stat } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import type { ExecRunner } from "./control-client"
import type { FileSystemPort } from "./file-system"
import { discoverSupport, type HttpFetcher } from "./interrupt"
import { resolveProjectHomeDirectory } from "./launch"
import { cleanupCoordinatorPullRequests } from "./pr-cleanup"
import { loadRegistry } from "./registry"

const helpText = `Usage: cleanup-pr-links [--help]

Run from the registered FirstMate home. Remove only eligible merged PR links
from that project's current first mate. No session or URL override is accepted.
Saved evidence, worker links, sessions, worktrees, and branches stay intact.
The JSON result lists confirmed removals, not proof that all cleanup is done.
`

export async function runPullRequestCleanup(argumentsList: readonly string[], ports: {
  filesystem: FileSystemPort
  homeRoot: string
  settingsPath: string
  cwd(): string
  exec: ExecRunner
  fetcher: HttpFetcher
}): Promise<string> {
  if (argumentsList.length === 1 && argumentsList[0] === "--help") return helpText
  if (argumentsList.length !== 0) throw new Error("PR cleanup accepts no arguments except --help")
  const registrations = Object.values(await loadRegistry(ports.filesystem, ports.homeRoot))
  const matches = registrations.filter((entry) => path.resolve(entry.homeDirectory) === path.resolve(ports.cwd()))
  if (matches.length !== 1 || path.resolve(matches[0].homeDirectory) !== resolveProjectHomeDirectory(ports.homeRoot, matches[0].slug)) {
    throw new Error("run PR cleanup from exactly one registered FirstMate home")
  }
  const registration = matches[0]
  const unlinked = await cleanupCoordinatorPullRequests({ ...ports, registration, support: await discoverSupport({ filesystem: ports.filesystem, settingsPath: ports.settingsPath }) })
  return `${JSON.stringify({ coordinatorSessionId: registration.coordinatorSessionId, unlinked, note: "Other links may remain unresolved or intentionally retained. No repository cleanup was performed." })}\n`
}

const unavailable = async () => { throw new Error("PR cleanup does not write filesystem records") }
const filesystem: FileSystemPort = {
  exists: async (filePath) => { try { await stat(filePath); return true } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return false; throw error } },
  readFile: (filePath) => readFile(filePath, "utf8"),
  writeFile: unavailable, appendFile: unavailable, createDirectory: unavailable, rename: unavailable,
  listDirectories: unavailable, listExecutableFiles: unavailable, setExecutable: unavailable,
}
const exec: ExecRunner = (command, argumentsList) => new Promise((resolve, reject) => {
  if (command !== "gh") { reject(new Error("PR cleanup can run only GitHub reads")); return }
  const child = spawn(command, [...argumentsList], { shell: false, stdio: ["ignore", "pipe", "pipe"] })
  const output: Buffer[] = []
  child.stdout.on("data", (chunk: Buffer) => output.push(chunk))
  // Avoid exposing auth or transport details from the host CLI in reports.
  child.stderr.resume()
  child.on("error", () => reject(new Error("GitHub CLI could not be started")))
  child.on("close", (code) => code === 0 ? resolve(Buffer.concat(output).toString("utf8")) : reject(new Error(`GitHub read failed with exit code ${code}`)))
})

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const homeRoot = process.env.FIRSTMATE_HOME ?? path.join(homedir(), ".config", "firstmate")
  void runPullRequestCleanup(process.argv.slice(2), {
    filesystem, homeRoot, cwd: () => process.cwd(), exec, fetcher: (url, init) => fetch(url, init),
    settingsPath: process.env.FIRSTMATE_OPENCHAMBER_SETTINGS ?? path.join(homedir(), ".config", "openchamber", "settings.json"),
  }).then((output) => process.stdout.write(output)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "PR cleanup failed"}\n`)
    process.exitCode = 1
  })
}
