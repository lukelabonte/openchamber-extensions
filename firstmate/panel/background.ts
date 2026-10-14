import { connectHost, type HostClient } from "@openchamber/sdk"
import { runFirstmateCommand, type FirstmateCommandContext, type FirstmateCommandHost } from "./commands"

type BackgroundHost = FirstmateCommandHost & Pick<HostClient, "onReady" | "onResolve" | "onAction">

export function registerFirstmateBackground(host: BackgroundHost): void {
  let captureReady: (context: FirstmateCommandContext) => void
  const ready = new Promise<FirstmateCommandContext>((resolve) => { captureReady = resolve })
  host.onReady((context) => {
    // A temporary command frame belongs to one invocation. Later ready pushes
    // must not retarget it to a different thread while its work is in flight.
    captureReady({ directory: context.directory, sessionId: context.session?.id ?? null })
  })
  host.onResolve(async (request) => {
    const { command, args } = request
    const context = await ready
    return runFirstmateCommand({ command, args, context, host })
  })
  host.onAction(async (item) => {
    // Action targets are authoritative, including a null directory. Never use
    // the currently selected session or ready context as a fallback.
    const context = { directory: item.directory, sessionId: item.sessionId }
    if (typeof context.sessionId !== "string" || context.sessionId.trim() === "") throw new Error("The clicked action has no originating session.")
    if (item.action === "firstmate-handoff") {
      if (item.kind !== "message" || item.role !== "user") throw new Error("FirstMate handoffs are available only on user messages.")
      const args = item.text
      await runFirstmateCommand({ command: "fm", args, context, host })
    } else if (item.action === "firstmate-open" || item.action === "firstmate-bearings") {
      if (item.kind !== "session") throw new Error("This FirstMate shortcut needs a session target.")
      const command = item.action === "firstmate-open" ? "fm-open" : "fm-bearings"
      await runFirstmateCommand({ command, args: "", context, host })
    } else {
      throw new Error(`Unknown FirstMate action: ${item.action}.`)
    }
  })
}

if (typeof window !== "undefined") registerFirstmateBackground(connectHost())
