// Closing lines are worker testimony, not host state or completion evidence.
export const workerReportStates = ["working", "needs-decision", "blocked", "paused", "done", "failed", "resolved"] as const
export interface WorkerReport {
  state: typeof workerReportStates[number]
  text: string
}

export function parseWorkerReport(message: string | undefined): WorkerReport | undefined {
  if (message === undefined) return undefined
  const lines: string[] = []
  let fence: { marker: string; length: number } | undefined
  for (const rawLine of message.split(/\r\n?|\n/)) {
    const line = rawLine.trim()
    const delimiter = /^(`{3,}|~{3,})/.exec(line)
    if (fence !== undefined) {
      if (delimiter?.[1][0] === fence.marker && delimiter[1].length >= fence.length && line.slice(delimiter[1].length).trim() === "") fence = undefined
      continue
    }
    if (delimiter !== null) { fence = { marker: delimiter[1][0], length: delimiter[1].length }; continue }
    if (line !== "") lines.push(line)
  }
  for (let index = lines.length - 1; index >= Math.max(0, lines.length - 4); index -= 1) {
    let line = lines[index].replace(/^[-*]\s+/, "")
    for (const marker of ["**", "__"]) {
      if (line.startsWith(marker) && line.endsWith(marker) && !line.slice(2, -2).includes(marker)) line = line.slice(2, -2)
    }
    const match = /^(?:\*\*|__)?(?:status\s*[:=]\s*)?(working|needs[-_ ]decision|blocked|paused|done|failed|resolved)(?:\*\*|__)?\s*(?:\[[^\]]*\]\s*)?:\s*(?:\*\*|__)?(.*)$/i.exec(line)
    if (match === null) continue
    return { state: match[1].toLowerCase().replace(/[_ ]/g, "-") as WorkerReport["state"], text: match[2].trim() }
  }
  return undefined
}

export function reportPullRequestUrl(text: string): string | undefined {
  for (const match of text.matchAll(/https:\/\/[^\s<>()\[\]]+/gi)) {
    const candidate = match[0].replace(/[.,;!?*_"'`]+$/, "")
    try {
      const url = new URL(candidate)
      if (url.protocol === "https:" && url.hostname === "github.com" && url.port === "" && url.username === "" && url.password === "" && /^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/pull\/[1-9]\d*\/?$/.test(url.pathname)) return candidate
    } catch { /* Invalid links remain plain worker text. */ }
  }
  return undefined
}
