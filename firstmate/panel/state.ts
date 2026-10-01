export interface RegistrationInfo {
  slug: string
  projectDirectory: string
  homeDirectory: string
  coordinatorSessionId: string
  createdAt: string
}

export type PanelState =
  | { kind: "loading" }
  | { kind: "no-directory" }
  | { kind: "unregistered" }
  | { kind: "launching" }
  | { kind: "registered"; registration: RegistrationInfo }
  | { kind: "cli-missing" }
  | { kind: "service-error"; message: string }

export type PanelEvent =
  | { type: "directory-context"; directory: string | null }
  | { type: "lookup-succeeded"; registration: RegistrationInfo | null }
  | { type: "lookup-failed"; message: string }
  | { type: "launch-started" }
  | { type: "launch-succeeded"; registration: RegistrationInfo }
  | { type: "launch-failed"; cliMissing: boolean; message: string }

export function initialPanelState(): PanelState {
  return { kind: "loading" }
}

export function reducePanelState(state: PanelState, event: PanelEvent): PanelState {
  switch (event.type) {
    case "directory-context":
      if (state.kind !== "loading") return state
      return event.directory === null ? { kind: "no-directory" } : state
    case "lookup-succeeded":
      if (state.kind !== "loading") return state
      return event.registration === null ? { kind: "unregistered" } : { kind: "registered", registration: event.registration }
    case "lookup-failed":
      if (state.kind !== "loading") return state
      return { kind: "service-error", message: event.message }
    case "launch-started":
      if (state.kind !== "unregistered") return state
      return { kind: "launching" }
    case "launch-succeeded":
      if (state.kind !== "launching") return state
      return { kind: "registered", registration: event.registration }
    case "launch-failed":
      if (state.kind !== "launching") return state
      return event.cliMissing ? { kind: "cli-missing" } : { kind: "service-error", message: event.message }
  }
}
