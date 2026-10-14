import { describe, expect, test } from "bun:test"
import { InMemoryFileSystem } from "./helpers/in-memory-file-system"
import type { FileSystemPort } from "../service/file-system"
import {
  dismissSuggestion,
  loadSuggestions,
  normalizeSuggestionText,
  parseDismissedSuggestions,
  sendSuggestion,
} from "../service/suggestions"

const filePath = "/home/projects/sunrise/suggestions.md"
const dismissedPath = "/home/projects/sunrise/suggestions-dismissed.md"
const target = { label: "Refresh PR", text: "refresh the PR description" }
const now = new Date("2026-10-13T12:00:00.000Z")

function dismissalLine(label: string, text: string): string {
  return `- ${JSON.stringify({ label, text, dismissedAt: now.toISOString() })}`
}

describe("dismissal text comparison", () => {
  test("normalizes whitespace only, preserving case and punctuation", () => {
    expect(normalizeSuggestionText(" \trefresh\n the\u00a0PR  description\r\n")).toBe("refresh the PR description")
    expect(normalizeSuggestionText("Refresh the PR description!")).toBe("Refresh the PR description!")
  })

  test("reads valid records while ignoring malformed records and human prose", () => {
    const markdown = [
      "# Dismissed suggestions",
      "Human notes stay here.",
      dismissalLine("Old label", "  refresh\t the PR description "),
      '- {"label":"Torn","text":"refresh the PR',
      '- {"label":"Bad date","text":"other prompt","dismissedAt":"not a date"}',
      '- {"label":"Blank","text":"  ","dismissedAt":"2026-10-13"}',
      '- {"label":"Not text","text":12,"dismissedAt":"2026-10-13"}',
      "- Looks like a suggestion :: not a dismissal record",
    ].join("\n")

    expect([...parseDismissedSuggestions(markdown)]).toEqual([target.text])
  })
})

describe("persistent suggestion dismissals", () => {
  test("persists a timestamped record before atomically removing the exact suggestion", async () => {
    const filesystem = new InMemoryFileSystem()
    const markdown = ["# Suggestions", "", `- ${target.label} :: ${target.text}`, "Human notes.", "- Keep :: another prompt", ""].join("\n")
    filesystem.seedFile(filePath, markdown)
    const orderedPort: FileSystemPort = {
      ...filesystem.port,
      rename: async (fromPath, toPath) => {
        if (toPath === filePath) {
          expect([...parseDismissedSuggestions(filesystem.fileContents(dismissedPath))]).toEqual([target.text])
        }
        await filesystem.port.rename(fromPath, toPath)
      },
    }

    await dismissSuggestion(orderedPort, filePath, target, now)

    expect(filesystem.fileContents(dismissedPath)).toContain(dismissalLine(target.label, target.text))
    expect(filesystem.fileContents(filePath)).toBe(["# Suggestions", "", "Human notes.", "- Keep :: another prompt", ""].join("\n"))
    expect(filesystem.renames.map((entry) => entry.toPath)).toEqual([dismissedPath, filePath])
    expect(filesystem.renames.every((entry) => entry.fromPath.startsWith(`${entry.toPath}.`) && entry.fromPath.endsWith(".tmp"))).toBe(true)
  })

  test("automatically filters renamed identical prompts after a fresh load but allows real changes", async () => {
    const filesystem = new InMemoryFileSystem()
    filesystem.seedFile(filePath, `- ${target.label} :: ${target.text}`)
    await dismissSuggestion(filesystem.port, filePath, target, now)
    filesystem.seedFile(filePath, [
      "- A new label :: refresh\t the   PR description",
      `- ${target.label} :: refresh the PR description with tests`,
      "- Other :: Refresh the PR description",
    ].join("\n"))

    expect(await loadSuggestions(filesystem.port, filePath)).toEqual([
      { label: target.label, text: "refresh the PR description with tests" },
      { label: "Other", text: "Refresh the PR description" },
    ])
  })

  test("reads dismissals beside a relative suggestions path", async () => {
    const filesystem = new InMemoryFileSystem()
    filesystem.seedFile("suggestions.md", `- ${target.label} :: ${target.text}`)
    await dismissSuggestion(filesystem.port, "suggestions.md", target, now)
    filesystem.seedFile("suggestions.md", `- Renamed :: ${target.text}`)

    expect(await loadSuggestions(filesystem.port, "suggestions.md")).toEqual([])
    expect(filesystem.fileContents("suggestions-dismissed.md")).toContain(target.text)
  })

  test("keeps only the latest 50 valid records without deleting prose or malformed lines", async () => {
    const filesystem = new InMemoryFileSystem()
    const records = Array.from({ length: 50 }, (_, index) => dismissalLine(`Label ${index}`, `prompt ${index}`))
    const prose = "# Human heading\r\n\r\nA note.\r\n- {broken record}\r\n"
    filesystem.seedFile(dismissedPath, prose + records.join("\r\n") + "\r\n")
    filesystem.seedFile(filePath, "- New :: prompt 50")

    await dismissSuggestion(filesystem.port, filePath, { label: "New", text: "prompt 50" }, now)

    const history = filesystem.fileContents(dismissedPath)
    expect(history.startsWith(prose)).toBe(true)
    expect(history).not.toContain(dismissalLine("Label 0", "prompt 0"))
    expect(history).toContain(records[1])
    expect(history).toContain(dismissalLine("New", "prompt 50"))
    expect(parseDismissedSuggestions(history).size).toBe(50)
    filesystem.seedFile(filePath, "- Expired :: prompt 0\n- Retained :: prompt 1\n- Latest :: prompt 50")
    expect(await loadSuggestions(filesystem.port, filePath)).toEqual([{ label: "Expired", text: "prompt 0" }])
  })

  test("uses only the latest 50 entries when loading an oversized history", () => {
    const markdown = Array.from({ length: 51 }, (_, index) => dismissalLine("Label", `prompt ${index}`)).join("\n")
    const dismissed = parseDismissedSuggestions(markdown)

    expect(dismissed.size).toBe(50)
    expect(dismissed.has("prompt 0")).toBe(false)
    expect(dismissed.has("prompt 50")).toBe(true)
  })

  test("preserves a replacement prompt under the same label written before removal", async () => {
    const filesystem = new InMemoryFileSystem()
    filesystem.seedFile(filePath, `- ${target.label} :: ${target.text}`)
    const replacement = `- ${target.label} :: ${target.text} with tests`
    const changingPort: FileSystemPort = {
      ...filesystem.port,
      rename: async (fromPath, toPath) => {
        await filesystem.port.rename(fromPath, toPath)
        if (toPath === dismissedPath) filesystem.seedFile(filePath, replacement)
      },
    }

    await dismissSuggestion(changingPort, filePath, target, now)

    expect(filesystem.fileContents(filePath)).toBe(replacement)
    expect(await loadSuggestions(filesystem.port, filePath)).toEqual([{ label: target.label, text: `${target.text} with tests` }])
  })

  test("does not create dismissal history for sent suggestions", async () => {
    const filesystem = new InMemoryFileSystem()
    filesystem.seedFile(filePath, `- ${target.label} :: ${target.text}`)

    await sendSuggestion(filesystem.port, filePath, target, async () => {})

    expect(await filesystem.port.exists(dismissedPath)).toBe(false)
    filesystem.seedFile(filePath, `- Renamed :: ${target.text}`)
    expect(await loadSuggestions(filesystem.port, filePath)).toEqual([{ label: "Renamed", text: target.text }])
  })

  test("records dismissal even if the suggestion file has already disappeared", async () => {
    const filesystem = new InMemoryFileSystem()

    await dismissSuggestion(filesystem.port, filePath, target, now)

    expect([...parseDismissedSuggestions(filesystem.fileContents(dismissedPath))]).toEqual([target.text])
    expect(await filesystem.port.exists(filePath)).toBe(false)
  })

  test("preserves an unreadable history and leaves the suggestion untouched", async () => {
    const filesystem = new InMemoryFileSystem()
    const markdown = `- ${target.label} :: ${target.text}`
    filesystem.seedFile(filePath, markdown)
    filesystem.seedFile(dismissedPath, "Human notes.")
    const unreadablePort: FileSystemPort = {
      ...filesystem.port,
      readFile: async (path) => {
        if (path === dismissedPath) throw new Error("EACCES: history unreadable")
        return filesystem.port.readFile(path)
      },
    }

    await expect(dismissSuggestion(unreadablePort, filePath, target, now)).rejects.toThrow("history unreadable")
    await expect(loadSuggestions(unreadablePort, filePath)).rejects.toThrow("history unreadable")
    expect(filesystem.fileContents(filePath)).toBe(markdown)
    expect(filesystem.fileContents(dismissedPath)).toBe("Human notes.")
    expect(filesystem.renames).toHaveLength(0)
  })

  test("a failed history write leaves both original files intact", async () => {
    const filesystem = new InMemoryFileSystem()
    const markdown = `- ${target.label} :: ${target.text}`
    filesystem.seedFile(filePath, markdown)
    filesystem.seedFile(dismissedPath, "Human notes.\n")
    const failingPort: FileSystemPort = {
      ...filesystem.port,
      writeFile: async () => {
        throw new Error("history write failed")
      },
    }

    await expect(dismissSuggestion(failingPort, filePath, target, now)).rejects.toThrow("history write failed")
    expect(filesystem.fileContents(filePath)).toBe(markdown)
    expect(filesystem.fileContents(dismissedPath)).toBe("Human notes.\n")
    expect(filesystem.renames).toHaveLength(0)
  })

  test("a failed history rename leaves both original files intact", async () => {
    const filesystem = new InMemoryFileSystem()
    const markdown = `- ${target.label} :: ${target.text}`
    filesystem.seedFile(filePath, markdown)
    filesystem.seedFile(dismissedPath, "Human notes.\n")
    const failingPort: FileSystemPort = {
      ...filesystem.port,
      rename: async () => {
        throw new Error("history rename failed")
      },
    }

    await expect(dismissSuggestion(failingPort, filePath, target, now)).rejects.toThrow("history rename failed")
    expect(filesystem.fileContents(filePath)).toBe(markdown)
    expect(filesystem.fileContents(dismissedPath)).toBe("Human notes.\n")
    expect(filesystem.renames).toHaveLength(0)
  })

  test("a failed removal keeps the persisted dismissal so the leftover line stays hidden", async () => {
    const filesystem = new InMemoryFileSystem()
    const markdown = `- ${target.label} :: ${target.text}`
    filesystem.seedFile(filePath, markdown)
    const failingPort: FileSystemPort = {
      ...filesystem.port,
      rename: async (fromPath, toPath) => {
        if (toPath === filePath) throw new Error("suggestion removal failed")
        await filesystem.port.rename(fromPath, toPath)
      },
    }

    await expect(dismissSuggestion(failingPort, filePath, target, now)).rejects.toThrow("suggestion removal failed")
    expect(filesystem.fileContents(filePath)).toBe(markdown)
    expect(await loadSuggestions(filesystem.port, filePath)).toEqual([])
    expect(filesystem.renames.map((entry) => entry.toPath)).toEqual([dismissedPath])
  })

  test("an unreadable suggestion file is not overwritten after dismissal is persisted", async () => {
    const filesystem = new InMemoryFileSystem()
    const markdown = `- ${target.label} :: ${target.text}`
    filesystem.seedFile(filePath, markdown)
    const unreadablePort: FileSystemPort = {
      ...filesystem.port,
      readFile: async (path) => {
        if (path === filePath) throw new Error("suggestions unreadable")
        return filesystem.port.readFile(path)
      },
    }

    await expect(dismissSuggestion(unreadablePort, filePath, target, now)).rejects.toThrow("suggestions unreadable")
    expect(filesystem.fileContents(filePath)).toBe(markdown)
    expect([...parseDismissedSuggestions(filesystem.fileContents(dismissedPath))]).toEqual([target.text])
  })
})
