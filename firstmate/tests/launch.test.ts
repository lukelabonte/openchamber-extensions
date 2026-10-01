import { describe, expect, test } from "bun:test"
import { launchFirstMate, type LaunchFirstMateInput } from "../service/launch"
import { MissingCliError, type ExecRunner } from "../service/control-client"
import { InMemoryFileSystem } from "./helpers/in-memory-file-system"

const projectDirectory = "/repos/sunrise"

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
    calls.push({ command, args: [...args] })
    return stdout
  }
  return { exec, calls }
}

function countingExec(): { exec: ExecRunner; calls: string[][] } {
  let count = 0
  const calls: string[][] = []
  const exec: ExecRunner = async (_command, args) => {
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
    ...overrides,
  }
}

function registryFileContents(filesystem: InMemoryFileSystem): string {
  return filesystem.fileContents("/home/firstmate/registry.json")
}

describe("launchFirstMate", () => {
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
})
