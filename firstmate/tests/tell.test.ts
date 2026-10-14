import { describe, expect, test } from "bun:test"
import { createReadonlyFileSystemPort, parseTellArguments, readTellStdin, runTell, type TellPorts } from "../service/tell"
import { InMemoryFileSystem } from "./helpers/in-memory-file-system"

function fixture() {
  const filesystem = new InMemoryFileSystem()
  filesystem.seedFile("/fm/registry.json", JSON.stringify({
    sunrise: { slug: "sunrise", projectDirectory: "/repos/sunrise", homeDirectory: "/fm/projects/sunrise", coordinatorSessionId: "ses_mate", createdAt: "2026-10-13T00:00:00Z" },
    other: { slug: "other", projectDirectory: "/repos/other", homeDirectory: "/fm/projects/other", coordinatorSessionId: "ses_other_mate", createdAt: "2026-10-13T00:00:00Z" },
  }))
  const calls: Array<{ command: string; args: readonly string[] }> = []
  const reads: string[] = []
  const ports: TellPorts = {
    filesystem: { ...filesystem.port,
      exists: async (filePath) => { reads.push(filePath); return filesystem.port.exists(filePath) },
      readFile: async (filePath) => { reads.push(filePath); return filesystem.port.readFile(filePath) },
    },
    exec: async (command, args) => { calls.push({ command, args }); return "{}" },
    cwd: () => "/repos/sunrise",
    homeRoot: () => "/fm",
    stdin: () => (async function* () { yield Buffer.from("  stdin request\nkeep spacing\n") })(),
  }
  return { filesystem, ports, calls, reads }
}

describe("FirstMate terminal relay", () => {
  test("defaults to cwd and joins positional words without interpreting shell text", async () => {
    const { ports, calls } = fixture()
    await runTell(["Review", "$(touch unsafe)", "--", "--literal"], ports)
    expect(calls).toHaveLength(1)
    expect(calls[0].command).toBe("openchamber")
    expect(calls[0].args).toContain("ses_mate")
    const prompt = calls[0].args[calls[0].args.indexOf("--prompt") + 1]
    expect(prompt.endsWith("Review $(touch unsafe) --literal")).toBe(true)
    expect(prompt).toContain("a terminal or script")
    expect(prompt).toContain("not merge approval")
    expect(prompt).toContain("durable captain-approval hold")
  })

  test("--dir selects only that project and --session is a claimed origin", async () => {
    const { ports, calls } = fixture()
    await runTell(["--dir", "../other", "--session", "ses_sender", "Review"], ports)
    expect(calls[0].args).toContain("ses_other_mate")
    expect(calls[0].args).toContain("/fm/projects/other")
    const prompt = calls[0].args[calls[0].args.indexOf("--prompt") + 1]
    expect(prompt).toContain("session ses_sender, as claimed by the sender")
    expect(prompt).toContain("/repos/other")
  })

  test("recorded worktrees resolve without inferring a different first project", async () => {
    const { ports, filesystem, calls } = fixture()
    filesystem.seedFile("/fm/projects/other/backlog.md", "- Login\n  state: Working\n  worktree: /worktrees/login\n")
    await runTell(["--dir", "/worktrees/login", "Review"], ports)
    expect(calls[0].args).toContain("ses_other_mate")
  })

  test("unknown directory fails rather than choosing the first registration", async () => {
    const { ports, calls } = fixture()
    await expect(runTell(["--dir", "/repos/unknown", "Review"], ports)).rejects.toThrow("registered")
    expect(calls).toHaveLength(0)
  })

  test("stdin text is byte-for-byte preserved, including trailing newline", async () => {
    const { ports, calls } = fixture()
    await runTell(["--stdin", "--session", "ses_sender"], ports)
    const prompt = calls[0].args[calls[0].args.indexOf("--prompt") + 1]
    expect(prompt.endsWith("  stdin request\nkeep spacing\n")).toBe(true)
  })

  test("--help does not invoke any injected I/O", async () => {
    const unavailable = () => { throw new Error("I/O must not run") }
    const ports = { filesystem: new Proxy({}, { get: unavailable }), exec: unavailable, cwd: unavailable, homeRoot: unavailable, stdin: unavailable } as unknown as TellPorts
    expect(await runTell(["--help"], ports)).toContain("--stdin")
  })

  test.each([
    ["--unknown"], ["--dir"], ["--dir", "--stdin"], ["--session"], ["--session", "--stdin"],
    ["--dir", ""], ["--session", " "], ["--stdin", "ignored text"], ["--dir", "/repos/sunrise", "--dir", "/repos/other", "Review"],
    ["--unknown", "--help"], ["--dir", "--help"],
  ].map((args) => ({ args })))("invalid options fail before any file read or execution", async ({ args }) => {
    const { ports, reads, calls } = fixture()
    await expect(runTell(args, ports)).rejects.toThrow()
    expect(reads).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  test.each([[], [" "], ["é".repeat(6001)], ["invalid\0text"]].map((args) => ({ args })))("invalid positional request fails before reading project homes", async ({ args }) => {
    const { ports, reads, calls } = fixture()
    await expect(runTell(args, ports)).rejects.toThrow()
    expect(reads).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  test("stdin limit rejects early before file reads, without consuming later chunks", async () => {
    const { ports, reads, calls } = fixture()
    let chunksRead = 0
    ports.stdin = () => (async function* () {
      chunksRead += 1
      yield Buffer.alloc(12001, 97)
      chunksRead += 1
      yield Buffer.from("must not consume")
    })()
    await expect(runTell(["--stdin"], ports)).rejects.toThrow("12,000")
    expect(chunksRead).toBe(1)
    expect(reads).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  test("exactly 12,000 UTF-8 bytes are accepted", async () => {
    const { ports, calls } = fixture()
    await runTell(["é".repeat(6000)], ports)
    expect(calls).toHaveLength(1)
  })

  test("stdin decoding handles a multibyte character split between chunks", async () => {
    expect(await readTellStdin((async function* () { yield Uint8Array.of(0xc3); yield Uint8Array.of(0xa9, 10) })())).toBe("é\n")
  })

  test("stdin preserves a UTF-8 BOM instead of silently stripping it", async () => {
    expect(await readTellStdin((async function* () { yield Buffer.from("\ufeffReview\n") })())).toBe("\ufeffReview\n")
  })

  test.each(["", " \n", "invalid\0text"])("invalid stdin text fails before project homes are read", async (text) => {
    const { ports, reads, calls } = fixture()
    ports.stdin = () => (async function* () { yield Buffer.from(text) })()
    await expect(runTell(["--stdin"], ports)).rejects.toThrow()
    expect(reads).toHaveLength(0)
    expect(calls).toHaveLength(0)
  })

  test("invalid UTF-8 fails without reading project homes", async () => {
    const { ports, reads } = fixture()
    ports.stdin = () => (async function* () { yield Uint8Array.of(0xff) })()
    await expect(runTell(["--stdin"], ports)).rejects.toThrow("UTF-8")
    expect(reads).toHaveLength(0)
  })

  test("execution failure is reported without retrying", async () => {
    const { ports } = fixture()
    let executions = 0
    ports.exec = async () => { executions += 1; throw new Error("openchamber missing") }
    await expect(runTell(["Review"], ports)).rejects.toThrow("openchamber missing")
    expect(executions).toBe(1)
  })

  test("argument parsing does not need filesystem or host context", () => {
    expect(parseTellArguments(["--dir", "/repos/sunrise", "--session", "ses_sender", "--stdin"])).toEqual({ help: false, directory: "/repos/sunrise", sessionId: "ses_sender", stdin: true, words: [] })
    expect(parseTellArguments(["--", "--help"])).toEqual({ help: false, stdin: false, words: ["--help"] })
  })

  test("readonly filesystem rejects all writes and unrelated files without I/O", async () => {
    const filesystem = createReadonlyFileSystemPort("/fm")
    await expect(filesystem.writeFile("/fm/registry.json", "{}")).rejects.toThrow("read-only")
    await expect(filesystem.appendFile("/fm/registry.json", "{}")).rejects.toThrow("read-only")
    await expect(filesystem.createDirectory("/fm/projects/new")).rejects.toThrow("read-only")
    await expect(filesystem.rename("/fm/registry.json", "/fm/other.json")).rejects.toThrow("read-only")
    await expect(filesystem.setExecutable("/fm/registry.json")).rejects.toThrow("read-only")
    await expect(filesystem.readFile("/unrelated/config.json")).rejects.toThrow("registry or project backlog")
    await expect(filesystem.exists("/fm/projects/sunrise/charter.md")).rejects.toThrow("registry or project backlog")
  })

  test("standalone --help exits without a host or stdin", async () => {
    const child = Bun.spawn([process.execPath, `${import.meta.dir}/../service/tell.ts`, "--help"], { stdin: "ignore", stdout: "pipe", stderr: "pipe" })
    expect(await child.exited).toBe(0)
    expect(await new Response(child.stdout).text()).toContain("--stdin")
    expect(await new Response(child.stderr).text()).toBe("")
  })
})
