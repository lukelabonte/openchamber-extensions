import { describe, expect, test } from "bun:test"
import { restoreSessionProjects } from "../service/session-projects"
import { InMemoryFileSystem } from "./helpers/in-memory-file-system"

describe("restoreSessionProjects", () => {
  test("associates existing first mates without creating or moving sessions and continues after one failure", async () => {
    const filesystem = new InMemoryFileSystem()
    const homeRoot = "/home/firstmate"
    const registrations = Object.fromEntries(["sunrise", "moonrise"].map((slug) => [slug, {
      slug, projectDirectory: `/repos/${slug}`, homeDirectory: `${homeRoot}/projects/${slug}`,
      coordinatorSessionId: `ses_${slug}`, createdAt: "2026-01-01T00:00:00.000Z",
    }]))
    const registryContents = JSON.stringify(registrations)
    filesystem.seedFile(`${homeRoot}/registry.json`, registryContents)
    const calls: string[][] = []

    const failures = await restoreSessionProjects({ filesystem: filesystem.port, homeRoot, exec: async (command, args) => {
      expect(command).toBe("openchamber")
      calls.push([...args])
      if (args.includes("ses_sunrise")) throw new Error("host unavailable")
      return '{"sessionId":"ses_moonrise"}'
    } })

    expect(calls).toEqual(["sunrise", "moonrise"].map((slug) => [
      "session", "associate-project", "--session", `ses_${slug}`, "--dir", `${homeRoot}/projects/${slug}`,
      "--display-project-dir", `/repos/${slug}`, "--json",
    ]))
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain("ses_sunrise is saved")
    expect(failures[0]).toContain("host unavailable")
    expect(filesystem.fileContents(`${homeRoot}/registry.json`)).toBe(registryContents)
  })

  test("an empty registry starts no sessions or CLI requests", async () => {
    const filesystem = new InMemoryFileSystem()
    expect(await restoreSessionProjects({ filesystem: filesystem.port, homeRoot: "/home/firstmate", exec: async () => {
      throw new Error("must not run")
    } })).toEqual([])
  })
})
