// OpenChamber chat resolves these native links on the current instance. Keep
// its plain-ID constraint: message targets also enter DOM selectors there.
export function isMessageLinkIdentifier(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value)
}

export function workerMessageLink(sessionId: string | undefined, messageId: string | undefined): string | undefined {
  if (!isMessageLinkIdentifier(sessionId) || !isMessageLinkIdentifier(messageId)) return undefined
  return `openchamber://session/${sessionId}?message=${messageId}`
}
