import { describe, expect, test } from "bun:test"
import { launchFirstMate, type LaunchFirstMateInput } from "../service/launch"
import { MissingCliError, type ExecRunner } from "../service/control-client"
import type { HttpFetcher } from "../service/interrupt"
import { InMemoryFileSystem } from "./helpers/in-memory-file-system"

const projectDirectory = "/repos/sunrise"

interface RecordedCall {
  url: string
  init: { method: string; headers: Record<string, string>; body?: string }
}

function recordingFetcher(answer: (call: RecordedCall) => { status: number } | "throw"): {
  fetcher: HttpFetcher
  calls: RecordedCall[]
} {
  const calls: RecordedCall[] = []
  const fetcher: HttpFetcher = async (url, init) => {
    const call: RecordedCall = { url, init }
    calls.push(call)
    const result = answer(call)
    if (result === "throw") throw new Error("connection refused")
    return { status: result.status }
  }
  return { fetcher, calls }
}

const templateContents: Record<string, string> = {
  "charter.md": "SHARED CHARTER",
  "captain.md": "SHARED CAPTAIN",
  "project-charter.md": "PROJECT CHARTER",
  "backlog.md": "# Backlog",
  "projects.md": "# Shipping modes",
  "settings.json": "{}",
}

const templateReader = (templateName: string): Promise<string> => Promise.resolve(templateContents[templateName] ?? "")

function fakeExec(stdout = '{"sessionID":"ses_coord_1"}'): { exec: ExecRunner; calls: { command: string; args: string[] }[] } {
  const calls: { command: string; args: string[] }[] = []
  const exec: ExecRunner = async (command, args) => {
    // These tests count session creation; association has its own assertions below.
    if (args[1] === "associate-project") return JSON.stringify({ sessionId: args[args.indexOf("--session") + 1] })
    calls.push({ command, args: [...args] })
    return stdout
  }
  return { exec, calls }
}

function countingExec(): { exec: ExecRunner; calls: string[][] } {
  let count = 0
  const calls: string[][] = []
  const exec: ExecRunner = async (_command, args) => {
    if (args[1] === "associate-project") return JSON.stringify({ sessionId: args[args.indexOf("--session") + 1] })
    calls.push([...args])
    await new Promise((resolve) => setTimeout(resolve, 10))
    count += 1
    return JSON.stringify({ sessionID: `ses_${count}` })
  }
  return { exec, calls }
}

function makeInput(overrides: Partial<LaunchFirstMateInput> = {}): LaunchFirstMateInput {
  const filesystem = new InMemoryFileSystem()
  const fake = fakeExec()
  return {
    filesystem: filesystem.port,
    exec: fake.exec,
    templateReader,
    homeRoot: "/home/firstmate",
    projectDirectory,
    fetcher: async () => ({ status: 200 }),
    support: { kind: "supported", port: 4096 },
    ...overrides,
  }
}

function registryFileContents(filesystem: InMemoryFileSystem): string {
  return filesystem.fileContents("/home/firstmate/registry.json")
}

describe("launchFirstMate", () => {
  test("associates new and existing first mates with their managed project without moving their home", async () => {
    const input = makeInput()
    const calls: string[][] = []
    input.exec = async (_command, args) => {
      calls.push([...args])
      return JSON.stringify({ sessionId: "ses_coord_1", directory: "/home/firstmate/projects/sunrise", displayProjectDirectory: projectDirectory })
    }

    await launchFirstMate(input)
    await launchFirstMate(input)

    expect(calls.filter((args) => args[1] === "create")).toHaveLength(1)
    expect(calls.filter((args) => args[1] === "associate-project")).toEqual([
      ["session", "associate-project", "--session", "ses_coord_1", "--dir", "/home/firstmate/projects/sunrise", "--display-project-dir", projectDirectory, "--json"],
      ["session", "associate-project", "--session", "ses_coord_1", "--dir", "/home/firstmate/projects/sunrise", "--display-project-dir", projectDirectory, "--json"],
    ])
  })

  test("keeps a created first mate after association failure so retry does not create a duplicate", async () => {
    const input = makeInput()
    let creations = 0
    let associationFails = true
    input.exec = async (_command, args) => {
      if (args[1] === "create") creations += 1
      if (args[1] === "associate-project" && associationFails) throw new Error("host unavailable")
      return '{"sessionId":"ses_coord_1"}'
    }
    await expect(launchFirstMate(input)).rejects.toThrow("is saved, but its sidebar project association failed")
    associationFails = false
    expect((await launchFirstMate(input)).adopted).toBe(true)
    expect(creations).toBe(1)
  })

  test("creates with the captain-edited opening and persisted coordinator model without a separate send", async () => {
    const filesystem = new InMemoryFileSystem()
    filesystem.seedDirectory("/home/firstmate/projects/sunrise")
    filesystem.seedFile("/home/firstmate/projects/sunrise/settings.json", JSON.stringify({ projectDirectory, coordinatorModel: "provider/coordinator", coordinatorVariant: "high", workerModel: "provider/worker", custom: { retained: true } }))
    filesystem.seedFile("/home/firstmate/projects/sunrise/opening.md", "Captain-edited opening\nRead this verbatim.\n")
    const fake = fakeExec()
    await launchFirstMate(makeInput({ filesystem: filesystem.port, exec: fake.exec }))
    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0].args).toContain("--prompt")
    expect(fake.calls[0].args[fake.calls[0].args.indexOf("--prompt") + 1]).toBe("Captain-edited opening\nRead this verbatim.\n")
    expect(fake.calls[0].args[fake.calls[0].args.indexOf("--model") + 1]).toBe("provider/coordinator")
    expect(fake.calls[0].args[fake.calls[0].args.indexOf("--variant") + 1]).toBe("high")
    expect(JSON.parse(filesystem.fileContents("/home/firstmate/projects/sunrise/settings.json"))).toMatchObject({ projectDirectory, custom: { retained: true }, workerModel: "provider/worker", coordinatorSessionId: "ses_coord_1" })
    expect(filesystem.renamedFrom("/home/firstmate/projects/sunrise/settings.json")).toContain(".tmp")
  })

  test("empty openings and blank model settings do not add create flags", async () => {
    const filesystem = new InMemoryFileSystem()
    filesystem.seedDirectory("/home/firstmate/projects/sunrise")
    filesystem.seedFile("/home/firstmate/projects/sunrise/settings.json", JSON.stringify({ projectDirectory, coordinatorModel: "", coordinatorVariant: "" }))
    filesystem.seedFile("/home/firstmate/projects/sunrise/opening.md", " \n")
    const fake = fakeExec()
    await launchFirstMate(makeInput({ filesystem: filesystem.port, exec: fake.exec }))
    for (const flag of ["--prompt", "--model", "--variant"]) expect(fake.calls[0].args).not.toContain(flag)
  })

  test.each(["provider:adaptive/extended", '推論 mode "深い" \\ route', "v".repeat(200), "default", "  provider:adaptive/extended  "])("passes the saved coordinator variant to the actual create path verbatim: %j", async (variant) => {
    const filesystem = new InMemoryFileSystem()
    const settingsPath = "/home/firstmate/projects/sunrise/settings.json"
    filesystem.seedDirectory("/home/firstmate/projects/sunrise")
    filesystem.seedFile(settingsPath, JSON.stringify({ projectDirectory, coordinatorVariant: variant, workerVariant: "worker:separate/variant", custom: true }))
    const fake = fakeExec()

    await launchFirstMate(makeInput({ filesystem: filesystem.port, exec: fake.exec }))

    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0].command).toBe("openchamber")
    expect(fake.calls[0].args).toEqual(["session", "create", "--dir", "/home/firstmate/projects/sunrise", "--title", "FirstMate — sunrise", "--variant", variant, "--json"])
    expect(JSON.parse(filesystem.fileContents(settingsPath))).toMatchObject({ coordinatorVariant: variant, workerVariant: "worker:separate/variant", custom: true })
    expect(filesystem.fileContents("/home/firstmate/projects/sunrise/AGENTS.md")).toContain('Use variant "worker:separate/variant" for new and resumed workers')
  })

  test("a blank coordinator variant stays omitted when a worker variant is configured", async () => {
    const filesystem = new InMemoryFileSystem()
    filesystem.seedDirectory("/home/firstmate/projects/sunrise")
    filesystem.seedFile("/home/firstmate/projects/sunrise/settings.json", JSON.stringify({ projectDirectory, coordinatorVariant: "", workerVariant: "default" }))
    const fake = fakeExec()

    await launchFirstMate(makeInput({ filesystem: filesystem.port, exec: fake.exec }))

    expect(fake.calls).toHaveLength(1)
    expect(fake.calls[0].args).not.toContain("--variant")
    expect(filesystem.fileContents("/home/firstmate/projects/sunrise/AGENTS.md")).toContain('Use variant "default" for new and resumed workers')
  })

  test("recomposes available home layers on adoption without creating another session", async () => {
    const filesystem = new InMemoryFileSystem()
    const fake = fakeExec()
    await launchFirstMate(makeInput({ filesystem: filesystem.port, exec: fake.exec }))
    filesystem.seedFile("/home/firstmate/projects/sunrise/captain.md", "CAPTAIN EDIT")
    await launchFirstMate(makeInput({ filesystem: filesystem.port, exec: fake.exec }))
    expect(filesystem.fileContents("/home/firstmate/projects/sunrise/AGENTS.md")).toContain("CAPTAIN EDIT")
    expect(fake.calls).toHaveLength(1)
  })

  test("recomposes shared-only layers when the registered home exists", async () => {
    const filesystem = new InMemoryFileSystem()
    const fake = fakeExec()
    filesystem.seedDirectory("/home/firstmate/projects/sunrise")
    filesystem.seedFile("/home/firstmate/shared/captain.md", "EDITED SHARED CAPTAIN")
    filesystem.seedFile("/home/firstmate/registry.json", JSON.stringify({ sunrise: { slug: "sunrise", projectDirectory, homeDirectory: "/home/firstmate/projects/sunrise", coordinatorSessionId: "ses_existing", createdAt: "2026-01-01T00:00:00.000Z" } }))
    await launchFirstMate(makeInput({ filesystem: filesystem.port, exec: fake.exec }))
    expect(filesystem.fileContents("/home/firstmate/projects/sunrise/AGENTS.md")).toContain("EDITED SHARED CAPTAIN")
    expect(fake.calls).toHaveLength(0)
  })

  test("does not adopt a stale registry ID after a persisted release", async () => {
    const filesystem = new InMemoryFileSystem()
    const fake = fakeExec()
    await launchFirstMate(makeInput({ filesystem: filesystem.port, exec: fake.exec }))
    filesystem.seedFile("/home/firstmate/projects/sunrise/settings.json", JSON.stringify({ projectDirectory, coordinatorReleased: true, coordinatorSessionId: "ses_coord_1" }))
    const fresh = fakeExec('{"sessionId":"ses_fresh"}')
    const result = await launchFirstMate(makeInput({ filesystem: filesystem.port, exec: fresh.exec }))
    expect(result.adopted).toBe(false)
    expect(result.registration.coordinatorSessionId).toBe("ses_fresh")
    expect(fresh.calls).toHaveLength(1)
  })

  test("refuses corrupt existing settings rather than adopting or overwriting", async () => {
    const filesystem = new InMemoryFileSystem()
    const fake = fakeExec()
    await launchFirstMate(makeInput({ filesystem: filesystem.port, exec: fake.exec }))
    filesystem.seedFile("/home/firstmate/projects/sunrise/settings.json", "not JSON")
    await expect(launchFirstMate(makeInput({ filesystem: filesystem.port, exec: fake.exec }))).rejects.toThrow("settings")
    expect(filesystem.fileContents("/home/firstmate/projects/sunrise/settings.json")).toBe("not JSON")
    expect(fake.calls).toHaveLength(1)
  })

  test("provisions the home, creates the coordinator session rooted at the home, and records the registration", async () => {
    const filesystem = new InMemoryFileSystem()
    const fake = fakeExec()
    const input = makeInput({ filesystem: filesystem.port, exec: fake.exec })

    const result = await launchFirstMate(input)

    expect(result.adopted).toBe(false)
    expect(result.registration.slug).toBe("sunrise")
    expect(result.registration.projectDirectory).toBe(projectDirectory)
    expect(result.registration.homeDirectory).toBe("/home/firstmate/projects/sunrise")
    expect(result.registration.coordinatorSessionId).toBe("ses_coord_1")
    expect(() => new Date(result.registration.createdAt)).not.toThrow()

    const homeDirectoryArgs = fake.calls
      .map((call) => call.args)
      .filter((args) => args.includes("--dir"))
      .map((args) => args[args.indexOf("--dir") + 1])
    expect(homeDirectoryArgs).toEqual(["/home/firstmate/projects/sunrise"])
    expect(fake.calls[0]?.command).toBe("openchamber")

    const persisted = JSON.parse(registryFileContents(filesystem)) as Record<string, unknown>
    expect(persisted["sunrise"]).toEqual(result.registration)
    const settings = JSON.parse(filesystem.fileContents("/home/firstmate/projects/sunrise/settings.json")) as Record<
      string,
      unknown
    >
    expect(settings.coordinatorSessionId).toBe("ses_coord_1")
    expect(filesystem.fileContents("/home/firstmate/projects/sunrise/AGENTS.md")).toContain("SHARED CHARTER")
  })

  test("adopts an existing registration on relaunch instead of creating another session", async () => {
    const filesystem = new InMemoryFileSystem()
    const fake = fakeExec()
    await launchFirstMate(makeInput({ filesystem: filesystem.port, exec: fake.exec }))

    const result = await launchFirstMate(makeInput({ filesystem: filesystem.port, exec: fake.exec, projectDirectory: `${projectDirectory}/` }))

    expect(result.adopted).toBe(true)
    expect(result.registration.coordinatorSessionId).toBe("ses_coord_1")
    expect(fake.calls).toHaveLength(1)
  })

  test("adopts an existing registration when launched with the first mate's home directory", async () => {
    const filesystem = new InMemoryFileSystem()
    const fake = fakeExec()
    filesystem.seedFile(
      "/home/firstmate/registry.json",
      JSON.stringify({
        sunrise: {
          slug: "sunrise",
          projectDirectory,
          homeDirectory: "/home/firstmate/projects/sunrise",
          coordinatorSessionId: "ses_existing",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    )

    const result = await launchFirstMate(
      makeInput({ filesystem: filesystem.port, exec: fake.exec, projectDirectory: "/home/firstmate/projects/sunrise" }),
    )

    expect(result.adopted).toBe(true)
    expect(result.registration.coordinatorSessionId).toBe("ses_existing")
    expect(fake.calls).toHaveLength(0)
  })

  test("two concurrent launches for one project create only one session", async () => {
    const filesystem = new InMemoryFileSystem()
    const fake = countingExec()

    const [first, second] = await Promise.all([
      launchFirstMate(makeInput({ filesystem: filesystem.port, exec: fake.exec })),
      launchFirstMate(makeInput({ filesystem: filesystem.port, exec: fake.exec, projectDirectory: `${projectDirectory}/` })),
    ])

    expect(first.registration.coordinatorSessionId).toBe("ses_1")
    expect(second.registration.coordinatorSessionId).toBe("ses_1")
    expect(second.adopted).toBe(true)
    expect(fake.calls).toHaveLength(1)
  })

  test("adopts a registration persisted by a previous run without exec'ing the CLI", async () => {
    const filesystem = new InMemoryFileSystem()
    const fake = fakeExec()
    filesystem.seedFile(
      "/home/firstmate/registry.json",
      JSON.stringify({
        sunrise: {
          slug: "sunrise",
          projectDirectory,
          homeDirectory: "/home/firstmate/projects/sunrise",
          coordinatorSessionId: "ses_existing",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    )

    const result = await launchFirstMate(makeInput({ filesystem: filesystem.port, exec: fake.exec }))

    expect(result.adopted).toBe(true)
    expect(result.registration.coordinatorSessionId).toBe("ses_existing")
    expect(fake.calls).toHaveLength(0)
  })

  test("adopts the session recorded in the home settings.json when the registry was lost", async () => {
    const filesystem = new InMemoryFileSystem()
    const fake = fakeExec()
    // The home directory must exist as a node: listDirectories sees only
    // directory-kind entries, and provision skips writeSettingsAssociation
    // only when it matches this home through that listing.
    filesystem.seedDirectory("/home/firstmate/projects/sunrise")
    filesystem.seedFile(
      "/home/firstmate/projects/sunrise/settings.json",
      JSON.stringify({ projectDirectory, coordinatorSessionId: "ses_prior" }),
    )

    const result = await launchFirstMate(makeInput({ filesystem: filesystem.port, exec: fake.exec }))

    expect(result.adopted).toBe(true)
    expect(result.registration.coordinatorSessionId).toBe("ses_prior")
    expect(fake.calls).toHaveLength(0)
    const persisted = JSON.parse(registryFileContents(filesystem)) as Record<string, Record<string, unknown>>
    expect(persisted.sunrise?.coordinatorSessionId).toBe("ses_prior")
  })

  test("records nothing when the openchamber CLI is missing", async () => {
    const filesystem = new InMemoryFileSystem()
    const input = makeInput({
      filesystem: filesystem.port,
      exec: async () => {
        throw Object.assign(new Error("spawn openchamber ENOENT"), { code: "ENOENT" })
      },
    })

    await expect(launchFirstMate(input)).rejects.toBeInstanceOf(MissingCliError)
    expect(await filesystem.port.exists("/home/firstmate/registry.json")).toBe(false)
  })

  test("sets the coordinator session to auto-accept permissions on the create path", async () => {
    const { fetcher, calls } = recordingFetcher(() => ({ status: 200 }))

    await launchFirstMate(makeInput({ fetcher, support: { kind: "supported", port: 4096 } }))

    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe("http://127.0.0.1:4096/api/permission-auto-accept/sessions/ses_coord_1")
    expect(calls[0].init.method).toBe("PUT")
    expect(calls[0].init.body).toBe(JSON.stringify({ mode: "auto", directory: "/home/firstmate/projects/sunrise" }))
  })

  test("sets the adopted coordinator session to auto-accept on both adoption paths", async () => {
    // Registry adoption: the registration already exists, no session is created.
    const adopted = new InMemoryFileSystem()
    adopted.seedFile(
      "/home/firstmate/registry.json",
      JSON.stringify({
        sunrise: {
          slug: "sunrise",
          projectDirectory,
          homeDirectory: "/home/firstmate/projects/sunrise",
          coordinatorSessionId: "ses_existing",
          createdAt: "2026-01-01T00:00:00.000Z",
        },
      }),
    )
    const { fetcher: adoptedFetcher, calls: adoptedCalls } = recordingFetcher(() => ({ status: 200 }))
    const registryAdoption = await launchFirstMate(
      makeInput({ filesystem: adopted.port, fetcher: adoptedFetcher, support: { kind: "supported", port: 4096 } }),
    )
    expect(registryAdoption.adopted).toBe(true)
    expect(adoptedCalls).toHaveLength(1)
    expect(adoptedCalls[0].url).toBe("http://127.0.0.1:4096/api/permission-auto-accept/sessions/ses_existing")
    expect(adoptedCalls[0].init.body).toBe(JSON.stringify({ mode: "auto", directory: "/home/firstmate/projects/sunrise" }))

    // Home-settings adoption: the registry was lost but the home remembers.
    const remembered = new InMemoryFileSystem()
    remembered.seedDirectory("/home/firstmate/projects/sunrise")
    remembered.seedFile(
      "/home/firstmate/projects/sunrise/settings.json",
      JSON.stringify({ projectDirectory, coordinatorSessionId: "ses_prior" }),
    )
    const { fetcher: rememberedFetcher, calls: rememberedCalls } = recordingFetcher(() => ({ status: 200 }))
    const settingsAdoption = await launchFirstMate(
      makeInput({ filesystem: remembered.port, fetcher: rememberedFetcher, support: { kind: "supported", port: 4096 } }),
    )
    expect(settingsAdoption.adopted).toBe(true)
    expect(rememberedCalls).toHaveLength(1)
    expect(rememberedCalls[0].url).toBe("http://127.0.0.1:4096/api/permission-auto-accept/sessions/ses_prior")
    expect(rememberedCalls[0].init.body).toBe(JSON.stringify({ mode: "auto", directory: "/home/firstmate/projects/sunrise" }))
  })

  test("the launch still succeeds when the auto-accept call fails", async () => {
    const { fetcher } = recordingFetcher(() => "throw")

    const result = await launchFirstMate(makeInput({ fetcher, support: { kind: "supported", port: 4096 } }))

    expect(result.adopted).toBe(false)
    expect(result.registration.coordinatorSessionId).toBe("ses_coord_1")
    expect(() => new Date(result.registration.createdAt)).not.toThrow()
  })
})
