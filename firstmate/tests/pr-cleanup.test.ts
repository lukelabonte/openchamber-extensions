import { describe, expect, test } from "bun:test"
import { archivePath } from "../service/archive"
import { formatBacklogEntry, type BacklogTask } from "../service/backlog"
import { cleanupCoordinatorPullRequests } from "../service/pr-cleanup"
import type { HttpFetcher } from "../service/interrupt"
import { InMemoryFileSystem } from "./helpers/in-memory-file-system"

const homeRoot = "/home/firstmate"
const registration = { slug: "app", projectDirectory: "/repos/app", homeDirectory: `${homeRoot}/projects/app`, coordinatorSessionId: "ses_coordinator", createdAt: "2026-10-01T08:00:00Z" }
const pull = { id: "owner/app#7", kind: "pull", title: "Ship search", url: "https://github.com/owner/app/pull/7", number: 7 }
const other = { id: "owner/app#8", kind: "issue", title: "Keep this issue", url: "https://github.com/owner/app/issues/8" }
const task: BacklogTask = { title: "Ship search", id: "search", kind: "ship", state: "Done", sessionId: "ses_worker", prUrl: pull.url }

function fixture(overrides: Partial<BacklogTask> = {}) {
  const filesystem = new InMemoryFileSystem()
  filesystem.seedFile(`${homeRoot}/registry.json`, JSON.stringify({ app: registration }))
  filesystem.seedFile(`${registration.homeDirectory}/backlog.md`, formatBacklogEntry({ ...task, ...overrides }))
  filesystem.seedFile(`${registration.homeDirectory}/reports/search.md`, `Checked result: ${pull.url}`)
  filesystem.seedFile(archivePath(homeRoot, "app"), JSON.stringify({ sessionId: "ses_worker", title: task.title, archivedAt: "2026-10-21T08:00:00Z", hostArchived: true }) + "\n")
  let links: unknown[] = [pull, other]
  let github: unknown = { state: "MERGED", mergedAt: "2026-10-21T08:00:00Z", url: pull.url }
  let postResponse: unknown
  let postStatus = 200
  let beforeGithub = () => {}
  const requests: { url: string; method: string; body?: string }[] = []
  const commands: { command: string; args: readonly string[] }[] = []
  const fetcher: HttpFetcher = async (url, init) => {
    requests.push({ url, method: init.method, body: init.body })
    if (init.method === "POST") {
      if (postStatus === 200 && postResponse === undefined) {
        const removed = JSON.parse(init.body!).entries.map((entry: { id: string }) => entry.id)
        links = links.filter((entry) => typeof entry !== "object" || entry === null || !("id" in entry) || !removed.includes(entry.id))
      }
      return { status: postStatus, text: async () => JSON.stringify(postResponse ?? { metadata: { openchamber: { linked_issues: links } } }) }
    }
    return { status: 200, text: async () => JSON.stringify({ metadata: { openchamber: { linked_issues: links } } }) }
  }
  const input = {
    filesystem: filesystem.port, homeRoot, registration, fetcher,
    support: { kind: "supported", port: 4096, token: "test-token" } as const,
    exec: async (command: string, args: readonly string[]) => { commands.push({ command, args }); beforeGithub(); return JSON.stringify(github) },
  }
  return { input, filesystem, requests, commands,
    links() { return links },
    setLinks(value: unknown[]) { links = value },
    setGithub(value: unknown) { github = value },
    setPostResponse(value: unknown, status = 200) { postResponse = value; postStatus = status },
    beforeGithub(callback: () => void) { beforeGithub = callback },
  }
}

describe("coordinator PR link cleanup", () => {
  test("unlinks only a merged PR with a saved report and retired worker, preserving history and sibling links", async () => {
    const { input, filesystem, requests, commands, links } = fixture()
    const before = filesystem.fileContents(`${registration.homeDirectory}/backlog.md`)
    expect(await cleanupCoordinatorPullRequests(input)).toEqual([pull.url])
    expect(commands).toEqual([{ command: "gh", args: ["pr", "view", pull.url, "--json", "state,mergedAt,url"] }])
    expect(requests.at(-1)).toEqual({ url: "http://127.0.0.1:4096/api/openchamber/sessions/ses_coordinator/links", method: "POST", body: JSON.stringify({ directory: registration.homeDirectory, entries: [pull], linked: false }) })
    expect(filesystem.fileContents(`${registration.homeDirectory}/backlog.md`)).toBe(before)
    expect(filesystem.fileContents(`${registration.homeDirectory}/reports/search.md`)).toContain(pull.url)
    expect(links()).toEqual([other])
    expect(await cleanupCoordinatorPullRequests(input)).toEqual([])
    expect(commands).toHaveLength(1)
  })

  test.each([
    { state: "Working" }, { state: "Failed" }, { hold: "Keep available" }, { blockedBy: "other" },
    { actions: [{ label: "Decide", text: "Wait" }] }, { id: undefined }, { sessionId: undefined }, { kind: "captain" },
  ] as Partial<BacklogTask>[]) ("keeps unresolved work: %j", async (overrides) => {
    const { input, requests, commands } = fixture(overrides)
    expect(await cleanupCoordinatorPullRequests(input)).toEqual([])
    expect(requests.some((request) => request.method === "POST")).toBe(false)
    expect(commands).toHaveLength(0)
  })

  test.each(["OPEN", "CLOSED"]) ("keeps a %s PR even for a Done task", async (state) => {
    const { input, requests, setGithub } = fixture()
    setGithub({ state, mergedAt: null, url: pull.url })
    expect(await cleanupCoordinatorPullRequests(input)).toEqual([])
    expect(requests.some((request) => request.method === "POST")).toBe(false)
  })

  test("keeps board-only End entries and missing reports", async () => {
    for (const missing of ["archive", "report"]) {
      const { input, filesystem, requests } = fixture()
      if (missing === "archive") filesystem.seedFile(archivePath(homeRoot, "app"), JSON.stringify({ sessionId: "ses_worker", title: task.title, archivedAt: "today" }) + "\n")
      else filesystem.seedFile(`${registration.homeDirectory}/reports/search.md`, "  ")
      expect(await cleanupCoordinatorPullRequests(input)).toEqual([])
      expect(requests.some((request) => request.method === "POST")).toBe(false)
    }
  })

  test.each([pull.url.toUpperCase() + "/", `${pull.url}?view=1#discussion`])("keeps untracked PRs and PRs shared with active work: %s", async (sharedUrl) => {
    const { input, filesystem, setLinks, requests } = fixture()
    setLinks([{ ...pull, url: "https://github.com/owner/app/pull/9", id: "owner/app#9" }])
    expect(await cleanupCoordinatorPullRequests(input)).toEqual([])
    setLinks([pull])
    filesystem.seedFile(`${registration.homeDirectory}/backlog.md`, `${formatBacklogEntry(task)}\n${formatBacklogEntry({ ...task, id: "followup", state: "Working", prUrl: sharedUrl })}`)
    expect(await cleanupCoordinatorPullRequests(input)).toEqual([])
    expect(requests.some((request) => request.method === "POST")).toBe(false)
  })

  test.each([{}, { state: "MERGED", mergedAt: "bad", url: pull.url }, { state: "MERGED", mergedAt: "2026-10-21", url: "https://github.com/other/app/pull/7" }])("refuses unverifiable GitHub evidence: %j", async (value) => {
    const { input, setGithub, requests } = fixture()
    setGithub(value)
    await expect(cleanupCoordinatorPullRequests(input)).rejects.toThrow()
    expect(requests.some((request) => request.method === "POST")).toBe(false)
  })

  test.each(["backlog", "registration"]) ("rechecks %s after the GitHub lookup", async (changed) => {
    const { input, filesystem, beforeGithub, requests } = fixture()
    beforeGithub(() => {
      if (changed === "backlog") filesystem.seedFile(`${registration.homeDirectory}/backlog.md`, formatBacklogEntry({ ...task, state: "Working" }))
      else filesystem.seedFile(`${homeRoot}/registry.json`, JSON.stringify({ app: { ...registration, coordinatorSessionId: "ses_replacement" } }))
    })
    await expect(cleanupCoordinatorPullRequests(input)).rejects.toThrow()
    expect(requests.some((request) => request.method === "POST")).toBe(false)
  })

  test.each([{}, { metadata: {} }, { metadata: { openchamber: { linked_issues: [pull, other] } } }])("requires the host to confirm removal: %j", async (body) => {
    const { input, setPostResponse } = fixture()
    setPostResponse(body)
    await expect(cleanupCoordinatorPullRequests(input)).rejects.toThrow()
  })

  test("fails closed on unsupported hosts and host errors", async () => {
    const { input, requests, setPostResponse } = fixture()
    await expect(cleanupCoordinatorPullRequests({ ...input, support: { kind: "unsupported", reason: "not available" } })).rejects.toThrow()
    expect(requests).toHaveLength(0)
    setPostResponse({}, 404)
    await expect(cleanupCoordinatorPullRequests(input)).rejects.toThrow()
  })

  test("keeps links when GitHub is unavailable or a report changes during verification", async () => {
    const { input, filesystem, beforeGithub, requests } = fixture()
    await expect(cleanupCoordinatorPullRequests({ ...input, exec: async () => { throw new Error("GitHub unavailable") } })).rejects.toThrow()
    beforeGithub(() => filesystem.seedFile(`${registration.homeDirectory}/reports/search.md`, ""))
    await expect(cleanupCoordinatorPullRequests(input)).rejects.toThrow()
    expect(requests.some((request) => request.method === "POST")).toBe(false)
  })

  test("keeps ambiguous link identities without removing a sibling issue", async () => {
    const { input, setLinks, requests, commands } = fixture()
    setLinks([pull, { ...other, id: pull.id }])
    expect(await cleanupCoordinatorPullRequests(input)).toEqual([])
    expect(commands).toHaveLength(0)
    expect(requests.some((request) => request.method === "POST")).toBe(false)
  })

  test("preserves a link added while merge verification is in flight", async () => {
    const { input, setLinks, links, beforeGithub } = fixture()
    const concurrent = { ...other, id: "owner/app#9", url: "https://github.com/owner/app/issues/9" }
    beforeGithub(() => setLinks([pull, other, concurrent]))
    expect(await cleanupCoordinatorPullRequests(input)).toEqual([pull.url])
    expect(links()).toEqual([other, concurrent])
  })

  test.each([{}, { metadata: { openchamber: { linked_issues: "bad" } } }])("rejects malformed metadata before unlinking: %j", async (body) => {
    const { input, commands } = fixture()
    const fetcher: HttpFetcher = async (_url, init) => {
      expect(init.method).toBe("GET")
      return { status: 200, text: async () => JSON.stringify(body) }
    }
    await expect(cleanupCoordinatorPullRequests({ ...input, fetcher })).rejects.toThrow()
    expect(commands).toHaveLength(0)
  })
})
