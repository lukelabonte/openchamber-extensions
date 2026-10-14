import type { GuestRequest, HostClient } from "@openchamber/sdk"

export type FirstmateCommandHost = Pick<HostClient, "serviceRequest" | "openSession" | "toast">

export interface FirstmateCommandContext {
  directory: string | null
  sessionId?: string | null
}

export async function runFirstmateCommand(input: {
  command: string
  args: string
  context: FirstmateCommandContext
  host: FirstmateCommandHost
}): Promise<null> {
  const { command, args, host } = input
  const { directory, sessionId } = input.context
  if (typeof args !== "string") throw new Error("The FirstMate command has malformed arguments.")
  if (command === "fm") {
    if (args.trim() === "") throw new Error("A handoff needs text after /fm")
    if (new TextEncoder().encode(args).byteLength > 12_000) throw new Error("A FirstMate handoff can contain at most 12,000 UTF-8 bytes.")
  } else if (command === "fm-bearings") {
    if (args.trim() !== "" && args.trim() !== "file") throw new Error("Use /fm-bearings or /fm-bearings file.")
  } else if (command === "fm-open") {
    if (args.trim() !== "") throw new Error("/fm-open takes no arguments; it opens this directory's first mate.")
  } else {
    throw new Error(`Unknown FirstMate command: ${command}.`)
  }
  if (typeof directory !== "string" || directory.trim() === "") throw new Error("This command needs the originating session's project directory; no other directory will be used.")

  if (command === "fm") {
    await send(host, "/handoff", { directory, ...(sessionId == null ? {} : { sessionId }), text: args }, "Sending the handoff")
    await host.toast({ kind: "success", message: "Request relayed to FirstMate; merge approval is still required." })
    return null
  }

  const body = await requestBody(host, { method: "GET", path: "/lookup", query: { directory } }, "Looking up FirstMate")
  if (body.registration === null) throw new Error("No first mate is registered for this directory. Launch one from the project's FirstMate panel.")
  const registration = body.registration
  if (!isRecord(registration) || !nonEmptyString(registration.slug) || !nonEmptyString(registration.coordinatorSessionId) || !nonEmptyString(registration.homeDirectory)) {
    throw new Error("Looking up FirstMate failed: the service sent a malformed registration.")
  }
  if (command === "fm-open") {
    await host.openSession(registration.coordinatorSessionId)
    await host.toast({ kind: "success", message: "Opened FirstMate." })
  } else {
    await send(host, "/command", { slug: registration.slug, command: args.trim() === "file" ? "bearings-file" : "bearings" }, "Requesting bearings")
    await host.toast({ kind: "success", message: args.trim() === "file" ? "Requested FirstMate bearings with a report file." : "Requested FirstMate bearings." })
  }
  return null
}

async function send(host: FirstmateCommandHost, path: string, payload: Record<string, string>, operation: string): Promise<void> {
  const body = await requestBody(host, { method: "POST", path, body: JSON.stringify(payload) }, operation)
  if (body.sent !== true) throw new Error(`${operation} failed: the service sent a malformed delivery answer.`)
}

async function requestBody(host: FirstmateCommandHost, request: GuestRequest, operation: string): Promise<Record<string, unknown>> {
  const response = await host.serviceRequest(request)
  let body: unknown
  try {
    body = JSON.parse(response.body)
  } catch {
    if (response.status === 200) throw new Error(`${operation} failed: the service sent a malformed answer.`)
  }
  if (response.status !== 200) {
    const detail = isRecord(body) && nonEmptyString(body.error) ? `: ${body.error}` : "."
    throw new Error(`${operation} failed (status ${response.status})${detail}`)
  }
  if (!isRecord(body)) throw new Error(`${operation} failed: the service sent a malformed answer.`)
  return body
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim() !== ""
}
