import { groupBoardColumns, type BoardColumn, type BoardWorker } from "./board"
import type { ShippingInfo } from "./shipping"
import type { WatchRow } from "./watches"

export interface RegistrationInfo {
  slug: string
  projectDirectory: string
  homeDirectory: string
  coordinatorSessionId: string
  createdAt: string
}

// The board half of a registered panel. The service's poller is the authority
// on worker state; the panel fetches GET /board and marks itself refreshing
// when the live onSessions subscription fires.
export type Board =
  | { kind: "loading" }
  | { kind: "ready"; columns: BoardColumn[]; warning?: string; refreshing: boolean }
  | { kind: "error"; message: string }

export type PanelState =
  | { kind: "loading" }
  | { kind: "no-directory" }
  | { kind: "unregistered" }
  | { kind: "launching" }
  | {
      kind: "registered"
      registration: RegistrationInfo
      coordinatorTitle?: string
      board: Board
      /** The service's watch list for this project, once fetched. */
      watches?: WatchRow[]
      watchesError?: string
      /** The project's shipping mode, once fetched from GET /shipping. */
      shipping?: ShippingInfo
    }
  | { kind: "cli-missing" }
  | { kind: "service-error"; message: string }

export type PanelEvent =
  | { type: "directory-context"; directory: string | null }
  | { type: "lookup-succeeded"; registration: RegistrationInfo | null }
  | { type: "lookup-failed"; message: string }
  | { type: "launch-started" }
  | { type: "launch-succeeded"; registration: RegistrationInfo }
  | { type: "launch-failed"; cliMissing: boolean; message: string }
  | { type: "board-loaded"; workers: BoardWorker[]; malformedCount?: number; deliveryError?: string }
  | { type: "board-failed"; message: string }
  | { type: "watches-loaded"; watches: WatchRow[] }
  | { type: "watches-failed"; message: string }
  | { type: "shipping-loaded"; shipping: ShippingInfo }
  | { type: "sessions-changed"; coordinatorTitle?: string }

export function initialPanelState(): PanelState {
  return { kind: "loading" }
}

function registered(registration: RegistrationInfo): PanelState {
  return { kind: "registered", registration, board: { kind: "loading" } }
}

// The board's single warning slot: a service delivery error and skipped
// malformed payload entries, joined when both are present.
function boardWarning(deliveryError: string | undefined, malformedCount: number | undefined): string | undefined {
  const parts: string[] = []
  const delivery = deliveryError?.trim()
  if (delivery !== undefined && delivery !== "") parts.push(delivery)
  if (malformedCount !== undefined && malformedCount > 0) parts.push(`${malformedCount} malformed entries skipped`)
  return parts.length === 0 ? undefined : parts.join(" — ")
}

export function reducePanelState(state: PanelState, event: PanelEvent): PanelState {
  switch (event.type) {
    case "directory-context":
      if (state.kind !== "loading") return state
      return event.directory === null ? { kind: "no-directory" } : state
    case "lookup-succeeded":
      if (state.kind !== "loading") return state
      return event.registration === null ? { kind: "unregistered" } : registered(event.registration)
    case "lookup-failed":
      if (state.kind !== "loading") return state
      return { kind: "service-error", message: event.message }
    case "launch-started":
      if (state.kind !== "unregistered") return state
      return { kind: "launching" }
    case "launch-succeeded":
      if (state.kind !== "launching") return state
      return registered(event.registration)
    case "launch-failed":
      if (state.kind !== "launching") return state
      return event.cliMissing ? { kind: "cli-missing" } : { kind: "service-error", message: event.message }
    case "board-loaded": {
      if (state.kind !== "registered") return state
      const warning = boardWarning(event.deliveryError, event.malformedCount)
      return {
        ...state,
        board: {
          kind: "ready",
          columns: groupBoardColumns(event.workers),
          ...(warning !== undefined ? { warning } : {}),
          refreshing: false,
        },
      }
    }
    case "board-failed":
      if (state.kind !== "registered") return state
      return { ...state, board: { kind: "error", message: event.message } }
    case "watches-loaded":
      if (state.kind !== "registered") return state
      return { ...state, watches: event.watches, watchesError: undefined }
    case "watches-failed":
      if (state.kind !== "registered") return state
      return { ...state, watchesError: event.message }
    case "shipping-loaded":
      if (state.kind !== "registered") return state
      return { ...state, shipping: event.shipping }
    case "sessions-changed":
      if (state.kind !== "registered") return state
      return {
        ...state,
        coordinatorTitle: event.coordinatorTitle ?? state.coordinatorTitle,
        board: state.board.kind === "ready" ? { ...state.board, refreshing: true } : state.board,
      }
  }
}
