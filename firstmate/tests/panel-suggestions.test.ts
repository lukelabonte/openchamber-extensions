import { describe, expect, test } from "bun:test"
import { initialPanelState, reducePanelState, type PanelEvent, type RegistrationInfo } from "../panel/state"
import { parseSuggestions } from "../panel/suggestions"

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

describe("parseSuggestions", () => {
  test("parses well-formed suggestion rows", () => {
    expect(
      parseSuggestions([
        { label: "Update the PR description", text: "please refresh it" },
        { label: "Bump the CI timeout", text: "to 20 minutes" },
      ]),
    ).toEqual([
      { label: "Update the PR description", text: "please refresh it" },
      { label: "Bump the CI timeout", text: "to 20 minutes" },
    ])
  })

  test("skips malformed entries instead of throwing", () => {
    expect(parseSuggestions(undefined)).toEqual([])
    expect(parseSuggestions("nope")).toEqual([])
    expect(
      parseSuggestions([
        "not an object",
        null,
        { label: "no text" },
        { text: "no label" },
        { label: "", text: "empty label" },
        { label: "empty text", text: "" },
        { label: 7, text: "non-string label" },
      ]),
    ).toEqual([])
  })
})

describe("panel suggestions state", () => {
  test("loaded suggestions are stored while registered", () => {
    const state = reduceAll(registeredState(), {
      type: "suggestions-loaded",
      suggestions: [{ label: "Update the PR description", text: "please refresh it" }],
    })
    expect(state).toMatchObject({
      kind: "registered",
      suggestions: [{ label: "Update the PR description", text: "please refresh it" }],
      suggestionsError: undefined,
    })
  })

  test("a failed read sets the error while keeping the last read rows", () => {
    const state = reduceAll(
      registeredState(),
      { type: "suggestions-loaded", suggestions: [{ label: "keep", text: "me" }] },
      { type: "suggestions-failed", message: "unreachable" },
    )
    expect(state).toMatchObject({ kind: "registered", suggestionsError: "unreachable", suggestions: [{ label: "keep" }] })
  })

  test("suggestion events are ignored while the project is not registered", () => {
    const loaded = reduceAll(initialPanelState(), {
      type: "suggestions-loaded",
      suggestions: [{ label: "late", text: "arrival" }],
    })
    expect(loaded).toEqual({ kind: "loading" })
    const failed = reduceAll(initialPanelState(), { type: "suggestions-failed", message: "unreachable" })
    expect(failed).toEqual({ kind: "loading" })
  })
})
