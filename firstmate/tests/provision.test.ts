import { describe, expect, test } from "bun:test"
import { provisionProject } from "../service/provision"
import { InMemoryFileSystem } from "./helpers/in-memory-file-system"

const templateContents: Record<string, string> = {
  "charter.md": "SHARED CHARTER TEMPLATE",
  "captain.md": "CAPTAIN ORDERS TEMPLATE",
  "project-charter.md": "PROJECT CHARTER TEMPLATE",
  "backlog.md": "BACKLOG TEMPLATE",
  "projects.md": "PROJECTS TEMPLATE",
  "settings.json": "{}\n",
}

function templateReaderFor(contents: Record<string, string>) {
  return async (templateName: string) => {
    const template = contents[templateName]
    if (template === undefined) {
      throw new Error(`unknown template: ${templateName}`)
    }
    return template
  }
}

describe("provisionProject", () => {
  test("creates the shared root and the per-project home from templates", async () => {
    const filesystem = new InMemoryFileSystem()
    const result = await provisionProject({
      filesystem: filesystem.port,
      templateReader: templateReaderFor(templateContents),
      homeRoot: "/home/firstmate",
      projectDirectory: "/repos/sunrise",
    })

    expect(result).toEqual({
      slug: "sunrise",
      projectHomeDirectory: "/home/firstmate/projects/sunrise",
    })
    expect(filesystem.fileContents("/home/firstmate/shared/charter.md")).toBe("SHARED CHARTER TEMPLATE")
    expect(filesystem.fileContents("/home/firstmate/shared/captain.md")).toBe("CAPTAIN ORDERS TEMPLATE")
    expect(filesystem.directoryExists("/home/firstmate/shared/watches")).toBe(true)
    expect(filesystem.fileContents("/home/firstmate/projects/sunrise/charter.md")).toBe("PROJECT CHARTER TEMPLATE")
    expect(filesystem.fileContents("/home/firstmate/projects/sunrise/captain.md")).toBe("CAPTAIN ORDERS TEMPLATE")
    expect(filesystem.fileContents("/home/firstmate/projects/sunrise/backlog.md")).toBe("BACKLOG TEMPLATE")
    expect(filesystem.fileContents("/home/firstmate/projects/sunrise/projects.md")).toBe("PROJECTS TEMPLATE")
    expect(JSON.parse(filesystem.fileContents("/home/firstmate/projects/sunrise/settings.json"))).toEqual({
      projectDirectory: "/repos/sunrise",
    })
    expect(filesystem.directoryExists("/home/firstmate/projects/sunrise/briefs")).toBe(true)
    expect(filesystem.directoryExists("/home/firstmate/projects/sunrise/reports")).toBe(true)
    expect(filesystem.directoryExists("/home/firstmate/projects/sunrise/watches")).toBe(true)
  })

  test("never overwrites a user-edited file", async () => {
    const filesystem = new InMemoryFileSystem()
    filesystem.seedFile("/home/firstmate/shared/charter.md", "CAPTAIN EDIT")
    filesystem.seedFile("/home/firstmate/projects/sunrise/backlog.md", "CAPTAIN EDIT")
    await provisionProject({
      filesystem: filesystem.port,
      templateReader: templateReaderFor(templateContents),
      homeRoot: "/home/firstmate",
      projectDirectory: "/repos/sunrise",
    })

    expect(filesystem.fileContents("/home/firstmate/shared/charter.md")).toBe("CAPTAIN EDIT")
    expect(filesystem.fileContents("/home/firstmate/projects/sunrise/backlog.md")).toBe("CAPTAIN EDIT")
  })

  test("derives a suffixed slug when another project home already uses the base name", async () => {
    const filesystem = new InMemoryFileSystem()
    filesystem.seedDirectory("/home/firstmate/projects/sunrise")
    const result = await provisionProject({
      filesystem: filesystem.port,
      templateReader: templateReaderFor(templateContents),
      homeRoot: "/home/firstmate",
      projectDirectory: "/repos/sunrise",
    })

    expect(result.slug).toMatch(/^sunrise-[0-9a-f]{8}$/)
    expect(filesystem.fileContents(`${result.projectHomeDirectory}/backlog.md`)).toBe("BACKLOG TEMPLATE")
  })

  test("reprovisioning the same repository reuses the same slug and home", async () => {
    const filesystem = new InMemoryFileSystem()
    const baseInput = {
      filesystem: filesystem.port,
      templateReader: templateReaderFor(templateContents),
      homeRoot: "/home/firstmate",
    }

    const first = await provisionProject({ ...baseInput, projectDirectory: "/repos/sunrise" })
    const second = await provisionProject({ ...baseInput, projectDirectory: "/repos/sunrise" })

    expect(second).toEqual(first)
    expect(await filesystem.port.listDirectories("/home/firstmate/projects")).toEqual(["sunrise"])
  })

  test("treats a trailing-slash variant of the same path as the same project", async () => {
    const filesystem = new InMemoryFileSystem()
    const baseInput = {
      filesystem: filesystem.port,
      templateReader: templateReaderFor(templateContents),
      homeRoot: "/home/firstmate",
    }

    const first = await provisionProject({ ...baseInput, projectDirectory: "/repos/sunrise" })
    const second = await provisionProject({ ...baseInput, projectDirectory: "/repos/sunrise/" })

    expect(second.slug).toBe(first.slug)
    expect(await filesystem.port.listDirectories("/home/firstmate/projects")).toEqual(["sunrise"])
  })
})
