import { describe, expect, test } from "bun:test"
import { initialPanelState, reducePanelState, type PanelEvent, type RegistrationInfo } from "../panel/state"

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

describe("panel state", () => {
  test("shows no-directory when the host has no open project", () => {
    const state = reduceAll(initialPanelState(), { type: "directory-context", directory: null })
    expect(state).toEqual({ kind: "no-directory" })
  })

  test("shows unregistered when the open project has no first mate", () => {
    const state = reduceAll(
      initialPanelState(),
      { type: "directory-context", directory: "/repos/sunrise" },
      { type: "lookup-succeeded", registration: null },
    )
    expect(state).toEqual({ kind: "unregistered" })
  })

  test("shows registered when the open project already has a first mate", () => {
    const state = reduceAll(
      initialPanelState(),
      { type: "directory-context", directory: "/repos/sunrise" },
      { type: "lookup-succeeded", registration },
    )
    expect(state).toEqual({ kind: "registered", registration, board: { kind: "loading" } })
  })

  test("a failed lookup shows the service error", () => {
    const state = reduceAll(
      initialPanelState(),
      { type: "directory-context", directory: "/repos/sunrise" },
      { type: "lookup-failed", message: "FirstMate registry file /home/firstmate/registry.json is unreadable" },
    )
    expect(state).toEqual({
      kind: "service-error",
      message: "FirstMate registry file /home/firstmate/registry.json is unreadable",
    })
  })

  test("launching a project without a first mate ends registered", () => {
    const state = reduceAll(
      initialPanelState(),
      { type: "directory-context", directory: "/repos/sunrise" },
      { type: "lookup-succeeded", registration: null },
      { type: "launch-started" },
      { type: "launch-succeeded", registration },
    )
    expect(state).toEqual({ kind: "registered", registration, board: { kind: "loading" } })
  })

  test("a failed launch shows the CLI notice when the openchamber CLI is missing", () => {
    const state = reduceAll(
      initialPanelState(),
      { type: "directory-context", directory: "/repos/sunrise" },
      { type: "lookup-succeeded", registration: null },
      { type: "launch-started" },
      { type: "launch-failed", cliMissing: true, message: "the openchamber CLI is required" },
    )
    expect(state).toEqual({ kind: "cli-missing" })
  })

  test("a failed launch shows the error message for other failures", () => {
    const state = reduceAll(
      initialPanelState(),
      { type: "directory-context", directory: "/repos/sunrise" },
      { type: "lookup-succeeded", registration: null },
      { type: "launch-started" },
      { type: "launch-failed", cliMissing: false, message: "provisioning failed" },
    )
    expect(state).toEqual({ kind: "service-error", message: "provisioning failed" })
  })
})

describe("panel board state", () => {
  test("board data loaded while registered becomes grouped ready columns", () => {
    const state = reduceAll(
      registeredState(),
      { type: "board-loaded", workers: [{ title: "Ship login", state: "Working" }] },
    )
    expect(state).toEqual({
      kind: "registered",
      registration,
      board: {
        kind: "ready",
        columns: [{ id: "Working", cards: [{ title: "Ship login", state: "Working" }] }],
        refreshing: false,
      },
    })
  })

  test("a delivery error from the board payload surfaces as the board warning", () => {
    const state = reduceAll(
      registeredState(),
      { type: "board-loaded", workers: [], deliveryError: "openchamber exited with code 1" },
    )
    expect(state).toEqual({
      kind: "registered",
      registration,
      board: { kind: "ready", columns: [], warning: "openchamber exited with code 1", refreshing: false },
    })
  })

  test("a failed board fetch shows the board error while staying registered", () => {
    const state = reduceAll(registeredState(), { type: "board-failed", message: "the service is unreachable." })
    expect(state).toEqual({
      kind: "registered",
      registration,
      board: { kind: "error", message: "the service is unreachable." },
    })
  })

  test("skipped malformed worker entries surface as the board warning", () => {
    const state = reduceAll(
      registeredState(),
      { type: "board-loaded", workers: [{ title: "Ship login", state: "Working" }], malformedCount: 2 },
    )
    expect(state).toEqual({
      kind: "registered",
      registration,
      board: {
        kind: "ready",
        columns: [{ id: "Working", cards: [{ title: "Ship login", state: "Working" }] }],
        warning: "2 malformed entries skipped",
        refreshing: false,
      },
    })
  })

  test("a delivery error and skipped entries combine into one board warning", () => {
    const state = reduceAll(
      registeredState(),
      { type: "board-loaded", workers: [], malformedCount: 1, deliveryError: "openchamber exited with code 1" },
    )
    expect(state).toEqual({
      kind: "registered",
      registration,
      board: {
        kind: "ready",
        columns: [],
        warning: "openchamber exited with code 1 — 1 malformed entries skipped",
        refreshing: false,
      },
    })
  })

  test("a repeated lookup-succeeded while registered does not reset the board", () => {
    const state = reduceAll(
      registeredState(),
      { type: "board-loaded", workers: [{ title: "Ship login", state: "Working" }] },
      { type: "lookup-succeeded", registration },
    )
    expect(state).toEqual({
      kind: "registered",
      registration,
      board: {
        kind: "ready",
        columns: [{ id: "Working", cards: [{ title: "Ship login", state: "Working" }] }],
        refreshing: false,
      },
    })
  })

  test("a live session snapshot marks a ready board refreshing and keeps its columns", () => {
    const state = reduceAll(
      registeredState(),
      { type: "board-loaded", workers: [{ title: "Ship login", state: "Working" }] },
      { type: "sessions-changed" },
    )
    expect(state).toEqual({
      kind: "registered",
      registration,
      board: {
        kind: "ready",
        columns: [{ id: "Working", cards: [{ title: "Ship login", state: "Working" }] }],
        refreshing: true,
      },
    })
  })

  test("a live snapshot carrying the coordinator's session title records it", () => {
    const state = reduceAll(registeredState(), { type: "sessions-changed", coordinatorTitle: "FirstMate — sunrise" })
    expect(state).toEqual({
      kind: "registered",
      registration,
      coordinatorTitle: "FirstMate — sunrise",
      board: { kind: "loading" },
    })
  })

  test("board events are ignored while the project is not registered", () => {
    const state = reduceAll(
      initialPanelState(),
      { type: "directory-context", directory: "/repos/sunrise" },
      { type: "lookup-succeeded", registration: null },
      { type: "board-loaded", workers: [{ title: "Ship login", state: "Working" }] },
      { type: "board-failed", message: "nope" },
      { type: "sessions-changed", coordinatorTitle: "FirstMate — sunrise" },
    )
    expect(state).toEqual({ kind: "unregistered" })
  })
})

describe("suggestion action state", () => {
  const otherRegistration: RegistrationInfo = {
    slug: "drifter",
    projectDirectory: "/repos/drifter",
    homeDirectory: "/home/firstmate/projects/drifter",
    coordinatorSessionId: "ses_coord_2",
    createdAt: "2026-01-01T00:00:00.000Z",
  }

  test("a started action raises the pending flag the suggestion buttons disable on", () => {
    const state = reduceAll(registeredState(), { type: "suggestion-action-started" })
    expect(state).toMatchObject({ kind: "registered", suggestionActionPending: true })
  })

  test("a started action clears the previous action's feedback", () => {
    const state = reduceAll(
      registeredState(),
      { type: "suggestion-action-settled", feedback: "an earlier warning" },
      { type: "suggestion-action-started" },
    )
    expect(state).toMatchObject({
      kind: "registered",
      suggestionActionPending: true,
      suggestionActionFeedback: undefined,
    })
  })

  test("a settled action ends the pending state and stores nothing on a clean success", () => {
    const state = reduceAll(
      registeredState(),
      { type: "suggestion-action-started" },
      { type: "suggestion-action-settled" },
    )
    expect(state).toMatchObject({
      kind: "registered",
      suggestionActionPending: false,
      suggestionActionFeedback: undefined,
    })
  })

  test("a settled action ends the pending state and stores the cleanup warning", () => {
    const state = reduceAll(
      registeredState(),
      { type: "suggestion-action-started" },
      {
        type: "suggestion-action-settled",
        feedback: "the suggestion was sent to the coordinator, but its line could not be removed",
      },
    )
    expect(state).toMatchObject({
      kind: "registered",
      suggestionActionPending: false,
      suggestionActionFeedback: "the suggestion was sent to the coordinator, but its line could not be removed",
    })
  })

  test("the suggestions refetch after a settled action keeps the action feedback", () => {
    const state = reduceAll(
      registeredState(),
      { type: "suggestion-action-started" },
      { type: "suggestion-action-settled", feedback: "the line stayed on disk" },
      { type: "suggestions-loaded", suggestions: [{ label: "keep", text: "me" }] },
    )
    expect(state).toMatchObject({
      kind: "registered",
      suggestionActionPending: false,
      suggestionActionFeedback: "the line stayed on disk",
      suggestions: [{ label: "keep", text: "me" }],
    })
  })

  test("a fresh registration for a switched project starts with no pending action and no feedback", () => {
    const previous = reduceAll(
      registeredState(),
      { type: "suggestion-action-started" },
      { type: "suggestion-action-settled", feedback: "the old project's warning" },
    )
    expect(previous).toMatchObject({ suggestionActionPending: false, suggestionActionFeedback: "the old project's warning" })

    // A directory switch rebuilds from initialPanelState() (the panel's
    // resetTo), so the fresh registration must not inherit the previous
    // project's action state.
    const switched = reduceAll(
      initialPanelState(),
      { type: "directory-context", directory: "/repos/drifter" },
      { type: "lookup-succeeded", registration: otherRegistration },
    )
    expect(switched).toMatchObject({ kind: "registered", registration: otherRegistration })
    if (switched.kind !== "registered") throw new Error("expected the switched state to be registered")
    // The fresh state intentionally omits the optional action fields rather
    // than carrying them as explicit undefined values.
    expect(switched.suggestionActionPending).toBeUndefined()
    expect(switched.suggestionActionFeedback).toBeUndefined()
  })

  test("suggestion action events are ignored while the project is not registered", () => {
    const state = reduceAll(
      initialPanelState(),
      { type: "suggestion-action-started" },
      { type: "suggestion-action-settled", feedback: "orphan feedback" },
    )
    expect(state).toEqual({ kind: "loading" })
  })
})
