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
