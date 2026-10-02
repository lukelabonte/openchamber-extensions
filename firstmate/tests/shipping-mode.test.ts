import { describe, expect, test } from "bun:test"
import { parseShippingMode } from "../service/shipping-mode"

describe("parseShippingMode", () => {
  test("parses the three modes without a suffix", () => {
    expect(parseShippingMode("mode: direct-PR")).toEqual({ mode: "direct-PR", yolo: false })
    expect(parseShippingMode("mode: reviewed-PR")).toEqual({ mode: "reviewed-PR", yolo: false })
    expect(parseShippingMode("mode: local-only")).toEqual({ mode: "local-only", yolo: false })
  })

  test("parses the +yolo suffix attached and spaced", () => {
    expect(parseShippingMode("mode: reviewed-PR+yolo")).toEqual({ mode: "reviewed-PR", yolo: true })
    expect(parseShippingMode("mode: direct-PR +yolo")).toEqual({ mode: "direct-PR", yolo: true })
  })

  test("the template's unset default is the unset result", () => {
    expect(parseShippingMode("mode: unset — ask the captain")).toEqual({ mode: null, yolo: false })
  })

  test("no mode line at all is the unset result", () => {
    expect(parseShippingMode("# Projects\n\nNothing recorded yet.")).toEqual({ mode: null, yolo: false })
  })

  test("an unknown or empty mode value is the unset result", () => {
    expect(parseShippingMode("mode: Ship-it")).toEqual({ mode: null, yolo: false })
    expect(parseShippingMode("mode: ")).toEqual({ mode: null, yolo: false })
    expect(parseShippingMode("mode: +yolo")).toEqual({ mode: null, yolo: false })
  })

  test("mode mentions inside bullets or prose do not count", () => {
    expect(
      parseShippingMode(
        [
          "# Projects",
          "",
          "- `mode: direct-PR` — the worker pushes its branch",
          "",
          "mode: local-only",
        ].join("\n"),
      ),
    ).toEqual({ mode: "local-only", yolo: false })
  })

  test("the first top-level mode line wins", () => {
    expect(parseShippingMode("mode: direct-PR\nmode: local-only")).toEqual({ mode: "direct-PR", yolo: false })
  })
})
