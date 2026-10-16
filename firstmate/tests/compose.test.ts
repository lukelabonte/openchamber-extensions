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

  test.each([
    ["provider:adaptive/extended", '"provider:adaptive/extended"'],
    ['推論 mode "深い" \\ route', '"推論 mode \\"深い\\" \\\\ route"'],
    ["  provider:adaptive/extended  ", '"  provider:adaptive/extended  "'],
    ["default", '"default"'],
  ])("includes the configured worker variant as an exact JSON string: %j", async (variant, quotedVariant) => {
    const filesystem = new InMemoryFileSystem()
    filesystem.seedFile("/home/firstmate/projects/sunrise/settings.json", JSON.stringify({ workerVariant: variant }))

    await composeInstructions({ filesystem: filesystem.port, homeRoot: "/home/firstmate", slug: "sunrise" })

    const composed = filesystem.fileContents("/home/firstmate/projects/sunrise/AGENTS.md")
    expect(composed).toContain("## Configured worker defaults")
    expect(composed).toContain(`Use variant ${quotedVariant} for new workers (session.create variant; CLI --variant), unless the captain explicitly chooses another.`)
  })

  test("blank worker variants omit variant instructions without suppressing the worker model", async () => {
    const filesystem = new InMemoryFileSystem()
    const settingsPath = "/home/firstmate/projects/sunrise/settings.json"
    filesystem.seedFile(settingsPath, JSON.stringify({ workerModel: "provider/worker", workerVariant: "" }))
    const withModel = await composeInstructions({ filesystem: filesystem.port, homeRoot: "/home/firstmate", slug: "sunrise" })
    expect(withModel).toContain('Use model "provider/worker" for new workers')
    expect(withModel).not.toContain("Use variant")
    expect(withModel).not.toContain("--variant")

    filesystem.seedFile(settingsPath, JSON.stringify({ workerModel: "", workerVariant: "" }))
    const withoutDefaults = await composeInstructions({ filesystem: filesystem.port, homeRoot: "/home/firstmate", slug: "sunrise" })
    expect(withoutDefaults).not.toContain("Configured worker defaults")
    expect(withoutDefaults).not.toContain("--variant")
  })
})
