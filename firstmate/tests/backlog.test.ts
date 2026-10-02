import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { formatBacklogEntry, loadBacklog, parseBacklog, type BacklogTask } from "../service/backlog"
import { InMemoryFileSystem } from "./helpers/in-memory-file-system"

const fullTask: BacklogTask = {
  title: "Add dark mode",
  state: "Working",
  sessionId: "ses_8f3a21",
  worktreeDirectory: "/repos/sunrise/.worktrees/fm/dark-mode",
  branch: "fm/dark-mode",
  startRef: "1a2b3c4d",
  prUrl: "https://github.com/example/sunrise/pull/12",
  createdAt: "2026-10-01T09:30:00Z",
  updatedAt: "2026-10-01T09:45:00Z",
}

describe("parseBacklog", () => {
  test("round-trips a fully-filled entry through format and parse", () => {
    expect(parseBacklog(formatBacklogEntry(fullTask))).toEqual({ tasks: [fullTask], errors: [] })
  })

  test("round-trips a queued task that has no worker yet", () => {
    const task: BacklogTask = {
      title: "Add dark mode",
      state: "Queued",
      createdAt: "2026-10-01T09:30:00Z",
      updatedAt: "2026-10-01T09:30:00Z",
    }
    expect(parseBacklog(formatBacklogEntry(task))).toEqual({ tasks: [task], errors: [] })
  })

  test("parses entries out of a file a human has edited prose around", () => {
    const markdown = [
      "# Backlog",
      "",
      "Notes to self: prune the stale worktrees some day.",
      "",
      "## In flight",
      "",
      "- Add dark mode",
      "  state: Working",
      "  session: ses_8f3a21",
      "",
      "## Done",
      "",
      "- Fix flaky login test",
      "  state: Done",
      "  session: ses_11bb",
      "  pr: https://github.com/example/sunrise/pull/11",
      "",
      "The captain asked to keep an eye on CI times.",
    ].join("\n")
    const parsed = parseBacklog(markdown)
    expect(parsed.errors).toEqual([])
    expect(parsed.tasks).toEqual([
      { title: "Add dark mode", state: "Working", sessionId: "ses_8f3a21" },
      {
        title: "Fix flaky login test",
        state: "Done",
        sessionId: "ses_11bb",
        prUrl: "https://github.com/example/sunrise/pull/11",
      },
    ])
  })

  test("ships a default template that parses to no tasks and no errors", () => {
    const template = readFileSync(path.join(import.meta.dir, "..", "templates", "backlog.md"), "utf8")
    expect(parseBacklog(template)).toEqual({ tasks: [], errors: [] })
  })

  test("ignores example entries inside code fences", () => {
    const markdown = ["```", "- Not a task", "  state: Working", "```"].join("\n")
    expect(parseBacklog(markdown)).toEqual({ tasks: [], errors: [] })
  })

  test("collects an unknown state as an error and keeps the good entries", () => {
    const markdown = ["- Mystery task", "  state: Woking", "", "- Fix flaky login test", "  state: Done"].join("\n")
    const parsed = parseBacklog(markdown)
    expect(parsed.tasks).toEqual([{ title: "Fix flaky login test", state: "Done" }])
    expect(parsed.errors).toEqual([{ line: 2, message: expect.stringContaining("Woking") }])
  })

  test("collects an entry with no state line", () => {
    const markdown = ["- Mystery task", "  session: ses_1"].join("\n")
    const parsed = parseBacklog(markdown)
    expect(parsed.tasks).toEqual([])
    expect(parsed.errors).toEqual([{ line: 1, message: expect.stringContaining("state") }])
  })

  test("collects an unknown field key", () => {
    const markdown = ["- Mystery task", "  state: Queued", "  colour: blue"].join("\n")
    const parsed = parseBacklog(markdown)
    expect(parsed.tasks).toEqual([])
    expect(parsed.errors).toEqual([{ line: 3, message: expect.stringContaining("colour") }])
  })

  test("collects an indented line that is not a key: value field", () => {
    const markdown = ["- Mystery task", "  state: Queued", "  waiting on the captain"].join("\n")
    const parsed = parseBacklog(markdown)
    expect(parsed.tasks).toEqual([])
    expect(parsed.errors).toEqual([{ line: 3, message: expect.stringContaining("key: value") }])
  })

  test("collects a field line with no entry above it", () => {
    const markdown = ["Some prose first.", "", "  state: Queued"].join("\n")
    const parsed = parseBacklog(markdown)
    expect(parsed.tasks).toEqual([])
    expect(parsed.errors).toEqual([{ line: 3, message: expect.stringContaining("no entry") }])
  })

  test("collects a timestamp field that is not a timestamp", () => {
    const markdown = ["- Mystery task", "  state: Queued", "  created: yesterday"].join("\n")
    const parsed = parseBacklog(markdown)
    expect(parsed.tasks).toEqual([])
    expect(parsed.errors).toEqual([{ line: 3, message: expect.stringContaining("timestamp") }])
  })

  test("collects a repeated field key instead of silently keeping the last value", () => {
    const markdown = [
      "- Fix flaky login test",
      "  state: Done",
      "  session: ses_11bb",
      "  state: Working",
    ].join("\n")
    const parsed = parseBacklog(markdown)
    expect(parsed.tasks).toEqual([])
    expect(parsed.errors).toEqual([{ line: 4, message: expect.stringContaining("repeats the \"state\" field") }])
  })
})

describe("loadBacklog", () => {
  test("reads and parses the backlog file through the filesystem port", async () => {
    const filesystem = new InMemoryFileSystem()
    filesystem.seedFile("/home/firstmate/projects/sunrise/backlog.md", "- Fix flaky login test\n  state: Done\n")
    const backlog = await loadBacklog(filesystem.port, "/home/firstmate/projects/sunrise/backlog.md")
    expect(backlog.tasks).toEqual([{ title: "Fix flaky login test", state: "Done" }])
  })

  test("rejects when the backlog file is missing", async () => {
    const filesystem = new InMemoryFileSystem()
    await expect(loadBacklog(filesystem.port, "/home/firstmate/projects/sunrise/backlog.md")).rejects.toThrow()
  })
})
