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
    expect(composed).toContain("## Worker model selection")
    expect(composed).toContain(`Use variant ${quotedVariant} for new and resumed workers unless the captain explicitly chooses another.`)
  })

  test("blank worker fields require explicit selection without suppressing captain settings", async () => {
    const filesystem = new InMemoryFileSystem()
    const settingsPath = "/home/firstmate/projects/sunrise/settings.json"
    filesystem.seedFile(settingsPath, JSON.stringify({ workerModel: "provider/worker", workerVariant: "" }))
    const withModel = await composeInstructions({ filesystem: filesystem.port, homeRoot: "/home/firstmate", slug: "sunrise" })
    expect(withModel).toContain('Use model "provider/worker" for new and resumed workers')
    expect(withModel).not.toContain("Use variant")
    expect(withModel).toContain("Choose each unset field yourself")

    filesystem.seedFile(settingsPath, JSON.stringify({ workerModel: "", workerVariant: "" }))
    const withoutDefaults = await composeInstructions({ filesystem: filesystem.port, homeRoot: "/home/firstmate", slug: "sunrise" })
    expect(withoutDefaults).toContain("## Worker model selection")
    expect(withoutDefaults).toContain("Choose each unset field yourself")
    expect(withoutDefaults).not.toContain("Use model")
    expect(withoutDefaults).not.toContain("Use variant")
  })

  test("always includes explicit create, resume, and replacement selection rules, even with a custom charter", async () => {
    const filesystem = new InMemoryFileSystem()
    filesystem.seedFile("/home/firstmate/shared/charter.md", "CUSTOM CHARTER")
    const composed = await composeInstructions({ filesystem: filesystem.port, homeRoot: "/home/firstmate", slug: "sunrise" })

    expect(composed).toContain("CUSTOM CHARTER")
    expect(composed).toContain("Before creating, resuming, steering, or relaunching a worker")
    expect(composed).toContain("Pass both `model` and `variant` explicitly")
    expect(composed).toContain("`session.create` and `session.send`")
    expect(composed).toContain("Reassess the next work rather than inheriting the session's previous selection")
    expect(composed).toContain("Move to a more capable model or higher effort")
    expect(composed).toContain("Move to a smaller model or lower effort")
    expect(composed).toContain("Record the selected model, exact variant, and short reason")
    expect(composed).toContain("preserve its session, worktree, history, scope, and holds")
  })

  test("requires supported variants and stops instead of silently using host defaults", async () => {
    const filesystem = new InMemoryFileSystem()
    filesystem.seedFile("/home/firstmate/projects/sunrise/settings.json", JSON.stringify({ workerVariant: "provider:adaptive/extended" }))
    const composed = await composeInstructions({ filesystem: filesystem.port, homeRoot: "/home/firstmate", slug: "sunrise" })

    expect(composed).toContain("Choose each unset field yourself")
    expect(composed).toContain("Keep captain-set fields fixed")
    expect(composed).toContain("provider's exact variant id")
    expect(composed).toContain("not a fixed reasoning-level enum")
    expect(composed).toContain("`models.search` with the worker's directory")
    expect(composed).toContain("each model's `variants` list")
    expect(composed).toContain("A model with no listed variants can't satisfy explicit effort selection")
    expect(composed).toContain("If no supported explicit pair satisfies the captain's choices")
    expect(composed).toContain("stop before dispatch or resume")
    expect(composed).toContain("Never retry by dropping `model` or `variant`")
  })
})
