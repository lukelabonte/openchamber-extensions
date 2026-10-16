import { describe, expect, test } from "bun:test"
import { loadProjectSettings, saveProjectSettings } from "../service/settings"
import { InMemoryFileSystem } from "./helpers/in-memory-file-system"

const home = "/home/firstmate/projects/sunrise"

describe("FirstMate settings", () => {
  test("defaults keep existing launches and refresh behavior", async () => {
    const filesystem = new InMemoryFileSystem()
    expect(await loadProjectSettings(filesystem.port, home)).toEqual({
      coordinatorModel: "", coordinatorVariant: "", workerModel: "", workerVariant: "", refreshSeconds: 30,
    })
  })

  test("writes settings atomically without losing the project's association or coordinator", async () => {
    const filesystem = new InMemoryFileSystem()
    filesystem.seedFile(`${home}/settings.json`, JSON.stringify({ projectDirectory: "/repos/sunrise", coordinatorSessionId: "ses_1", custom: true }))
    await saveProjectSettings(filesystem.port, home, { workerModel: "openai/test-model", workerVariant: "high", refreshSeconds: 10 })
    expect(await loadProjectSettings(filesystem.port, home)).toMatchObject({ workerModel: "openai/test-model", workerVariant: "high", refreshSeconds: 10 })
    expect(JSON.parse(filesystem.fileContents(`${home}/settings.json`))).toMatchObject({ projectDirectory: "/repos/sunrise", coordinatorSessionId: "ses_1", custom: true })
    expect(filesystem.renamedFrom(`${home}/settings.json`)).toBeDefined()
  })

  test("round-trips provider-specific variants verbatim without rewriting unrelated fields", async () => {
    const filesystem = new InMemoryFileSystem()
    const existing = { projectDirectory: "/repos/sunrise", coordinatorSessionId: "ses_1", custom: { retained: true }, workerModel: "provider/model" }
    const variants = { coordinatorVariant: "provider:adaptive/extended", workerVariant: '推論 mode "深い" \\ route' }
    filesystem.seedFile(`${home}/settings.json`, JSON.stringify(existing))

    expect(await saveProjectSettings(filesystem.port, home, variants)).toMatchObject(variants)
    expect(await loadProjectSettings(filesystem.port, home)).toMatchObject(variants)
    expect(JSON.parse(filesystem.fileContents(`${home}/settings.json`))).toEqual({ ...existing, ...variants })
    expect(filesystem.renamedFrom(`${home}/settings.json`)).toContain(".tmp")
  })

  test.each(["", "default", "provider:adaptive/extended", "推論 mode", "  provider:adaptive/extended \u3000", "v".repeat(81), "v".repeat(200), "🧠".repeat(100)])("preserves an opaque variant in both settings: %j", async (variant) => {
    const filesystem = new InMemoryFileSystem()
    const settings = { coordinatorVariant: variant, workerVariant: variant }
    expect(await saveProjectSettings(filesystem.port, home, settings)).toMatchObject(settings)
    expect(await loadProjectSettings(filesystem.port, home)).toMatchObject(settings)
    expect(JSON.parse(filesystem.fileContents(`${home}/settings.json`))).toEqual(settings)
  })

  test.each([
    " ", "\u00a0\u3000", "v".repeat(201), "v".repeat(199) + "🧠", "🧠".repeat(101),
    ...Array.from({ length: 32 }, (_, index) => `provider:${String.fromCharCode(index)}variant`),
    ...Array.from({ length: 33 }, (_, index) => `provider:${String.fromCharCode(127 + index)}variant`),
    null, true, 42, [], {},
  ].map((variant) => [variant] as const))("rejects invalid variant content on save and read without mutation: %j", async (variant) => {
    for (const name of ["coordinatorVariant", "workerVariant"]) {
      const filesystem = new InMemoryFileSystem()
      const existing = JSON.stringify({ projectDirectory: "/repos/sunrise", custom: true })
      filesystem.seedFile(`${home}/settings.json`, existing)
      const writes: string[] = []
      const port = { ...filesystem.port, writeFile: async (filePath: string, contents: string) => {
        writes.push(filePath)
        await filesystem.port.writeFile(filePath, contents)
      } }
      await expect(saveProjectSettings(port, home, { [name]: variant })).rejects.toThrow(name)
      expect(writes).toEqual([])
      expect(filesystem.renames).toHaveLength(0)
      expect(filesystem.fileContents(`${home}/settings.json`)).toBe(existing)

      const invalidRecord = JSON.stringify({ [name]: variant })
      filesystem.seedFile(`${home}/settings.json`, invalidRecord)
      await expect(loadProjectSettings(filesystem.port, home)).rejects.toThrow(name)
      expect(filesystem.fileContents(`${home}/settings.json`)).toBe(invalidRecord)
    }
  })

  test("reads valid saved variant IDs without migrating the saved record", async () => {
    const filesystem = new InMemoryFileSystem()
    const contents = '{ "coordinatorVariant": "default", "workerVariant": "  provider:adaptive/extended  ", "custom": true }\n'
    filesystem.seedFile(`${home}/settings.json`, contents)
    expect(await loadProjectSettings(filesystem.port, home)).toMatchObject({ coordinatorVariant: "default", workerVariant: "  provider:adaptive/extended  " })
    expect(filesystem.fileContents(`${home}/settings.json`)).toBe(contents)
    expect(filesystem.renames).toHaveLength(0)
  })

  test("publishes the complete settings record only through an atomic rename", async () => {
    const filesystem = new InMemoryFileSystem()
    const filePath = `${home}/settings.json`
    const existing = JSON.stringify({ coordinatorSessionId: "ses_1", custom: { retained: true } })
    const updated = { coordinatorSessionId: "ses_1", custom: { retained: true }, workerVariant: "provider:adaptive/extended" }
    filesystem.seedFile(filePath, existing)
    const port = {
      ...filesystem.port,
      writeFile: async (temporaryPath: string, contents: string) => {
        expect(temporaryPath).toStartWith(`${filePath}.`)
        expect(temporaryPath).toEndWith(".tmp")
        expect(filesystem.fileContents(filePath)).toBe(existing)
        await filesystem.port.writeFile(temporaryPath, contents)
      },
      rename: async (temporaryPath: string, targetPath: string) => {
        expect(targetPath).toBe(filePath)
        expect(filesystem.fileContents(filePath)).toBe(existing)
        expect(JSON.parse(filesystem.fileContents(temporaryPath))).toEqual(updated)
        await filesystem.port.rename(temporaryPath, targetPath)
      },
    }
    await saveProjectSettings(port, home, { workerVariant: "provider:adaptive/extended" })
    expect(filesystem.renames).toHaveLength(1)
    expect(JSON.parse(filesystem.fileContents(filePath))).toEqual(updated)
  })

  test.each(["writeFile", "rename"] as const)("does not replace saved settings when %s fails", async (operation) => {
    const filesystem = new InMemoryFileSystem()
    const existing = '{ "workerVariant": "default", "custom": true }'
    filesystem.seedFile(`${home}/settings.json`, existing)
    const port = { ...filesystem.port, [operation]: async () => { throw new Error(`${operation} failed`) } }
    await expect(saveProjectSettings(port, home, { workerVariant: "provider:adaptive/extended" })).rejects.toThrow(`${operation} failed`)
    expect(filesystem.fileContents(`${home}/settings.json`)).toBe(existing)
    expect(filesystem.renames).toHaveLength(0)
  })

  test("fails closed on settings read errors without writing a replacement", async () => {
    const filesystem = new InMemoryFileSystem()
    const existing = '{ "workerVariant": "default", "custom": true }'
    filesystem.seedFile(`${home}/settings.json`, existing)
    const writes: string[] = []
    const port = {
      ...filesystem.port,
      readFile: async () => { throw new Error("settings read denied") },
      writeFile: async (filePath: string, contents: string) => {
        writes.push(filePath)
        await filesystem.port.writeFile(filePath, contents)
      },
    }
    await expect(loadProjectSettings(port, home)).rejects.toThrow("settings read denied")
    await expect(saveProjectSettings(port, home, { workerVariant: "provider:adaptive/extended" })).rejects.toThrow("settings read denied")
    expect(writes).toEqual([])
    expect(filesystem.fileContents(`${home}/settings.json`)).toBe(existing)
    expect(filesystem.renames).toHaveLength(0)
  })

  test("rejects unsupported sessionOptions before any settings I/O", async () => {
    const filesystem = new InMemoryFileSystem()
    const existing = '{ "custom": true }'
    filesystem.seedFile(`${home}/settings.json`, existing)
    const port = {
      ...filesystem.port,
      exists: async () => { throw new Error("unexpected settings read") },
      writeFile: async () => { throw new Error("unexpected settings write") },
    }
    await expect(saveProjectSettings(port, home, { sessionOptions: { reasoning: "high" } })).rejects.toThrow("unknown FirstMate setting: sessionOptions")
    expect(filesystem.fileContents(`${home}/settings.json`)).toBe(existing)
    expect(filesystem.renames).toHaveLength(0)
  })

  test.each([{ workerModel: "no-provider" }, { workerModel: "openai/model\n--goal" }, { refreshSeconds: 0 }, { refreshSeconds: 5.5 }, { refreshSeconds: 3601 }, { workerVariant: "high\n" }, { unexpected: true }])("rejects invalid settings before mutation: %j", async (settings) => {
    const filesystem = new InMemoryFileSystem()
    filesystem.seedFile(`${home}/settings.json`, "{}")
    await expect(saveProjectSettings(filesystem.port, home, settings)).rejects.toThrow()
    expect(filesystem.fileContents(`${home}/settings.json`)).toBe("{}")
  })

  test("a malformed settings file isn't replaced", async () => {
    const filesystem = new InMemoryFileSystem()
    filesystem.seedFile(`${home}/settings.json`, "{ broken")
    await expect(saveProjectSettings(filesystem.port, home, { refreshSeconds: 10 })).rejects.toThrow()
    expect(filesystem.fileContents(`${home}/settings.json`)).toBe("{ broken")
  })
})
