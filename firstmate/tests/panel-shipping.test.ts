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

const landing = {
  task: "Ship login",
  commit: "1a2b3c4d",
  ci: "green",
  mode: "reviewed-PR+yolo",
  authorization: "+yolo",
  landedAt: "2026-10-01T10:00:00.000Z",
}

describe("parseShipping", () => {
  test("parses a well-formed payload, landings and landing errors included", () => {
    expect(
      parseShipping({
        mode: "reviewed-PR",
        yolo: true,
        landings: [landing],
        landingErrors: ["line 9: the entry \"Broken entry\" has no ci line"],
      }),
    ).toEqual({
      mode: "reviewed-PR",
      yolo: true,
      landings: [landing],
      landingErrors: ["line 9: the entry \"Broken entry\" has no ci line"],
    })
  })

  test("a payload without the landing fields keeps the badge and defaults the lists to empty", () => {
    expect(parseShipping({ mode: "reviewed-PR", yolo: true })).toEqual({
      mode: "reviewed-PR",
      yolo: true,
      landings: [],
      landingErrors: [],
    })
    expect(parseShipping({ mode: null, yolo: false })).toEqual({ mode: null, yolo: false, landings: [], landingErrors: [] })
  })

  test("carries an optional pr url through when the service row already has one", () => {
    const row = { ...landing, pr: "https://example.com/pull/7" }
    const parsed = parseShipping({ mode: "direct-PR", yolo: false, landings: [row] })
    expect(parsed?.landings).toEqual([row])
  })

  test("drops malformed landing rows and non-string errors without misleading data", () => {
    const parsed = parseShipping({
      mode: "direct-PR",
      yolo: false,
      landings: [
        "not an object",
        null,
        { task: "no fields" },
        { ...landing, commit: 7 },
        landing,
      ],
      landingErrors: ["line 9: the entry \"Broken entry\" has no ci line", 7, null, { line: 2, message: "not a string" }],
    })
    expect(parsed).toEqual({
      mode: "direct-PR",
      yolo: false,
      landings: [landing],
      landingErrors: ["line 9: the entry \"Broken entry\" has no ci line"],
    })
  })

  test("a malformed payload yields no badge", () => {
    expect(parseShipping(undefined)).toBeUndefined()
    expect(parseShipping("nope")).toBeUndefined()
    expect(parseShipping({ mode: "direct-PR" })).toBeUndefined() // missing yolo
    expect(parseShipping({ mode: 7, yolo: false })).toBeUndefined() // non-string mode
    expect(parseShipping({ mode: null, yolo: "yes" })).toBeUndefined() // non-boolean yolo
  })
})

describe("landing cleanup parsing", () => {
  const landingWith = (cleanup: unknown) => ({ ...landing, cleanup })

  test("carries valid pending, removed, and unknown cleanup claims through exactly", () => {
    expect(
      parseShipping({
        mode: "direct-PR",
        yolo: false,
        landings: [
          landingWith({ worktree: "/repos/sunrise/.worktrees/fm/login-fix", state: "pending" }),
          landingWith({ worktree: "/repos/sunrise/.worktrees/fm/login-fix", state: "removed" }),
          landingWith({ worktree: "/repos/sunrise/.worktrees/fm/login-fix", state: "unknown" }),
        ],
        landingErrors: [],
      })?.landings,
    ).toEqual([
      { ...landing, cleanup: { worktree: "/repos/sunrise/.worktrees/fm/login-fix", state: "pending" } },
      { ...landing, cleanup: { worktree: "/repos/sunrise/.worktrees/fm/login-fix", state: "removed" } },
      { ...landing, cleanup: { worktree: "/repos/sunrise/.worktrees/fm/login-fix", state: "unknown" } },
    ])
  })

  test("an invalid cleanup claim drops only the cleanup field, not the landing", () => {
    const parsed = parseShipping({
      mode: "direct-PR",
      yolo: false,
      landings: [
        landingWith({ worktree: "", state: "pending" }), // empty worktree path
        landingWith({ worktree: "/repos/sunrise/.worktrees/fm/login-fix", state: "deleted" }), // bad state
        landingWith("pending"), // not an object
        landing, // no cleanup claim at all
      ],
      landingErrors: [],
    })
    expect(parsed?.landings).toEqual([landing, landing, landing, landing])
  })

  test("carries a string top-level cleanupError and drops a non-string one", () => {
    expect(
      parseShipping({ mode: "direct-PR", yolo: false, landings: [], landingErrors: [], cleanupError: "the backlog could not be read" }),
    ).toEqual({
      mode: "direct-PR",
      yolo: false,
      landings: [],
      landingErrors: [],
      cleanupError: "the backlog could not be read",
    })
    expect(parseShipping({ mode: "direct-PR", yolo: false, landings: [], landingErrors: [], cleanupError: 7 })).toEqual({
      mode: "direct-PR",
      yolo: false,
      landings: [],
      landingErrors: [],
    })
  })
})

describe("shippingBadgeLabel", () => {
  test("labels the unset state plainly", () => {
    expect(shippingBadgeLabel({ mode: null, yolo: false, landings: [], landingErrors: [] })).toBe("mode unset")
  })

  test("labels the mode with its +yolo suffix", () => {
    expect(shippingBadgeLabel({ mode: "direct-PR", yolo: false, landings: [], landingErrors: [] })).toBe("direct-PR")
    expect(shippingBadgeLabel({ mode: "reviewed-PR", yolo: true, landings: [], landingErrors: [] })).toBe("reviewed-PR+yolo")
  })
})

describe("panel shipping state", () => {
  test("a loaded shipping mode is stored while registered", () => {
    const state = reduceAll(registeredState(), {
      type: "shipping-loaded",
      shipping: { mode: "local-only", yolo: false, landings: [], landingErrors: [] },
    })
    expect(state).toMatchObject({ kind: "registered", shipping: { mode: "local-only", yolo: false } })
  })

  test("a loaded shipping payload keeps its landing rows and parse errors", () => {
    const state = reduceAll(registeredState(), {
      type: "shipping-loaded",
      shipping: {
        mode: "direct-PR",
        yolo: false,
        landings: [landing],
        landingErrors: ["line 9: the entry \"Broken entry\" has no ci line"],
      },
    })
    expect(state).toMatchObject({
      kind: "registered",
      shipping: {
        mode: "direct-PR",
        yolo: false,
        landings: [landing],
        landingErrors: ["line 9: the entry \"Broken entry\" has no ci line"],
      },
    })
  })

  test("shipping events are ignored while the project is not registered", () => {
    const state = reduceAll(initialPanelState(), {
      type: "shipping-loaded",
      shipping: { mode: "direct-PR", yolo: true, landings: [], landingErrors: [] },
    })
    expect(state).toEqual({ kind: "loading" })
  })
})
