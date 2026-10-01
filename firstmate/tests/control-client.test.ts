import { describe, expect, test } from "bun:test"
import { createSession, MissingCliError, type ExecRunner } from "../service/control-client"

interface ExecCall {
  command: string
  args: string[]
}

function fakeExec(stdout: string): { exec: ExecRunner; calls: ExecCall[] } {
  const calls: ExecCall[] = []
  const exec: ExecRunner = async (command, args) => {
    calls.push({ command, args: [...args] })
    return stdout
  }
  return { exec, calls }
}

describe("createSession", () => {
  test("runs openchamber session create rooted at the given directory and returns the session id", async () => {
    const { exec, calls } = fakeExec('{"sessionID":"ses_123"}')

    const sessionId = await createSession(exec, { directory: "/home/firstmate/projects/sunrise", title: "FirstMate — sunrise" })

    expect(sessionId).toBe("ses_123")
    expect(calls).toEqual([
      {
        command: "openchamber",
        args: ["session", "create", "--dir", "/home/firstmate/projects/sunrise", "--title", "FirstMate — sunrise", "--json"],
      },
    ])
  })

  test("accepts the alternate session id key", async () => {
    const { exec } = fakeExec('{"id":"ses_alt"}')

    const sessionId = await createSession(exec, { directory: "/home", title: "FirstMate — t" })

    expect(sessionId).toBe("ses_alt")
  })

  test("fails when the output is not JSON", async () => {
    const { exec } = fakeExec("not json")

    await expect(createSession(exec, { directory: "/home", title: "t" })).rejects.toThrow("valid JSON")
  })

  test("fails when the output carries no session id", async () => {
    const { exec } = fakeExec('{"other":1}')

    await expect(createSession(exec, { directory: "/home", title: "t" })).rejects.toThrow("session id")
  })
})

describe("missing CLI", () => {
  test("translates an ENOENT spawn failure into MissingCliError with plain-language copy", async () => {
    const exec: ExecRunner = async () => {
      throw Object.assign(new Error("spawn openchamber ENOENT"), { code: "ENOENT" })
    }

    await expect(createSession(exec, { directory: "/home", title: "t" })).rejects.toBeInstanceOf(MissingCliError)
  })

  test("the MissingCliError names the CLI and the fix", async () => {
    const exec: ExecRunner = async () => {
      throw Object.assign(new Error("spawn openchamber ENOENT"), { code: "ENOENT" })
    }

    const error = await createSession(exec, { directory: "/home", title: "t" }).then(
      () => undefined,
      (caught: unknown) => caught,
    )

    expect((error as Error).message).toContain("the openchamber CLI is required")
  })

  test("rethrows other exec failures unchanged", async () => {
    const exec: ExecRunner = async () => {
      throw new Error("exit code 1")
    }

    const error = await createSession(exec, { directory: "/home", title: "t" }).then(
      () => undefined,
      (caught: unknown) => caught,
    )

    expect(error).toBeInstanceOf(Error)
    expect(error).not.toBeInstanceOf(MissingCliError)
    expect((error as Error).message).toBe("exit code 1")
  })
})
