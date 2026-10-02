import { describe, expect, test } from "bun:test"
import { groupBoardColumns, parseBoardWorkers, toBoardCard } from "../panel/board"

describe("board columns", () => {
  test("hides empty columns and orders the rest in board order", () => {
    const columns = groupBoardColumns([
      { title: "Ship login", state: "Working" },
      { title: "Fix flake", state: "Done" },
      { title: "Spike telemetry", state: "Queued" },
    ])
    expect(columns.map((column) => column.id)).toEqual(["Queued", "Working", "Done"])
  })

  test("keeps workers of the same state in one column", () => {
    const columns = groupBoardColumns([
      { title: "Ship login", state: "Working" },
      { title: "Fix flake", state: "Working" },
    ])
    expect(columns).toHaveLength(1)
    expect(columns[0].cards.map((card) => card.title)).toEqual(["Ship login", "Fix flake"])
  })

  test("an empty board has no columns", () => {
    expect(groupBoardColumns([])).toEqual([])
  })
})

describe("card mapping", () => {
  test("carries the state and blocked reason into the card", () => {
    const card = toBoardCard({ title: "Ship login", state: "Blocked", blockedReason: "question" })
    expect(card.state).toBe("Blocked")
    expect(card.blockedReason).toBe("question")
  })

  test("omits a missing last word, pull request, and warning", () => {
    const card = toBoardCard({ title: "Ship login", state: "Queued" })
    expect(card.lastWord).toBeUndefined()
    expect(card.prUrl).toBeUndefined()
    expect(card.warning).toBeUndefined()
  })

  test("marks an http(s) pull-request link openable, scheme case-insensitively", () => {
    const card = toBoardCard({ title: "t", state: "Queued", prUrl: "https://example.com/pr/1" })
    expect(card.prUrl).toBe("https://example.com/pr/1")
    expect(card.prOpenable).toBe(true)
    const upper = toBoardCard({ title: "t", state: "Queued", prUrl: "HTTPS://example.com/pr/1" })
    expect(upper.prOpenable).toBe(true)
  })

  test("keeps the session id and worktree for the card actions", () => {
    const card = toBoardCard({
      title: "Ship login",
      state: "Working",
      sessionId: "ses_11bb",
      worktree: "/repos/sunrise/.worktrees/fm/login-fix",
    })
    expect(card.sessionId).toBe("ses_11bb")
    expect(card.worktree).toBe("/repos/sunrise/.worktrees/fm/login-fix")
  })

  test("a card without a session id or worktree omits them", () => {
    const card = toBoardCard({ title: "t", state: "Queued" })
    expect(card.sessionId).toBeUndefined()
    expect(card.worktree).toBeUndefined()
  })

  test("keeps a non-openable pull-request link on the card without marking it openable", () => {
    const card = toBoardCard({ title: "t", state: "Queued", prUrl: "javascript:alert(1)" })
    expect(card.prUrl).toBe("javascript:alert(1)")
    expect(card.prOpenable).toBeUndefined()
  })

  test("truncates a long last word with an ellipsis", () => {
    const card = toBoardCard({ title: "t", state: "Queued", lastWord: "x".repeat(141) })
    expect(card.lastWord).toBe(`${"x".repeat(140)}…`)
  })

  test("maps a poll error to the card warning", () => {
    const card = toBoardCard({ title: "t", state: "Queued", lastPollError: "openchamber exited with code 1" })
    expect(card.warning).toBe("openchamber exited with code 1")
  })

  test("an empty title falls back to (untitled)", () => {
    expect(toBoardCard({ title: "  ", state: "Queued" }).title).toBe("(untitled)")
  })
})

describe("board worker parsing", () => {
  test("keeps well-formed workers with their optional fields", () => {
    const parsed = parseBoardWorkers([
      { title: "Ship login", state: "Working", lastWord: "on it", prUrl: "https://example.com/pr/1" },
    ])
    expect(parsed).toEqual({
      workers: [{ title: "Ship login", state: "Working", lastWord: "on it", prUrl: "https://example.com/pr/1" }],
      malformedCount: 0,
    })
  })

  test("counts and skips malformed workers", () => {
    const parsed = parseBoardWorkers([
      { title: "Ship login", state: "Working" },
      { title: 7, state: "Working" },
      { title: "t", state: "Chairman" },
      { title: "t", state: "Queued", blockedReason: "maybe" },
      { title: "t", state: "Queued", lastPollError: 9 },
      "not an object",
      null,
    ])
    expect(parsed.workers).toEqual([{ title: "Ship login", state: "Working" }])
    expect(parsed.malformedCount).toBe(6)
  })

  test("a non-array payload yields an empty board", () => {
    expect(parseBoardWorkers("nope")).toEqual({ workers: [], malformedCount: 0 })
  })
})
