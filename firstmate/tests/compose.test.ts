import { describe, expect, test } from "bun:test"
import { composeInstructions } from "../service/compose"
import { InMemoryFileSystem } from "./helpers/in-memory-file-system"

describe("composeInstructions", () => {
  test("composes the four layers into the project AGENTS.md in precedence order", async () => {
    const filesystem = new InMemoryFileSystem()
    filesystem.seedFile("/home/firstmate/shared/charter.md", "SHARED CHARTER")
    filesystem.seedFile("/home/firstmate/projects/sunrise/charter.md", "PROJECT CHARTER")
    filesystem.seedFile("/home/firstmate/shared/captain.md", "SHARED CAPTAIN")
    filesystem.seedFile("/home/firstmate/projects/sunrise/captain.md", "PROJECT CAPTAIN")

    await composeInstructions({ filesystem: filesystem.port, homeRoot: "/home/firstmate", slug: "sunrise" })

    const composed = filesystem.fileContents("/home/firstmate/projects/sunrise/AGENTS.md")
    const markerPositions = ["SHARED CHARTER", "PROJECT CHARTER", "SHARED CAPTAIN", "PROJECT CAPTAIN"].map(
      (marker) => composed.indexOf(marker),
    )
    expect(markerPositions.every((position) => position >= 0)).toBe(true)
    expect([...markerPositions].sort((a, b) => a - b)).toEqual(markerPositions)
    expect(composed).toContain("shared/charter.md")
    expect(composed).toContain("projects/sunrise/captain.md")
  })

  test("skips layers whose files are missing and says so in the header", async () => {
    const filesystem = new InMemoryFileSystem()
    filesystem.seedFile("/home/firstmate/shared/charter.md", "SHARED CHARTER")

    await composeInstructions({ filesystem: filesystem.port, homeRoot: "/home/firstmate", slug: "sunrise" })

    const composed = filesystem.fileContents("/home/firstmate/projects/sunrise/AGENTS.md")
    expect(composed).toContain("SHARED CHARTER")
    expect(composed).not.toContain("PROJECT CHARTER")
    expect(composed).not.toContain("SHARED CAPTAIN")
    expect(composed).not.toContain("PROJECT CAPTAIN")
    expect(composed).toContain("skipped (missing)")
  })
})
