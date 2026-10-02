import { describe, expect, test } from "bun:test"
import { deriveSlug } from "../service/slug"

describe("deriveSlug", () => {
  test("derives a lowercase kebab slug from the project directory base name", () => {
    expect(deriveSlug("/Users/captain/Projects/My Cool Repo", [])).toBe("my-cool-repo")
  })

  test("is deterministic for the same path", () => {
    const first = deriveSlug("/repos/sunrise", [])
    const second = deriveSlug("/repos/sunrise", [])
    expect(second).toBe(first)
  })

  test("returns the base slug when the only existing project is the same path", () => {
    expect(deriveSlug("/repos/sunrise", ["/repos/sunrise"])).toBe("sunrise")
  })

  test("appends a short stable hash suffix when two paths share a base name", () => {
    const slug = deriveSlug("/repos/sunrise", ["/elsewhere/sunrise"])
    expect(slug).toMatch(/^sunrise-[0-9a-f]{8}$/)
    expect(slug).toBe(deriveSlug("/repos/sunrise", ["/elsewhere/sunrise"]))
  })

  test("gives colliding paths with the same base name different suffixes", () => {
    const first = deriveSlug("/repos/sunrise", ["/elsewhere/sunrise"])
    const second = deriveSlug("/docs/sunrise", ["/elsewhere/sunrise"])
    expect(second).not.toBe(first)
  })
})
