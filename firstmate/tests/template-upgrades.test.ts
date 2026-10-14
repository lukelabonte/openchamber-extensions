import { createHash } from "node:crypto"
import { describe, expect, test } from "bun:test"
import { acknowledgeTemplateUpgrade, readTemplateUpgrade, syncTemplateCopy } from "../service/template-upgrades"
import { InMemoryFileSystem } from "./helpers/in-memory-file-system"

const filePath = "/home/shared/charter.md"
const fingerprintPath = `${filePath}.template.json`
const hash = (contents: string) => createHash("sha256").update(contents, "utf8").digest("hex")

describe("template upgrades", () => {
  test("installs atomically and upgrades an untouched previous baseline", async () => {
    const filesystem = new InMemoryFileSystem()
    const input = { filesystem: filesystem.port, filePath }
    expect(await syncTemplateCopy({ ...input, contents: "original\n" })).toEqual({ edited: false, outdated: false })
    expect(filesystem.renamedFrom(filePath)).toBeDefined()
    expect(JSON.parse(filesystem.fileContents(fingerprintPath)).baselineHash).toBe(hash("original\n"))
    expect(await readTemplateUpgrade({ ...input, contents: "next\n" })).toEqual({ edited: false, outdated: true })
    expect(await syncTemplateCopy({ ...input, contents: "next\n" })).toEqual({ edited: false, outdated: false })
    expect(filesystem.fileContents(filePath)).toBe("next\n")
  })

  test("recognizes full-byte historical hashes, not trimmed content", async () => {
    const filesystem = new InMemoryFileSystem()
    filesystem.seedFile(filePath, "original\n")
    await syncTemplateCopy({ filesystem: filesystem.port, filePath, contents: "next", legacyHashes: [hash("original\n")] })
    expect(filesystem.fileContents(filePath)).toBe("next")
    filesystem.seedFile(filePath, "original")
    const state = await syncTemplateCopy({ filesystem: filesystem.port, filePath, contents: "newest", legacyHashes: [hash("original\n")] })
    expect(state).toEqual({ edited: true, outdated: true, comparisonPath: `${filePath}.new` })
    expect(filesystem.fileContents(filePath)).toBe("original")
  })

  test("preserves custom words, offers a comparison, and acknowledges only this upstream baseline", async () => {
    const filesystem = new InMemoryFileSystem()
    const input = { filesystem: filesystem.port, filePath }
    await syncTemplateCopy({ ...input, contents: "original" })
    filesystem.seedFile(filePath, "captain's words")
    expect(await syncTemplateCopy({ ...input, contents: "next" })).toEqual({ edited: true, outdated: true, comparisonPath: `${filePath}.new` })
    expect(filesystem.fileContents(filePath)).toBe("captain's words")
    expect(filesystem.fileContents(`${filePath}.new`)).toBe("next")
    expect(filesystem.renamedFrom(`${filePath}.new`)).toBeDefined()
    await acknowledgeTemplateUpgrade({ ...input, contents: "next" })
    expect(await readTemplateUpgrade({ ...input, contents: "next" })).toEqual({ edited: true, outdated: false, comparisonPath: `${filePath}.new` })
    expect(await syncTemplateCopy({ ...input, contents: "next" })).toEqual({ edited: true, outdated: false, comparisonPath: `${filePath}.new` })
    expect(filesystem.fileContents(filePath)).toBe("captain's words")
    expect(await syncTemplateCopy({ ...input, contents: "third" })).toEqual({ edited: true, outdated: true, comparisonPath: `${filePath}.new` })
    expect(filesystem.fileContents(`${filePath}.new`)).toBe("third")
  })

  test("adopts an existing current template but treats unknown copies as custom", async () => {
    const filesystem = new InMemoryFileSystem()
    const input = { filesystem: filesystem.port, filePath, contents: "current" }
    filesystem.seedFile(filePath, "current")
    expect(await syncTemplateCopy(input)).toEqual({ edited: false, outdated: false })
    filesystem.seedFile("/other", "custom")
    expect(await syncTemplateCopy({ ...input, filePath: "/other" })).toEqual({ edited: true, outdated: true, comparisonPath: "/other.new" })
  })

  test("corrupt provenance and read errors fail closed without replacing any file", async () => {
    for (const corrupt of ["{", '{"version":1,"baselineHash":"bogus"}', "null"]) {
      const filesystem = new InMemoryFileSystem()
      filesystem.seedFile(filePath, "original")
      filesystem.seedFile(fingerprintPath, corrupt)
      const input = { filesystem: filesystem.port, filePath, contents: "next", legacyHashes: [hash("original")] }
      await expect(syncTemplateCopy(input)).rejects.toThrow()
      await expect(readTemplateUpgrade(input)).rejects.toThrow()
      await expect(acknowledgeTemplateUpgrade(input)).rejects.toThrow()
      expect(filesystem.fileContents(filePath)).toBe("original")
      expect(filesystem.fileContents(fingerprintPath)).toBe(corrupt)
      expect(filesystem.renames).toHaveLength(0)
    }
    const filesystem = new InMemoryFileSystem()
    filesystem.seedFile(filePath, "original")
    const unreadable = { ...filesystem.port, readFile: async () => { throw new Error("permission denied") } }
    await expect(syncTemplateCopy({ filesystem: unreadable, filePath, contents: "next" })).rejects.toThrow("permission denied")
    expect(filesystem.fileContents(filePath)).toBe("original")
    expect(filesystem.renames).toHaveLength(0)
  })

  test("double-checks after staging and preserves a concurrent editor's change", async () => {
    const filesystem = new InMemoryFileSystem()
    await syncTemplateCopy({ filesystem: filesystem.port, filePath, contents: "original" })
    let edited = false
    const racing = {
      ...filesystem.port,
      writeFile: async (path: string, contents: string) => {
        await filesystem.port.writeFile(path, contents)
        if (!edited && path.startsWith(`${filePath}.tmp-`)) {
          edited = true
          filesystem.seedFile(filePath, "concurrent edit")
        }
      },
    }
    expect(await syncTemplateCopy({ filesystem: racing, filePath, contents: "next" })).toEqual({ edited: true, outdated: true, comparisonPath: `${filePath}.new` })
    expect(filesystem.fileContents(filePath)).toBe("concurrent edit")
  })

  test("unreadable provenance or comparison files block mutation", async () => {
    for (const unreadablePath of [fingerprintPath, `${filePath}.new`]) {
      const filesystem = new InMemoryFileSystem()
      await syncTemplateCopy({ filesystem: filesystem.port, filePath, contents: "original" })
      filesystem.seedFile(filePath, "custom")
      filesystem.seedFile(`${filePath}.new`, "older comparison")
      const beforeRenames = filesystem.renames.length
      const unreadable = { ...filesystem.port, readFile: async (path: string) => {
        if (path === unreadablePath) throw new Error("permission denied")
        return filesystem.port.readFile(path)
      } }
      await expect(syncTemplateCopy({ filesystem: unreadable, filePath, contents: "next" })).rejects.toThrow("permission denied")
      expect(filesystem.fileContents(filePath)).toBe("custom")
      expect(filesystem.fileContents(`${filePath}.new`)).toBe("older comparison")
      expect(filesystem.renames.length).toBe(beforeRenames)
    }
  })

  test("acknowledgement double-checks before replacing provenance", async () => {
    const filesystem = new InMemoryFileSystem()
    const input = { filesystem: filesystem.port, filePath }
    await syncTemplateCopy({ ...input, contents: "original" })
    const before = filesystem.fileContents(fingerprintPath)
    const racing = { ...filesystem.port, writeFile: async (path: string, contents: string) => {
      await filesystem.port.writeFile(path, contents)
      if (path.startsWith(`${fingerprintPath}.tmp-`)) filesystem.seedFile(filePath, "concurrent edit")
    } }
    await expect(acknowledgeTemplateUpgrade({ ...input, filesystem: racing, contents: "next" })).rejects.toThrow("changed during update")
    expect(filesystem.fileContents(filePath)).toBe("concurrent edit")
    expect(filesystem.fileContents(fingerprintPath)).toBe(before)
  })

  test("a failed atomic rename leaves the previous baseline intact", async () => {
    const filesystem = new InMemoryFileSystem()
    await syncTemplateCopy({ filesystem: filesystem.port, filePath, contents: "original" })
    const failing = { ...filesystem.port, rename: async () => { throw new Error("rename failed") } }
    await expect(syncTemplateCopy({ filesystem: failing, filePath, contents: "next" })).rejects.toThrow("rename failed")
    expect(filesystem.fileContents(filePath)).toBe("original")
    expect(JSON.parse(filesystem.fileContents(fingerprintPath)).baselineHash).toBe(hash("original"))
  })

  test("acknowledgement refuses a missing file", async () => {
    const filesystem = new InMemoryFileSystem()
    await expect(acknowledgeTemplateUpgrade({ filesystem: filesystem.port, filePath, contents: "next" })).rejects.toThrow()
    expect(await filesystem.port.exists(fingerprintPath)).toBe(false)
  })
})
