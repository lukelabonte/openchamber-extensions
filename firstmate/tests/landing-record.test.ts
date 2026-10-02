import { describe, expect, test } from "bun:test"
import {
  appendLandingRecord,
  formatLandingRecord,
  landingRecordPath,
  loadLandingRecords,
  parseLandingRecords,
  type LandingRecord,
} from "../service/landing-record"
import { InMemoryFileSystem } from "./helpers/in-memory-file-system"

const record: LandingRecord = {
  task: "Fix flaky login test",
  commit: "1a2b3c4d",
  ci: "green",
  mode: "reviewed-PR+yolo",
  authorization: "+yolo",
  landedAt: "2026-10-01T12:00:00.000Z",
}

describe("appendLandingRecord", () => {
  test("creates the log with a header and the record's fields", async () => {
    const filesystem = new InMemoryFileSystem()
    await appendLandingRecord(filesystem.port, "/home", "sunrise", record)
    const contents = filesystem.fileContents(landingRecordPath("/home", "sunrise"))
    expect(contents).toContain("# Landings")
    expect(contents).toContain("- Fix flaky login test")
    expect(contents).toContain("commit: 1a2b3c4d")
    expect(contents).toContain("ci: green")
    expect(contents).toContain("mode: reviewed-PR+yolo")
    expect(contents).toContain("authorization: +yolo")
    expect(contents).toContain("landed: 2026-10-01T12:00:00.000Z")
  })

  test("appends to an existing log without repeating the header", async () => {
    const filesystem = new InMemoryFileSystem()
    const second: LandingRecord = { ...record, task: "Add dark mode", authorization: "captain's word" }
    await appendLandingRecord(filesystem.port, "/home", "sunrise", record)
    await appendLandingRecord(filesystem.port, "/home", "sunrise", second)
    const contents = filesystem.fileContents(landingRecordPath("/home", "sunrise"))
    expect(contents.match(/# Landings/g)).toHaveLength(1)
    expect(parseLandingRecords(contents).records).toEqual([record, second])
  })
})

describe("parseLandingRecords", () => {
  test("collects a malformed entry as an error and keeps the rest", () => {
    const log = parseLandingRecords(
      [
        "- Good landing",
        "  commit: 1a2b3c4d",
        "  ci: green",
        "  mode: direct-PR",
        "  authorization: captain's word",
        "  landed: 2026-10-01T12:00:00.000Z",
        "- Mystery landing",
        "  commit: deadbeef",
        "  pr: https://github.com/example/sunrise/pull/11",
        "",
      ].join("\n"),
    )
    expect(log.records).toEqual([
      {
        task: "Good landing",
        commit: "1a2b3c4d",
        ci: "green",
        mode: "direct-PR",
        authorization: "captain's word",
        landedAt: "2026-10-01T12:00:00.000Z",
      },
    ])
    expect(log.errors).toHaveLength(1)
    expect(log.errors[0].message).toContain("Mystery landing")
    expect(log.errors[0].line).toBe(9)
  })

  test("an entry missing a required field is an error", () => {
    const log = parseLandingRecords(
      [
        "- Half-recorded landing",
        "  commit: 1a2b3c4d",
        "  ci: green",
        "  mode: direct-PR",
        "  authorization: +yolo",
      ].join("\n"),
    )
    expect(log.records).toEqual([])
    expect(log.errors[0].message).toContain("landed")
  })

  test("an unknown authorization and a non-timestamp landed are errors", () => {
    const badAuthorization = parseLandingRecords(
      [
        "- Eager landing",
        "  commit: 1a2b3c4d",
        "  ci: green",
        "  mode: direct-PR",
        "  authorization: because",
        "  landed: 2026-10-01T12:00:00.000Z",
      ].join("\n"),
    )
    expect(badAuthorization.records).toEqual([])
    expect(badAuthorization.errors[0].message).toContain("authorization")

    const badTimestamp = parseLandingRecords(
      [
        "- Timely landing",
        "  commit: 1a2b3c4d",
        "  ci: green",
        "  mode: direct-PR",
        "  authorization: +yolo",
        "  landed: yesterday",
      ].join("\n"),
    )
    expect(badTimestamp.records).toEqual([])
    expect(badTimestamp.errors[0].message).toContain("landed")
  })

  test("prose and headings between entries are ignored", () => {
    const log = parseLandingRecords(
      [
        "# Landings",
        "",
        "One landing per entry.",
        "",
        "- Only landing",
        "  commit: 1a2b3c4d",
        "  ci: green",
        "  mode: local-only",
        "  authorization: captain's word",
        "  landed: 2026-10-01T12:00:00.000Z",
        "",
      ].join("\n"),
    )
    expect(log.records.map((landing) => landing.task)).toEqual(["Only landing"])
    expect(log.errors).toEqual([])
  })
})

describe("loadLandingRecords", () => {
  test("a missing log is an empty list", async () => {
    const filesystem = new InMemoryFileSystem()
    const log = await loadLandingRecords(filesystem.port, "/home", "sunrise")
    expect(log.records).toEqual([])
    expect(log.errors).toEqual([])
  })

  test("reads back what the writer appended", async () => {
    const filesystem = new InMemoryFileSystem()
    await appendLandingRecord(filesystem.port, "/home", "sunrise", record)
    const log = await loadLandingRecords(filesystem.port, "/home", "sunrise")
    expect(log.records).toEqual([record])
  })

  test("format → append → parse round-trips the exact record, every field", async () => {
    expect(parseLandingRecords(formatLandingRecord(record)).records).toEqual([record])
    const filesystem = new InMemoryFileSystem()
    await appendLandingRecord(filesystem.port, "/home", "sunrise", record)
    const parsed = parseLandingRecords(filesystem.fileContents(landingRecordPath("/home", "sunrise")))
    expect(parsed.records).toEqual([record])
    expect(parsed.errors).toEqual([])
  })
})
