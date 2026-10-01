import { connectHost } from "@openchamber/sdk"
import { applyHostReady } from "@openchamber/sdk/ui"
import { initialPanelState, reducePanelState, type PanelEvent, type PanelState, type RegistrationInfo } from "./state"

const host = connectHost()

let state: PanelState = initialPanelState()
let currentDirectory: string | null = null

host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement)
  currentDirectory = ctx.directory
  dispatch({ type: "directory-context", directory: ctx.directory })
  if (ctx.directory !== null) {
    void lookup(ctx.directory)
  }
})

async function lookup(directory: string): Promise<void> {
  try {
    const result = await host.serviceRequest({ method: "GET", path: "/lookup", query: { directory } })
    if (result.status !== 200) {
      dispatch({ type: "lookup-failed", message: `Looking up the first mate failed (status ${result.status}).` })
      return
    }
    let body: { registration: RegistrationInfo | null }
    try {
      body = JSON.parse(result.body) as { registration: RegistrationInfo | null }
    } catch {
      dispatch({ type: "lookup-failed", message: "Looking up the first mate failed: the service sent a malformed answer." })
      return
    }
    dispatch({ type: "lookup-succeeded", registration: body.registration ?? null })
  } catch {
    dispatch({ type: "lookup-failed", message: "Looking up the first mate failed: the service is unreachable." })
  }
}

async function launch(projectDirectory: string): Promise<void> {
  dispatch({ type: "launch-started" })
  try {
    const result = await host.serviceRequest({
      method: "POST",
      path: "/launch",
      body: JSON.stringify({ projectDirectory }),
    })
    let body: { error?: string; code?: string } = {}
    try {
      body = JSON.parse(result.body) as { error?: string; code?: string }
    } catch {
      // A non-JSON body only matters for the error paths handled below.
    }
    if (body.code === "cli-missing") {
      dispatch({ type: "launch-failed", cliMissing: true, message: body.error ?? "the openchamber CLI is required" })
      return
    }
    if (result.status !== 200) {
      dispatch({ type: "launch-failed", cliMissing: false, message: body.error ?? "Launching the first mate failed." })
      return
    }
    dispatch({ type: "launch-succeeded", registration: JSON.parse(result.body) as RegistrationInfo })
  } catch {
    dispatch({ type: "launch-failed", cliMissing: false, message: "Launching the first mate failed." })
  }
}

function dispatch(event: PanelEvent): void {
  state = reducePanelState(state, event)
  render(state)
}

function render(state: PanelState): void {
  const root = document.getElementById("firstmate-root")
  if (!root) return
  root.replaceChildren()
  root.append(heading())

  switch (state.kind) {
    case "loading":
      root.append(text("Reading the project…"))
      break
    case "no-directory":
      root.append(text("Open a project to launch its first mate."))
      break
    case "unregistered":
      root.append(text("This project has no first mate yet."), launchButton())
      break
    case "launching":
      root.append(text("Launching the first mate…"))
      break
    case "registered":
      root.append(text("A first mate is on watch for this project."))
      root.append(registrationDetails(state.registration))
      root.append(text("The board is empty."))
      break
    case "cli-missing":
      root.append(text("The openchamber CLI is required. Install it with: npm i -g @openchamber/web"))
      break
    case "service-error":
      root.append(text(state.message))
      break
  }
}

function heading(): HTMLElement {
  const heading = document.createElement("h1")
  heading.textContent = "FirstMate"
  return heading
}

function text(contents: string): HTMLElement {
  const paragraph = document.createElement("p")
  paragraph.textContent = contents
  return paragraph
}

function launchButton(): HTMLElement {
  const button = document.createElement("button")
  button.textContent = "Launch first mate"
  button.addEventListener("click", () => {
    if (currentDirectory !== null) {
      void launch(currentDirectory)
    }
  })
  return button
}

function registrationDetails(registration: RegistrationInfo): HTMLElement {
  const details = document.createElement("p")
  details.textContent = `Coordinator session ${registration.coordinatorSessionId}, home ${registration.homeDirectory}`
  return details
}
