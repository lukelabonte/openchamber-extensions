import { describe, expect, test } from "bun:test"
import { boardColumnOrder, type BoardWorkerState } from "../panel/board"
import { moveColumn, parseColumnOrder } from "../panel/column-order"

describe("parseColumnOrder", () => {
  test("defaults missing, malformed, and empty values to the existing board order", () => {
    for (const value of [undefined, null, "Working", {}, 42, []]) {
      expect(parseColumnOrder(value)).toEqual([...boardColumnOrder])
    }
  })

  test("keeps valid states in their saved order, deduplicates, and appends missing states", () => {
    expect(parseColumnOrder(["Done", "Working", "Done", "unknown", null, 12, "queued", "Queued"])).toEqual([
      "Done", "Working", "Queued", "Blocked", "Parked", "Failed", "Idle",
    ])
  })

  test("preserves a complete saved order without modifying input or returning the shared default", () => {
    const saved = Object.freeze([...boardColumnOrder].reverse())
    const parsed = parseColumnOrder(saved)

    expect(parsed).toEqual([...saved])
    expect(parsed).not.toBe(saved)
    const defaultOrder = parseColumnOrder(undefined)
    defaultOrder.reverse()
    expect(parseColumnOrder(undefined)).toEqual(["Queued", "Working", "Blocked", "Parked", "Done", "Failed", "Idle"])
  })
})

describe("moveColumn", () => {
  test("moves a column up by swapping it with its immediate neighbor", () => {
    expect(moveColumn(boardColumnOrder, "Blocked", "up")).toEqual([
      "Queued", "Blocked", "Working", "Parked", "Done", "Failed", "Idle",
    ])
  })

  test("moves a column down by swapping it with its immediate neighbor", () => {
    expect(moveColumn(boardColumnOrder, "Blocked", "down")).toEqual([
      "Queued", "Working", "Parked", "Blocked", "Done", "Failed", "Idle",
    ])
  })

  test("boundary moves return an unchanged copy without wrapping", () => {
    const order = Object.freeze([...boardColumnOrder])
    for (const moved of [moveColumn(order, "Queued", "up"), moveColumn(order, "Idle", "down")]) {
      expect(moved).toEqual([...order])
      expect(moved).not.toBe(order)
    }
  })

  test("handles missing states and empty orders without adding columns", () => {
    expect(moveColumn([], "Done", "up")).toEqual([])
    expect(moveColumn(["Working"], "Done", "down")).toEqual(["Working"])
  })

  test("keeps the supplied order and never mutates its input", () => {
    const order: readonly BoardWorkerState[] = Object.freeze(["Done", "Working", "Queued"])

    expect(moveColumn(order, "Working", "up")).toEqual(["Working", "Done", "Queued"])
    expect(order).toEqual(["Done", "Working", "Queued"])
  })
})
