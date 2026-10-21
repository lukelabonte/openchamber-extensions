import { describe, expect, test } from "bun:test"
import { runPullRequestCleanup } from "../service/cleanup-pr-links"
import { InMemoryFileSystem } from "./helpers/in-memory-file-system"

function fixture() {
  const filesystem = new InMemoryFileSystem()
  const homeRoot = "/fm"
  const homeDirectory = "/fm/projects/app"
  const pull = { id: "owner/app#7", title: "Search", kind: "pull", url: "https://github.com/owner/app/pull/7" }
  filesystem.seedFile("/fm/registry.json", JSON.stringify({ app: { slug: "app", homeDirectory, projectDirectory: "/repos/app", coordinatorSessionId: "ses_mate", createdAt: "2026-10-21T00:00:00Z" } }))
  filesystem.seedFile(`${homeDirectory}/backlog.md`, `- Search\n  state: Done\n  id: search\n  session: ses_worker\n  pr: ${pull.url}\n`)
  filesystem.seedFile(`${homeDirectory}/reports/search.md`, `Checked ${pull.url}`)
  filesystem.seedFile(`${homeDirectory}/reports/archive.jsonl`, JSON.stringify({ sessionId: "ses_worker", title: "Search", archivedAt: "2026-10-21T00:00:00Z", hostArchived: true }))
  filesystem.seedFile("/settings.json", JSON.stringify({ desktopLocalPort: 12345, desktopLocalClientToken: "fixture" }))
  const requests: { url: string; method: string; body?: string }[] = []
  const ports = {
    filesystem: filesystem.port, homeRoot, settingsPath: "/settings.json", cwd: () => homeDirectory,
    exec: async () => JSON.stringify({ state: "MERGED", mergedAt: "2026-10-21T00:00:00Z", url: pull.url }),
    fetcher: async (url: string, init: { method: string; body?: string }) => {
      requests.push({ url, method: init.method, body: init.body })
      return { status: 200, text: async () => JSON.stringify({ metadata: { openchamber: { linked_issues: init.method === "POST" ? [] : [pull] } } }) }
    },
  }
  return { filesystem, ports, requests, pull }
}

describe("FirstMate callable PR cleanup", () => {
  test("allows the first mate to clean its own resolved merged links without waiting for its turn to become idle", async () => {
    const { ports, requests, pull } = fixture()
    expect(JSON.parse(await runPullRequestCleanup([], ports))).toMatchObject({ coordinatorSessionId: "ses_mate", unlinked: [pull.url] })
    expect(requests.at(-1).url).toBe("http://127.0.0.1:12345/api/openchamber/sessions/ses_mate/links")
    expect(JSON.parse(requests.at(-1).body)).toMatchObject({ directory: "/fm/projects/app", linked: false })
  })

  test("help performs no I/O and unsupported arguments cannot choose another session or URL", async () => {
    const { ports, requests } = fixture()
    const unavailable = async () => { throw new Error("unexpected I/O") }
    expect(await runPullRequestCleanup(["--help"], { ...ports, filesystem: { ...ports.filesystem, exists: unavailable } })).toContain("Usage:")
    await expect(runPullRequestCleanup(["--session", "ses_other"], ports)).rejects.toThrow("arguments")
    expect(requests).toHaveLength(0)
  })

  test("refuses a project checkout or unrelated directory instead of selecting the first registered project", async () => {
    const { ports, requests } = fixture()
    await expect(runPullRequestCleanup([], { ...ports, cwd: () => "/repos/app" })).rejects.toThrow("registered FirstMate home")
    expect(requests).toHaveLength(0)
  })

  test("refuses released or ambiguous coordinators", async () => {
    const { filesystem, ports, requests } = fixture()
    filesystem.seedFile("/fm/registry.json", "{}")
    await expect(runPullRequestCleanup([], ports)).rejects.toThrow("registered FirstMate home")
    expect(requests).toHaveLength(0)
  })
})
