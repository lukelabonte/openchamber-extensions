import { describe, expect, test } from "bun:test"
import { InMemoryFileSystem } from "./helpers/in-memory-file-system"
import { loadSuggestions, parseSuggestions, removeSuggestion, sendSuggestion, suggestionsPath } from "../service/suggestions"
import type { FileSystemPort } from "../service/file-system"

const onDisk = [
  "# Suggestions",
  "",
  "- Update the PR description :: please refresh the pull-request description with the final summary",
  "- Bump the CI timeout :: bump the CI timeout to 20 minutes",
  "",
  "Prose the coordinator keeps around.",
  "",
].join("\n")

describe("parseSuggestions", () => {
  test("parses one `- label :: text` line into label and text", () => {
    expect(parseSuggestions("- Update the PR description :: please refresh it")).toEqual([
      { label: "Update the PR description", text: "please refresh it" },
    ])
  })

  test("parses every well-formed line and tolerates padding around the separator", () => {
    const parsed = parseSuggestions(onDisk)
    expect(parsed).toEqual([
      { label: "Update the PR description", text: "please refresh the pull-request description with the final summary" },
      { label: "Bump the CI timeout", text: "bump the CI timeout to 20 minutes" },
    ])
  })

  test("ignores headings, prose, blank lines, and bullets that are not the strict `- ` form", () => {
    const parsed = parseSuggestions(
      ["# Suggestions", "", "Prose.", "- a bullet with no separator", "-Broken spacing :: no dash-space"].join("\n"),
    )
    // Strict markdown form: only `- ` bullets carry the `::` separator; a
    // dash without the space is prose, not a suggestion line.
    expect(parsed).toEqual([])
  })

  test("surfaces duplicate labels as separate entries for the service layer to reject", () => {
    // The parse stays raw: both lines with the same label come through, so
    // the service can see the ambiguity and refuse the action with 409
    // instead of silently resolving to whichever entry came first.
    expect(parseSuggestions(["- Twice :: first copy", "- Twice :: second copy"].join("\n"))).toEqual([
      { label: "Twice", text: "first copy" },
      { label: "Twice", text: "second copy" },
    ])
  })
})

describe("loadSuggestions", () => {
  test("answers an empty list when the file does not exist yet", async () => {
    const filesystem = new InMemoryFileSystem()
    expect(await loadSuggestions(filesystem.port, "/home/projects/sunrise/suggestions.md")).toEqual([])
  })

  test("parses the file on disk", async () => {
    const filesystem = new InMemoryFileSystem()
    filesystem.seedFile("/home/projects/sunrise/suggestions.md", onDisk)
    expect(await loadSuggestions(filesystem.port, "/home/projects/sunrise/suggestions.md")).toHaveLength(2)
  })
})

describe("removeSuggestion", () => {
  test("drops the labeled line and keeps everything else byte-for-byte", async () => {
    const filesystem = new InMemoryFileSystem()
    const filePath = "/home/projects/sunrise/suggestions.md"
    filesystem.seedFile(filePath, onDisk)

    await removeSuggestion(filesystem.port, filePath, "Bump the CI timeout")

    expect(filesystem.fileContents(filePath)).toBe(
      [
        "# Suggestions",
        "",
        "- Update the PR description :: please refresh the pull-request description with the final summary",
        "",
        "Prose the coordinator keeps around.",
        "",
      ].join("\n"),
    )
  })

  test("removes every line with the label, but not labels sharing its prefix", async () => {
    const filesystem = new InMemoryFileSystem()
    const filePath = "/home/projects/sunrise/suggestions.md"
    filesystem.seedFile(
      filePath,
      ["- run ci :: once", "- run ci later :: twice", "- keep me :: stay"].join("\n"),
    )

    await removeSuggestion(filesystem.port, filePath, "run ci")

    // Exact label match: the parsed label of "- run ci later :: twice" is
    // "run ci later", not "run ci", so that line stays.
    expect(parseSuggestions(filesystem.fileContents(filePath))).toEqual([
      { label: "run ci later", text: "twice" },
      { label: "keep me", text: "stay" },
    ])
  })

  test("is a no-op when the file does not exist", async () => {
    const filesystem = new InMemoryFileSystem()
    await removeSuggestion(filesystem.port, "/home/projects/sunrise/suggestions.md", "any")
    expect(await loadSuggestions(filesystem.port, "/home/projects/sunrise/suggestions.md")).toEqual([])
  })
})

describe("sendSuggestion", () => {
  const target = { label: "Bump the CI timeout", text: "bump the CI timeout to 20 minutes" }

  test("sends exactly once and removes only the target line, keeping the rest byte-for-byte", async () => {
    const filesystem = new InMemoryFileSystem()
    const filePath = "/home/projects/sunrise/suggestions.md"
    filesystem.seedFile(filePath, onDisk)
    const sentTexts: string[] = []

    const outcome = await sendSuggestion(filesystem.port, filePath, target, async (text) => {
      sentTexts.push(text)
    })

    expect(outcome).toEqual({ sent: true })
    expect(sentTexts).toEqual(["bump the CI timeout to 20 minutes"])
    expect(parseSuggestions(filesystem.fileContents(filePath))).toEqual([
      { label: "Update the PR description", text: "please refresh the pull-request description with the final summary" },
    ])
    expect(filesystem.fileContents(filePath)).toContain("Prose the coordinator keeps around.")
  })

  test("a rejected send propagates and leaves the file untouched", async () => {
    const filesystem = new InMemoryFileSystem()
    const filePath = "/home/projects/sunrise/suggestions.md"
    filesystem.seedFile(filePath, onDisk)

    await expect(
      sendSuggestion(filesystem.port, filePath, target, async () => {
        throw new Error("no such session")
      }),
    ).rejects.toThrow("no such session")

    // Nothing was removed: the suggestion is ready to press again.
    expect(parseSuggestions(filesystem.fileContents(filePath))).toEqual([
      { label: "Update the PR description", text: "please refresh the pull-request description with the final summary" },
      { label: "Bump the CI timeout", text: "bump the CI timeout to 20 minutes" },
    ])
  })

  test("a failed removal after a successful send answers sent with a warning, never a retry claim", async () => {
    const filesystem = new InMemoryFileSystem()
    const filePath = "/home/projects/sunrise/suggestions.md"
    filesystem.seedFile(filePath, onDisk)
    // The shared in-memory port with only the write overridden: the remove's
    // readFile succeeds, its writeFile is what fails — no real-disk tricks.
    const rejectingWrite: FileSystemPort = {
      ...filesystem.port,
      writeFile: async () => {
        throw new Error("EACCES: permission denied")
      },
    }
    let sendCount = 0

    const outcome = await sendSuggestion(rejectingWrite, filePath, target, async () => {
      sendCount += 1
    })

    // The coordinator already has the message, so the answer must not throw
    // and must not deny the send — it reports the leftover line as a warning.
    expect(outcome.sent).toBe(true)
    expect(typeof outcome.warning).toBe("string")
    expect(outcome.warning?.includes(filePath)).toBe(true)
    expect(sendCount).toBe(1)
    // The line could not leave the file.
    expect(filesystem.fileContents(filePath)).toContain("Bump the CI timeout")
  })
})

describe("suggestionsPath", () => {
  test("lives in the project home", () => {
    expect(suggestionsPath("/home", "sunrise")).toBe("/home/projects/sunrise/suggestions.md")
  })
})
