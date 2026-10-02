import { describe, expect, test } from "bun:test"
import { initialPanelState, reducePanelState, type PanelEvent, type RegistrationInfo } from "../panel/state"
import { parseShipping, shippingBadgeLabel } from "../panel/shipping"

const registration: RegistrationInfo = {
  slug: "sunrise",
  projectDirectory: "/repos/sunrise",
  homeDirectory: "/home/firstmate/projects/sunrise",
  coordinatorSessionId: "ses_coord_1",
  createdAt: "2026-01-01T00:00:00.000Z",
}

function reduceAll(initial: ReturnType<typeof initialPanelState>, ...events: PanelEvent[]) {
  return events.reduce(reducePanelState, initial)
}

function registeredState() {
  return reduceAll(
    initialPanelState(),
    { type: "directory-context", directory: "/repos/sunrise" },
    { type: "lookup-succeeded", registration },
  )
}

describe("parseShipping", () => {
  test("parses a well-formed payload, landings included", () => {
    expect(
      parseShipping({ mode: "reviewed-PR", yolo: true, landings: [{ task: "Ship login" }] }),
    ).toEqual({ mode: "reviewed-PR", yolo: true })
    expect(parseShipping({ mode: null, yolo: false })).toEqual({ mode: null, yolo: false })
  })

  test("a malformed payload yields no badge", () => {
    expect(parseShipping(undefined)).toBeUndefined()
    expect(parseShipping("nope")).toBeUndefined()
    expect(parseShipping({ mode: "direct-PR" })).toBeUndefined() // missing yolo
    expect(parseShipping({ mode: 7, yolo: false })).toBeUndefined() // non-string mode
    expect(parseShipping({ mode: null, yolo: "yes" })).toBeUndefined() // non-boolean yolo
  })
})

describe("shippingBadgeLabel", () => {
  test("labels the unset state plainly", () => {
    expect(shippingBadgeLabel({ mode: null, yolo: false })).toBe("mode unset")
  })

  test("labels the mode with its +yolo suffix", () => {
    expect(shippingBadgeLabel({ mode: "direct-PR", yolo: false })).toBe("direct-PR")
    expect(shippingBadgeLabel({ mode: "reviewed-PR", yolo: true })).toBe("reviewed-PR+yolo")
  })
})

describe("panel shipping state", () => {
  test("a loaded shipping mode is stored while registered", () => {
    const state = reduceAll(registeredState(), {
      type: "shipping-loaded",
      shipping: { mode: "local-only", yolo: false },
    })
    expect(state).toMatchObject({ kind: "registered", shipping: { mode: "local-only", yolo: false } })
  })

  test("shipping events are ignored while the project is not registered", () => {
    const state = reduceAll(initialPanelState(), {
      type: "shipping-loaded",
      shipping: { mode: "direct-PR", yolo: true },
    })
    expect(state).toEqual({ kind: "loading" })
  })
})
