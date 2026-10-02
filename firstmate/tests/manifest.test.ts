import { requestedGuestCapabilities } from "@openchamber/sdk"
import { parseManifestJson } from "@openchamber/sdk/schemas"
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"

const packageJsonText = readFileSync(path.join(import.meta.dir, "..", "package.json"), "utf8")

function parseManifest() {
  const result = parseManifestJson(packageJsonText)
  if (!result.ok) {
    throw new Error(`manifest failed schema validation: ${JSON.stringify(result)}`)
  }
  return result.manifest
}

describe("openchamber manifest", () => {
  test("is accepted by the SDK manifest schema", () => {
    const manifest = parseManifest()
    expect(manifest.apiVersion).toBe(1)
  })

  test("requests the sessions and service capabilities", () => {
    const manifest = parseManifest()
    const capabilities = requestedGuestCapabilities(manifest.contributes)
    expect(capabilities).toContain("sessions")
    expect(capabilities).toContain("service")
  })
})
