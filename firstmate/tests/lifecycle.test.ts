import { describe, expect, test } from "bun:test"
import { adoptFirstMate, releaseFirstMate, restartFirstMate } from "../service/lifecycle"
import { launchFirstMate } from "../service/launch"
import type { ExecRunner } from "../service/control-client"
import { InMemoryFileSystem } from "./helpers/in-memory-file-system"

const homeRoot = "/home/firstmate"
const homeDirectory = `${homeRoot}/projects/sunrise`
const projectDirectory = "/repos/sunrise"
const registration = { slug: "sunrise", projectDirectory, homeDirectory, coordinatorSessionId: "ses_old", createdAt: "2026-01-01T00:00:00.000Z" }
const desktop = { fetcher: async () => { throw new Error("must not call desktop") }, support: { kind: "unsupported", reason: "test" } as const }

function fixture(options: { registered?: boolean; activity?: string; candidates?: unknown[]; createError?: string } = {}) {
  const filesystem = new InMemoryFileSystem()
  filesystem.seedDirectory(homeDirectory)
  filesystem.seedFile(`${homeDirectory}/settings.json`, JSON.stringify({ projectDirectory, coordinatorSessionId: "ses_old", coordinatorModel: "provider/coordinator", coordinatorVariant: "high", workerModel: "provider/worker", custom: { untouched: true } }))
  filesystem.seedFile(`${homeDirectory}/opening.md`, "CAPTAIN OPENING\n")
  filesystem.seedFile(`${homeDirectory}/captain.md`, "CAPTAIN INSTRUCTIONS")
  filesystem.seedFile(`${homeDirectory}/backlog.md`, "BACKLOG WITH WORKERS")
  filesystem.seedFile(`${homeDirectory}/workers.json`, "WORKER STATE")
  if (options.registered !== false) filesystem.seedFile(`${homeRoot}/registry.json`, JSON.stringify({ sunrise: registration }))
  const calls: string[][] = []
  const exec: ExecRunner = async (command, args) => {
    expect(command).toBe("openchamber")
    calls.push([...args])
    expect(args[args.indexOf("--dir") + 1]).toBe(homeDirectory)
    if (args[1] === "status") return JSON.stringify({ sessionId: args[args.indexOf("--session") + 1], sessionStatus: { type: options.activity ?? "idle" } })
    if (args[1] === "list") return JSON.stringify({ sessions: options.candidates ?? [{ sessionId: "ses_candidate", directory: homeDirectory, sessionStatus: { type: "idle" } }] })
    if (args[1] === "create") {
      if (options.createError) throw new Error(options.createError)
      return '{"sessionId":"ses_fresh"}'
    }
    if (args[1] === "associate-project") return JSON.stringify({ sessionId: args[args.indexOf("--session") + 1] })
    throw new Error(`unexpected lifecycle command: ${args.join(" ")}`)
  }
  return { filesystem, exec, calls, input: { ...desktop, filesystem: filesystem.port, exec, homeRoot, slug: "sunrise" } }
}

function launchInput(input: ReturnType<typeof fixture>["input"]) {
  return { ...input, projectDirectory, templateReader: async () => "", fetcher: async () => ({ status: 200 }), support: { kind: "unsupported", reason: "test" } as const }
}

describe("FirstMate lifecycle", () => {
  test("adoption and restart remain usable when the CLI lacks sidebar association support", async () => {
    for (const operation of [(input: ReturnType<typeof fixture>["input"]) => adoptFirstMate({ ...input, sessionId: "ses_candidate" }), restartFirstMate]) {
      const { input, filesystem, exec } = fixture()
      input.exec = async (command, args) => {
        if (args[1] === "associate-project") throw new Error("openchamber exited with code 1: Unknown option: --display-project-dir")
        return exec(command, args)
      }
      const result = await operation(input)
      expect(result.registration.homeDirectory).toBe(homeDirectory)
      expect(JSON.parse(filesystem.fileContents(`${homeRoot}/registry.json`)).sunrise).toEqual(result.registration)
      expect(JSON.parse(filesystem.fileContents(`${homeDirectory}/settings.json`)).coordinatorSessionId).toBe(result.registration.coordinatorSessionId)
    }
  })

  test("adopts a directory-listed idle session and preserves unrelated settings", async () => {
    const { filesystem, input, calls } = fixture()
    const result = await adoptFirstMate({ ...input, sessionId: "ses_candidate" })
    expect(result.registration.coordinatorSessionId).toBe("ses_candidate")
    expect(JSON.parse(filesystem.fileContents(`${homeDirectory}/settings.json`))).toMatchObject({ projectDirectory, coordinatorSessionId: "ses_candidate", workerModel: "provider/worker", custom: { untouched: true } })
    expect(JSON.parse(filesystem.fileContents(`${homeRoot}/registry.json`)).sunrise.coordinatorSessionId).toBe("ses_candidate")
    expect(filesystem.renamedFrom(`${homeDirectory}/settings.json`)).toContain(".tmp")
    expect(calls.filter((args) => args[1] === "create")).toHaveLength(0)
    expect(calls.find((args) => args[1] === "associate-project")).toEqual([
      "session", "associate-project", "--session", "ses_candidate", "--dir", homeDirectory,
      "--display-project-dir", projectDirectory, "--json",
    ])
  })

  test("adopts only an existing associated home when its registry was lost", async () => {
    const { input } = fixture({ registered: false })
    expect((await adoptFirstMate({ ...input, sessionId: "ses_candidate" })).registration.projectDirectory).toBe(projectDirectory)
  })

  test("requires an existing home and association rather than trusting supplied registration-like properties", async () => {
    const missing = new InMemoryFileSystem()
    await expect(adoptFirstMate({ ...desktop, filesystem: missing.port, exec: async () => { throw new Error("must not call CLI") }, homeRoot, slug: "sunrise", sessionId: "ses_candidate" })).rejects.toThrow("existing")
    const noAssociation = fixture({ registered: false })
    noAssociation.filesystem.seedFile(`${homeDirectory}/settings.json`, "{}")
    await expect(adoptFirstMate({ ...noAssociation.input, sessionId: "ses_candidate" })).rejects.toThrow("projectDirectory")
    expect(noAssociation.calls).toHaveLength(0)
  })

  test("lost-registry lifecycle checks the remembered coordinator before replacing it", async () => {
    const { input, calls } = fixture({ registered: false, activity: "running" })
    await expect(adoptFirstMate({ ...input, sessionId: "ses_candidate" })).rejects.toThrow("idle")
    expect(calls).toHaveLength(1)
    expect(calls[0][calls[0].indexOf("--session") + 1]).toBe("ses_old")
  })

  test("refuses unrelated or archived candidates even if status echoes an idle requested context", async () => {
    for (const candidates of [[], [{ id: "ses_candidate", directory: "/other/home", type: "idle" }], [{ id: "ses_candidate", archivedAt: 123, type: "idle" }], [{ id: "ses_candidate", time: { archived: 123 }, type: "idle" }]]) {
      const { input, filesystem } = fixture({ candidates })
      await expect(adoptFirstMate({ ...input, sessionId: "ses_candidate" })).rejects.toThrow()
      expect(JSON.parse(filesystem.fileContents(`${homeRoot}/registry.json`)).sunrise).toEqual(registration)
    }
  })

  test("all mutations refuse a busy, retrying, waiting or unknown existing coordinator", async () => {
    for (const activity of ["busy", "running", "retrying", "waiting-permission", "waiting-question", "unknown"]) {
      for (const operation of [(input: ReturnType<typeof fixture>["input"]) => adoptFirstMate({ ...input, sessionId: "ses_candidate" }), releaseFirstMate, restartFirstMate]) {
        const { input, filesystem, calls } = fixture({ activity })
        const settingsBefore = filesystem.fileContents(`${homeDirectory}/settings.json`)
        await expect(operation(input)).rejects.toThrow("idle")
        expect(filesystem.fileContents(`${homeDirectory}/settings.json`)).toBe(settingsBefore)
        expect(JSON.parse(filesystem.fileContents(`${homeRoot}/registry.json`)).sunrise).toEqual(registration)
        expect(calls.filter((args) => args[1] === "create")).toHaveLength(0)
      }
    }
  })

  test("adopt refuses a non-idle candidate", async () => {
    const { input } = fixture({ candidates: [{ id: "ses_candidate", type: "running" }] })
    await expect(adoptFirstMate({ ...input, sessionId: "ses_candidate" })).rejects.toThrow("idle")
  })

  test("release forgets only the coordinator and launch creates fresh rather than recovering it", async () => {
    const { input, filesystem, calls } = fixture({ registered: false })
    const result = await releaseFirstMate(input)
    expect(result.released).toBe(true)
    expect(result.previousSessionId).toBe("ses_old")
    const settings = JSON.parse(filesystem.fileContents(`${homeDirectory}/settings.json`))
    expect(settings.coordinatorSessionId).toBeUndefined()
    expect(settings.coordinatorReleased).toBe(true)
    expect(settings.custom).toEqual({ untouched: true })
    expect(filesystem.fileContents(`${homeDirectory}/backlog.md`)).toBe("BACKLOG WITH WORKERS")
    expect(filesystem.fileContents(`${homeDirectory}/workers.json`)).toBe("WORKER STATE")
    expect(JSON.parse(filesystem.fileContents(`${homeRoot}/registry.json`)).sunrise).toBeUndefined()
    expect((await launchFirstMate(launchInput(input))).registration.coordinatorSessionId).toBe("ses_fresh")
    expect(calls.every((args) => ["status", "create", "associate-project"].includes(args[1]))).toBe(true)
  })

  test("a failed release registry write leaves a tombstone that launch honors", async () => {
    const { input, filesystem } = fixture()
    const failingFilesystem = { ...filesystem.port, rename: async (fromPath: string, toPath: string) => {
      if (toPath === `${homeRoot}/registry.json`) throw new Error("registry unavailable")
      await filesystem.port.rename(fromPath, toPath)
    } }
    await expect(releaseFirstMate({ ...input, filesystem: failingFilesystem })).rejects.toThrow("registry unavailable")
    expect(JSON.parse(filesystem.fileContents(`${homeDirectory}/settings.json`)).coordinatorReleased).toBe(true)
    const launched = await launchFirstMate(launchInput(input))
    expect(launched.adopted).toBe(false)
    expect(launched.registration.coordinatorSessionId).toBe("ses_fresh")
  })

  test("restart creates a fresh session in the same home with settings and reconciliation prompt", async () => {
    const { input, filesystem, calls } = fixture()
    const result = await restartFirstMate(input)
    expect(result.registration).toMatchObject({ homeDirectory, projectDirectory, coordinatorSessionId: "ses_fresh" })
    expect(result.previousSessionId).toBe("ses_old")
    const create = calls.find((args) => args[1] === "create")!
    expect(create[create.indexOf("--title") + 1]).toBe("⚓ FirstMate — sunrise")
    expect(create[create.indexOf("--model") + 1]).toBe("provider/coordinator")
    expect(create[create.indexOf("--variant") + 1]).toBe("high")
    const prompt = create[create.indexOf("--prompt") + 1]
    expect(prompt).toContain("CAPTAIN OPENING")
    expect(prompt).toContain("captain.md")
    expect(prompt).toContain("backlog.md")
    expect(prompt).toContain("reconcile")
    expect(prompt).toContain("Do not merge")
    expect(prompt).toContain("do not start new tasks")
    expect(filesystem.fileContents(`${homeDirectory}/backlog.md`)).toBe("BACKLOG WITH WORKERS")
    expect(filesystem.fileContents(`${homeDirectory}/workers.json`)).toBe("WORKER STATE")
    expect(calls.every((args) => ["status", "create", "associate-project"].includes(args[1]))).toBe(true)
    expect(calls.find((args) => args[1] === "associate-project")).toEqual([
      "session", "associate-project", "--session", "ses_fresh", "--dir", homeDirectory,
      "--display-project-dir", projectDirectory, "--json",
    ])
  })

  test("failed restart creation preserves settings, registry and old session", async () => {
    const { input, filesystem } = fixture({ createError: "creation failed" })
    const settingsBefore = filesystem.fileContents(`${homeDirectory}/settings.json`)
    await expect(restartFirstMate(input)).rejects.toThrow("creation failed")
    expect(filesystem.fileContents(`${homeDirectory}/settings.json`)).toBe(settingsBefore)
    expect(JSON.parse(filesystem.fileContents(`${homeRoot}/registry.json`)).sunrise).toEqual(registration)
  })

  test("settings persistence must succeed before registry changes", async () => {
    for (const operation of [(input: ReturnType<typeof fixture>["input"]) => adoptFirstMate({ ...input, sessionId: "ses_candidate" }), releaseFirstMate, restartFirstMate]) {
      const { input, filesystem } = fixture()
      const settingsBefore = filesystem.fileContents(`${homeDirectory}/settings.json`)
      const failingFilesystem = { ...filesystem.port, rename: async (fromPath: string, toPath: string) => {
        if (toPath === `${homeDirectory}/settings.json`) throw new Error("settings unavailable")
        await filesystem.port.rename(fromPath, toPath)
      } }
      await expect(operation({ ...input, filesystem: failingFilesystem })).rejects.toThrow("settings unavailable")
      expect(filesystem.fileContents(`${homeDirectory}/settings.json`)).toBe(settingsBefore)
      expect(JSON.parse(filesystem.fileContents(`${homeRoot}/registry.json`)).sunrise).toEqual(registration)
    }
  })

  test("release preserves registrations for other projects", async () => {
    const { input, filesystem } = fixture()
    const other = { ...registration, slug: "moonrise", projectDirectory: "/repos/moonrise", homeDirectory: `${homeRoot}/projects/moonrise`, coordinatorSessionId: "ses_other" }
    filesystem.seedFile(`${homeRoot}/registry.json`, JSON.stringify({ sunrise: registration, moonrise: other }))
    await releaseFirstMate(input)
    expect(JSON.parse(filesystem.fileContents(`${homeRoot}/registry.json`))).toEqual({ moonrise: other })
  })

  test("a repoint registry failure recovers the settings ID rather than the stale registration", async () => {
    const { input, filesystem } = fixture()
    const failingFilesystem = { ...filesystem.port, rename: async (fromPath: string, toPath: string) => {
      if (toPath === `${homeRoot}/registry.json`) throw new Error("registry unavailable")
      await filesystem.port.rename(fromPath, toPath)
    } }
    await expect(adoptFirstMate({ ...input, filesystem: failingFilesystem, sessionId: "ses_candidate" })).rejects.toThrow("registry unavailable")
    expect((await launchFirstMate(launchInput(input))).registration.coordinatorSessionId).toBe("ses_candidate")
  })

  test("release and simultaneous launch share a lock even when launch uses a home alias", async () => {
    const { input, filesystem } = fixture()
    let enterStatus!: () => void
    const statusEntered = new Promise<void>((resolve) => { enterStatus = resolve })
    let finishStatus!: () => void
    const statusGate = new Promise<void>((resolve) => { finishStatus = resolve })
    const exec: ExecRunner = async (command, args) => {
      if (args[1] === "status") { enterStatus(); await statusGate }
      return input.exec(command, args)
    }
    const release = releaseFirstMate({ ...input, exec })
    await statusEntered
    const launch = launchFirstMate({ ...launchInput(input), projectDirectory: homeDirectory })
    finishStatus()
    await release
    const launched = await launch
    expect(launched.adopted).toBe(false)
    expect(launched.registration.projectDirectory).toBe(projectDirectory)
    expect(launched.registration.homeDirectory).toBe(homeDirectory)
    expect(launched.registration.coordinatorSessionId).toBe("ses_fresh")
    expect(JSON.parse(filesystem.fileContents(`${homeRoot}/registry.json`)).sunrise.coordinatorSessionId).toBe("ses_fresh")
  })

  test("concurrent restarts re-resolve the current coordinator inside the lock", async () => {
    const { input } = fixture()
    const checked: string[] = []
    let created = 0
    const exec: ExecRunner = async (command, args) => {
      if (args[1] === "status") checked.push(args[args.indexOf("--session") + 1])
      if (args[1] === "create") return JSON.stringify({ sessionId: `ses_fresh_${++created}` })
      return input.exec(command, args)
    }
    const [first, second] = await Promise.all([restartFirstMate({ ...input, exec }), restartFirstMate({ ...input, exec })])
    expect(first.registration.coordinatorSessionId).toBe("ses_fresh_1")
    expect(second.previousSessionId).toBe("ses_fresh_1")
    expect(checked).toEqual(["ses_old", "ses_fresh_1"])
  })

  test("refuses invalid slugs, mismatched homes, corrupt settings and CLI JSON", async () => {
    const invalidSlug = fixture()
    await expect(releaseFirstMate({ ...invalidSlug.input, slug: "../elsewhere" })).rejects.toThrow()
    const badHome = fixture()
    badHome.filesystem.seedFile(`${homeRoot}/registry.json`, JSON.stringify({ sunrise: { ...registration, homeDirectory: "/unrelated/home" } }))
    await expect(releaseFirstMate(badHome.input)).rejects.toThrow()
    const badSettings = fixture()
    badSettings.filesystem.seedFile(`${homeDirectory}/settings.json`, "not JSON")
    await expect(releaseFirstMate(badSettings.input)).rejects.toThrow("settings")
    const badStatus = fixture()
    await expect(releaseFirstMate({ ...badStatus.input, exec: async () => "not JSON" })).rejects.toThrow("JSON")
    const badList = fixture()
    await expect(adoptFirstMate({ ...badList.input, sessionId: "ses_candidate", exec: async (_command, args) => args[1] === "status" ? '{"type":"idle"}' : '{}' })).rejects.toThrow()
  })
})
