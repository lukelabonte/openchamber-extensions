#!/usr/bin/env node
import { spawn } from "node:child_process"
import { constants } from "node:fs"
import { open, realpath, type FileHandle } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { pathToFileURL } from "node:url"
import type { ExecRunner } from "./control-client"
import type { FileSystemPort } from "./file-system"
import { handoffToFirstMate } from "./handoff"

const maximumRequestBytes = 12_000
const helpText = `Usage: tell [--dir PATH] [--session ID] [--stdin] [--] request words

Relay a work request to the registered FirstMate for PATH (default: cwd),
or the project that records PATH as a worktree. No other project is inferred.
--stdin       Read exact UTF-8 text from stdin, up to 12,000 bytes.
--session ID  Label the origin as a session claimed by the sender.
--help        Show this help without reading files, stdin, or running commands.

Requests are not merge approval; a durable captain-approval hold remains required.
`

export type TellArguments = { help: true } | { help: false; directory?: string; sessionId?: string; stdin: boolean; words: string[] }

export interface TellPorts {
  filesystem: FileSystemPort
  exec: ExecRunner
  cwd(): string
  homeRoot(): string
  stdin(): AsyncIterable<Uint8Array>
}

export function parseTellArguments(argumentsList: readonly string[]): TellArguments {
  const parsed: Exclude<TellArguments, { help: true }> = { help: false, stdin: false, words: [] }
  let help = false
  let positionalOnly = false
  for (let index = 0; index < argumentsList.length; index += 1) {
    const argument = argumentsList[index]
    if (!positionalOnly && argument === "--") {
      positionalOnly = true
    } else if (!positionalOnly && argument === "--help") {
      help = true
    } else if (!positionalOnly && (argument === "--dir" || argument === "--session")) {
      const value = argumentsList[index + 1]
      if (value === undefined || value.startsWith("-") || value.trim() === "" || value.includes("\0")) throw new Error(`${argument} needs a non-empty value.`)
      const key = argument === "--dir" ? "directory" : "sessionId"
      if (parsed[key] !== undefined) throw new Error(`${argument} can be supplied only once.`)
      parsed[key] = value
      index += 1
    } else if (!positionalOnly && argument === "--stdin") {
      if (parsed.stdin) throw new Error("--stdin can be supplied only once.")
      parsed.stdin = true
    } else if (!positionalOnly && argument.startsWith("-")) {
      throw new Error(`Unknown option: ${argument}. Use --help for usage or -- before literal request words.`)
    } else {
      parsed.words.push(argument)
    }
  }
  if (help) return { help: true }
  if (parsed.stdin && parsed.words.length > 0) throw new Error("Use either --stdin or positional request words, not both.")
  return parsed
}

export async function readTellStdin(stdin: AsyncIterable<Uint8Array>): Promise<string> {
  const chunks: Buffer[] = []
  let totalBytes = 0
  for await (const chunk of stdin) {
    totalBytes += chunk.byteLength
    if (totalBytes > maximumRequestBytes) throw new Error("A FirstMate handoff can contain at most 12,000 UTF-8 bytes.")
    chunks.push(Buffer.from(chunk))
  }
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(Buffer.concat(chunks))
  } catch {
    throw new Error("--stdin must contain valid UTF-8 text.")
  }
}

export async function runTell(argumentsList: readonly string[], ports: TellPorts): Promise<string> {
  const argumentsParsed = parseTellArguments(argumentsList)
  if (argumentsParsed.help === true) return helpText
  const text = argumentsParsed.stdin ? await readTellStdin(ports.stdin()) : argumentsParsed.words.join(" ")
  if (text.trim() === "") throw new Error("A FirstMate handoff needs non-empty request text.")
  if (Buffer.byteLength(text, "utf8") > maximumRequestBytes) throw new Error("A FirstMate handoff can contain at most 12,000 UTF-8 bytes.")
  if (text.includes("\0")) throw new Error("A FirstMate handoff cannot contain NUL bytes because the CLI sends it as an argument.")
  const directory = path.resolve(ports.cwd(), argumentsParsed.directory ?? ".")
  await handoffToFirstMate({ filesystem: ports.filesystem, exec: ports.exec, homeRoot: ports.homeRoot(), directory, text, ...(argumentsParsed.sessionId === undefined ? {} : { sessionId: argumentsParsed.sessionId }) })
  return "Request relayed to FirstMate; merge approval is still required.\n"
}

export function createReadonlyFileSystemPort(homeRoot: string): FileSystemPort {
  const root = path.resolve(homeRoot)
  async function openRecord(filePath: string): Promise<FileHandle> {
    const recordPath = path.resolve(filePath)
    const relativePath = path.relative(root, recordPath)
    if (relativePath !== "registry.json" && !/^projects\/[^/]+\/backlog\.md$/.test(relativePath)) throw new Error("FirstMate tell reads only its registry or project backlog files.")
    const [canonicalRoot, canonicalParent] = await Promise.all([realpath(root), realpath(path.dirname(recordPath))])
    if (canonicalParent !== path.dirname(path.join(canonicalRoot, relativePath))) throw new Error("FirstMate tell cannot read a record through a redirected project directory.")
    const file = await open(path.join(canonicalParent, path.basename(recordPath)), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      if (!(await file.stat()).isFile()) throw new Error("A FirstMate registry or backlog must be a regular file.")
      return file
    } catch (error) {
      await file.close()
      throw error
    }
  }
  const unavailable = async () => { throw new Error("FirstMate tell uses a read-only filesystem; this operation is unavailable.") }
  return {
    exists: async (filePath) => {
      try {
        const file = await openRecord(filePath)
        await file.close()
        return true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
        throw error
      }
    },
    readFile: async (filePath) => {
      const file = await openRecord(filePath)
      try {
        return await file.readFile("utf8")
      } finally {
        await file.close()
      }
    },
    writeFile: unavailable,
    appendFile: unavailable,
    createDirectory: unavailable,
    listDirectories: unavailable,
    listExecutableFiles: unavailable,
    setExecutable: unavailable,
    rename: unavailable,
  }
}

const openchamberExec: ExecRunner = (command, args) => new Promise((resolve, reject) => {
  if (command !== "openchamber") {
    reject(new Error("FirstMate tell can run only the openchamber CLI."))
    return
  }
  const child = spawn("openchamber", [...args], { shell: false, stdio: ["ignore", "pipe", "pipe"] })
  const stdoutChunks: Buffer[] = []
  const stderrChunks: Buffer[] = []
  child.stdout.on("data", (chunk: Buffer) => stdoutChunks.push(chunk))
  child.stderr.on("data", (chunk: Buffer) => stderrChunks.push(chunk))
  child.on("error", (error) => reject(new Error(`Could not run openchamber: ${error.message}`)))
  child.on("close", (code, signal) => {
    if (code === 0) {
      resolve(Buffer.concat(stdoutChunks).toString("utf8"))
    } else {
      const detail = Buffer.concat(stderrChunks).toString("utf8").trim()
      reject(new Error(`openchamber exited ${signal === null ? `with code ${code}` : `after ${signal}`}${detail === "" ? "." : `: ${detail}`}`))
    }
  })
})

async function tellCli(): Promise<void> {
  const argumentsList = process.argv.slice(2)
  if (parseTellArguments(argumentsList).help) {
    process.stdout.write(helpText)
    return
  }
  const homeRoot = process.env.FIRSTMATE_HOME ?? path.join(homedir(), ".config", "firstmate")
  const result = await runTell(argumentsList, {
    filesystem: createReadonlyFileSystemPort(homeRoot), exec: openchamberExec,
    homeRoot: () => homeRoot, cwd: () => process.cwd(), stdin: () => process.stdin,
  })
  process.stdout.write(result)
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  void tellCli().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : "FirstMate handoff failed."}\n`)
    process.exitCode = 1
  })
}
