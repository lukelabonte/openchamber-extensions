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
    expect(state).toEqual({ kind: "registered", registration })
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
    expect(state).toEqual({ kind: "registered", registration })
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
