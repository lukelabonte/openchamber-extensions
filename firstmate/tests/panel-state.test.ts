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
