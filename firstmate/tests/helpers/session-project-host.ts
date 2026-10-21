import { readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { runInNewContext } from "node:vm"
import type { HttpFetcher } from "../../service/interrupt"

// Reuse the SDK's schema dependency; no live application imports or new dependency.
const require = createRequire(import.meta.url)
const { z } = createRequire(require.resolve("@openchamber/sdk"))("zod")
export const servedOwnership = runInNewContext(readFileSync(new URL("../fixtures/served-sidebar-ownership.txt", import.meta.url), "utf8"), { X: z.object, V: z.string })

// Verbatim pure merge from the actually running desktop's packaged
// openchamber-sessions/session-metadata-store.js:32-49 (same MIT notice as fixture).
const isPlainObject = (value) => value !== null && typeof value === "object" && !Array.isArray(value)
const mergeMetadataPatch = (current, patch) => {
  const base = isPlainObject(current) ? { ...current } : {}
  if (!isPlainObject(patch)) return base
  for (const [key, value] of Object.entries(patch)) {
    if (value === null) {
      delete base[key]
      continue
    }
    base[key] = isPlainObject(value) ? mergeMetadataPatch(base[key], value) : value
  }
  return base
}

export function sessionProjectHost() {
  const sessions = new Map<string, { id: string; directory: string; metadata: any; title: string; messages: string[] }>()
  const requests: { url: string; method: string; body?: string }[] = []
  const fetcher: HttpFetcher = async (url, init) => {
    requests.push({ url, method: init.method, ...(init.body === undefined ? {} : { body: init.body }) })
    const pathname = new URL(url).pathname
    if (pathname.startsWith("/api/permission-auto-accept/")) return { status: 200 }
    const sessionId = decodeURIComponent(pathname.split("/").at(pathname.endsWith("/metadata") ? -2 : -1)!)
    const session = sessions.get(sessionId)
    if (!session) return { status: 500, text: async () => '{"error":"session was not found"}' }
    if (!pathname.endsWith("/metadata")) return { status: 200, text: async () => JSON.stringify({ id: session.id, location: { directory: session.directory } }) }
    if (init.method === "POST") {
      const body = JSON.parse(init.body!)
      if (body.directory !== session.directory || !isPlainObject(body.patch)) throw new Error("incorrect metadata write contract")
      session.metadata = mergeMetadataPatch(session.metadata, body.patch)
    } else if (new URL(url).searchParams.get("directory") !== session.directory) throw new Error("incorrect metadata read scope")
    return { status: 200, text: async () => JSON.stringify({ metadata: session.metadata }) }
  }
  return { sessions, requests, fetcher, support: { kind: "supported", port: 4096 } as const }
}
