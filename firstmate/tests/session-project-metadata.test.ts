import { describe, expect, test } from "bun:test"
import { associateFirstMateSession, restoreSessionProjects } from "../service/session-projects"
import { InMemoryFileSystem } from "./helpers/in-memory-file-system"
import { servedOwnership, sessionProjectHost } from "./helpers/session-project-host"
import { launchFirstMate } from "../service/launch"
import { adoptFirstMate, restartFirstMate, releaseFirstMate } from "../service/lifecycle"
import { MissingCliError } from "../service/control-client"

const homeRoot = "/home/firstmate"
const registration = { slug: "sunrise", projectDirectory: "/repos/sunrise", homeDirectory: `${homeRoot}/projects/sunrise`, coordinatorSessionId: "ses_current", createdAt: "2026-10-21T00:00:00Z" }
const unsupportedCli = async () => { throw new Error("openchamber exited with code 1: Unknown option: --display-project-dir") }

function fixture() {
  const host = sessionProjectHost()
  host.sessions.set("ses_current", { id: "ses_current", directory: registration.homeDirectory, title: "Captain's first mate", messages: ["Conversation stays"], metadata: { custom: { retained: true }, openchamber: { work: { state: "open" }, linked_issues: [{ id: "keep-link" }] } } })
  host.sessions.set("ses_previous", { ...structuredClone(host.sessions.get("ses_current")!), id: "ses_previous" })
  host.sessions.set("ses_other", { ...structuredClone(host.sessions.get("ses_current")!), id: "ses_other", directory: `${homeRoot}/projects/moonrise`, metadata: { openchamber: { projectDirectory: "/repos/moonrise" } } })
  const projects = [{ id: "sunrise", normalizedPath: registration.projectDirectory }, { id: "moonrise", normalizedPath: "/repos/moonrise" }]
  const projectedIds = (projectId = "sunrise") => {
    const sessions = [...host.sessions.values()].map((session) => ({ ...session, projectID: `home-${session.directory}` }))
    const canonical = sessions.map((session) => ({ id: session.projectID, worktree: session.directory }))
    return Array.from(servedOwnership(sessions, projects, new Map(), false, [], canonical).sessionsByProject.get(projectId) ?? [], (session: any) => session.id)
  }
  return { ...host, projectedIds }
}

describe("FirstMate project metadata fallback", () => {
  test("restores the missing current first mate in the actually served sidebar projection", async () => {
    const host = fixture()
    const filesystem = new InMemoryFileSystem()
    const contents = JSON.stringify({ sunrise: registration })
    filesystem.seedFile(`${homeRoot}/registry.json`, contents)
    const current = structuredClone(host.sessions.get("ses_current")!)
    const previous = structuredClone(host.sessions.get("ses_previous"))
    const other = structuredClone(host.sessions.get("ses_other"))
    expect(host.projectedIds()).toEqual([])
    expect(host.projectedIds("moonrise")).toEqual(["ses_other"])

    const failures = await restoreSessionProjects({ filesystem: filesystem.port, homeRoot, exec: unsupportedCli, ...host })

    expect(failures).toEqual([])
    expect(host.projectedIds()).toEqual(["ses_current"])
    expect(host.sessions.get("ses_current")).toEqual({ ...current, metadata: { ...current.metadata, openchamber: { ...current.metadata.openchamber, projectDirectory: registration.projectDirectory } } })
    expect(host.sessions.get("ses_previous")).toEqual(previous)
    expect(host.sessions.get("ses_other")).toEqual(other)
    expect(filesystem.fileContents(`${homeRoot}/registry.json`)).toBe(contents)
  })

  test("sends only the association leaf and preserves metadata added after the read", async () => {
    const host = fixture()
    const fetcher: typeof host.fetcher = async (url, init) => {
      if (init.method === "POST") host.sessions.get("ses_current")!.metadata.openchamber.linked_issues.push({ id: "concurrent-link" })
      return host.fetcher(url, init)
    }
    await associateFirstMateSession(unsupportedCli, registration, { ...host, fetcher })
    expect(host.requests.filter((request) => request.method === "POST")).toEqual([{
      url: "http://127.0.0.1:4096/api/openchamber/sessions/ses_current/metadata", method: "POST",
      body: JSON.stringify({ directory: registration.homeDirectory, patch: { openchamber: { projectDirectory: registration.projectDirectory } } }),
    }])
    expect(host.sessions.get("ses_current")!.metadata.openchamber.linked_issues).toEqual([{ id: "keep-link" }, { id: "concurrent-link" }])
    expect(host.sessions.get("ses_current")!.metadata.openchamber.work).toEqual({ state: "open" })
    await associateFirstMateSession(unsupportedCli, registration, host)
    expect(host.requests.filter((request) => request.method === "POST")).toHaveLength(1)
    expect(host.projectedIds()).toEqual(["ses_current"])
  })

  test.each(["create", "reopen-after-failure"])("associates the %s launch path without creating duplicate chats", async (mode) => {
    const host = fixture()
    const filesystem = new InMemoryFileSystem()
    let creations = 0
    let writeFails = mode === "reopen-after-failure"
    const input = { ...host, filesystem: filesystem.port, homeRoot, projectDirectory: registration.projectDirectory, templateReader: async (name: string) => name === "settings.json" ? "{}" : "",
      exec: async (_command: string, args: readonly string[]) => {
        if (args[1] !== "create") return unsupportedCli()
        creations += 1
        host.sessions.set("ses_created", { ...structuredClone(host.sessions.get("ses_current")!), id: "ses_created" })
        return '{"sessionId":"ses_created"}'
      },
      fetcher: async (url, init) => init.method === "POST" && writeFails ? { status: 500 } : host.fetcher(url, init),
    }
    if (writeFails) {
      await expect(launchFirstMate(input)).rejects.toThrow("ses_created is saved")
      expect(JSON.parse(filesystem.fileContents(`${homeRoot}/registry.json`)).sunrise.coordinatorSessionId).toBe("ses_created")
      writeFails = false
    }
    const result = await launchFirstMate(input)
    expect(result.registration.coordinatorSessionId).toBe("ses_created")
    await launchFirstMate(input)
    expect(creations).toBe(1)
    expect(host.projectedIds()).toEqual(["ses_created"])
    expect(host.requests.filter((request) => request.method === "POST")).toHaveLength(1)
    expect(host.sessions.get("ses_previous")!.messages).toEqual(["Conversation stays"])
  })

  test.each(["adopt", "restart"])("associates only the selected %s coordinator and preserves the predecessor on release", async (operation) => {
    const host = fixture()
    const filesystem = new InMemoryFileSystem()
    filesystem.seedDirectory(registration.homeDirectory)
    filesystem.seedFile(`${homeRoot}/registry.json`, JSON.stringify({ sunrise: registration }))
    filesystem.seedFile(`${registration.homeDirectory}/settings.json`, JSON.stringify({ projectDirectory: registration.projectDirectory, coordinatorSessionId: "ses_current" }))
    await associateFirstMateSession(unsupportedCli, registration, host)
    const before = structuredClone(host.sessions.get("ses_current"))
    const input = { ...host, filesystem: filesystem.port, homeRoot, slug: registration.slug,
      exec: async (_command: string, args: readonly string[]) => {
        if (args[1] === "status") return '{"type":"idle"}'
        if (args[1] === "list") return JSON.stringify({ sessions: [{ id: "ses_previous", directory: registration.homeDirectory, type: "idle" }] })
        if (args[1] === "create") {
          host.sessions.set("ses_fresh", { ...structuredClone(host.sessions.get("ses_previous")!), id: "ses_fresh" })
          return '{"sessionId":"ses_fresh"}'
        }
        return unsupportedCli()
      },
    }
    const result = operation === "adopt" ? await adoptFirstMate({ ...input, sessionId: "ses_previous" }) : await restartFirstMate(input)
    const expected = operation === "adopt" ? "ses_previous" : "ses_fresh"
    expect(result.registration.coordinatorSessionId).toBe(expected)
    expect(host.projectedIds()).toEqual(["ses_current", expected])
    expect(host.sessions.get("ses_current")).toEqual(before)
    const allSessions = structuredClone([...host.sessions])
    await releaseFirstMate(input)
    expect([...host.sessions]).toEqual(allSessions)
  })

  test("startup continues after a native failure without crossing project boundaries", async () => {
    const host = fixture()
    const filesystem = new InMemoryFileSystem()
    const other = { ...registration, slug: "moonrise", projectDirectory: "/repos/moonrise", homeDirectory: `${homeRoot}/projects/moonrise`, coordinatorSessionId: "ses_other" }
    host.sessions.get("ses_other")!.metadata = {}
    filesystem.seedFile(`${homeRoot}/registry.json`, JSON.stringify({ sunrise: registration, moonrise: other }))
    const failures = await restoreSessionProjects({ ...host, filesystem: filesystem.port, homeRoot, exec: unsupportedCli,
      fetcher: async (url, init) => url.includes("ses_current") ? { status: 500 } : host.fetcher(url, init),
    })
    expect(failures).toHaveLength(1)
    expect(failures[0]).toContain("ses_current is saved")
    expect(host.projectedIds()).toEqual([])
    expect(host.projectedIds("moonrise")).toEqual(["ses_other"])
    expect(host.requests.filter((request) => request.method === "POST").map((request) => request.url)).toEqual(["http://127.0.0.1:4096/api/openchamber/sessions/ses_other/metadata"])
  })

  test.each([404, 405, 401, 403])("older/unavailable hosts stay usable without writes: GET %s", async (status) => {
    const host = fixture()
    const calls: string[] = []
    await associateFirstMateSession(unsupportedCli, registration, { ...host, fetcher: async (_url, init) => { calls.push(init.method); return { status } } })
    expect(calls).toEqual(["GET"])
    expect(host.projectedIds()).toEqual([])
  })

  test("absent desktop discovery and a supported CLI never invoke the fallback", async () => {
    const host = fixture()
    await associateFirstMateSession(unsupportedCli, registration, { ...host, support: { kind: "unsupported", reason: "no desktop" } })
    await associateFirstMateSession(async () => '{"sessionId":"ses_current"}', registration, host)
    expect(host.requests).toHaveLength(0)
  })

  test.each(["host unavailable", "session not found", "Unknown option: --session"])("real CLI errors aren't hidden by native fallback: %s", async (message) => {
    const host = fixture()
    await expect(associateFirstMateSession(async () => { throw new Error(message) }, registration, host)).rejects.toThrow(message)
    expect(host.requests).toHaveLength(0)
  })

  test("a missing CLI retains its existing error classification", async () => {
    const host = fixture()
    await expect(associateFirstMateSession(async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }) }, registration, host)).rejects.toBeInstanceOf(MissingCliError)
    expect(host.requests).toHaveLength(0)
  })

  test.each([{}, { metadata: [] }, { metadata: { openchamber: null } }, { metadata: { openchamber: { projectDirectory: "relative" } } }, { metadata: { openchamber: { projectDirectory: "/repos/unrelated" } } }])("refuses malformed or conflicting metadata without writing: %j", async (body) => {
    const host = fixture()
    await expect(associateFirstMateSession(unsupportedCli, registration, { ...host, fetcher: async () => ({ status: 200, text: async () => JSON.stringify(body) }) })).rejects.toThrow("sidebar")
    expect(host.requests).toHaveLength(0)
  })

  test.each(["not JSON", "<html>older host fallback</html>"])("doesn't mistake an unreadable metadata response for empty metadata: %s", async (text) => {
    const host = fixture()
    const methods: string[] = []
    await expect(associateFirstMateSession(unsupportedCli, registration, { ...host, fetcher: async (_url, init) => { methods.push(init.method); return { status: 200, text: async () => text } } })).rejects.toThrow("is saved")
    expect(methods).toEqual(["GET"])
  })

  test.each([{}, { id: "ses_wrong", location: { directory: registration.homeDirectory } }, { data: { id: "ses_current", location: { directory: "/other/home" } } }, { id: "ses_current", directory: "/other/home", location: { directory: registration.homeDirectory } }])("requires the real session's identity and home before mutation: %j", async (body) => {
    const host = fixture()
    const fetcher: typeof host.fetcher = async (url, init) => url.includes("/api/session/") ? { status: 200, text: async () => JSON.stringify(body) } : host.fetcher(url, init)
    await expect(associateFirstMateSession(unsupportedCli, registration, { ...host, fetcher })).rejects.toThrow("is saved")
    expect(host.requests.some((request) => request.method === "POST")).toBe(false)
  })

  test.each(["bare-directory", "wrapped-location"])("accepts verified session ownership in the %s response", async (shape) => {
    const host = fixture()
    const body = shape === "bare-directory" ? { id: "ses_current", directory: registration.homeDirectory } : { data: { id: "ses_current", location: { directory: registration.homeDirectory } } }
    const fetcher: typeof host.fetcher = async (url, init) => url.includes("/api/session/") ? { status: 200, text: async () => JSON.stringify(body) } : host.fetcher(url, init)
    await associateFirstMateSession(unsupportedCli, registration, { ...host, fetcher })
    expect(host.projectedIds()).toEqual(["ses_current"])
  })

  test.each([400, 404, 405, 500])("reports native write failures rather than claiming association: POST %s", async (status) => {
    const host = fixture()
    const fetcher: typeof host.fetcher = async (url, init) => init.method === "POST" ? { status } : host.fetcher(url, init)
    await expect(associateFirstMateSession(unsupportedCli, registration, { ...host, fetcher })).rejects.toThrow(`status ${status}`)
    expect(host.projectedIds()).toEqual([])
  })

  test.each([{}, { metadata: {} }, { metadata: { openchamber: { projectDirectory: "/repos/wrong" } } }])("requires confirmation of the exact project after writing: %j", async (body) => {
    const host = fixture()
    const fetcher: typeof host.fetcher = async (url, init) => init.method === "POST" ? { status: 200, text: async () => JSON.stringify(body) } : host.fetcher(url, init)
    await expect(associateFirstMateSession(unsupportedCli, registration, { ...host, fetcher })).rejects.toThrow("is saved")
  })

  test.each(["transport", "server", "unreadable"])("reports metadata %s failures without writing", async (failure) => {
    const host = fixture()
    const fetcher: typeof host.fetcher = async () => {
      if (failure === "transport") throw new Error("connection refused")
      return failure === "server" ? { status: 500 } : { status: 200, text: async () => { throw new Error("unreadable") } }
    }
    await expect(associateFirstMateSession(unsupportedCli, registration, { ...host, fetcher })).rejects.toThrow("is saved")
    expect(host.requests).toHaveLength(0)
  })

  test("the served projection still requires a registered project and respects directory ownership", () => {
    const sessions = [{ id: "unknown-project", directory: "/homes/elsewhere", metadata: { openchamber: { projectDirectory: "/repos/unregistered" } } }, { id: "directory-wins", directory: "/repos/moonrise", metadata: { openchamber: { projectDirectory: registration.projectDirectory } } }]
    const projects = [{ id: "sunrise", normalizedPath: registration.projectDirectory }, { id: "moonrise", normalizedPath: "/repos/moonrise" }]
    const ownership = servedOwnership(sessions, projects, new Map(), false)
    expect(Array.from(ownership.bySessionId.keys())).toEqual(["directory-wins"])
    expect(ownership.bySessionId.get("directory-wins").projectId).toBe("moonrise")
    expect(servedOwnership(sessions, [projects[0]], new Map(), true).bySessionId.size).toBe(0)
  })

  test.each([{ coordinatorSessionId: " " }, { homeDirectory: "relative-home" }, { projectDirectory: "relative-project" }])("refuses invalid fallback targets before any HTTP request: %j", async (value) => {
    const host = fixture()
    await expect(associateFirstMateSession(unsupportedCli, { ...registration, ...value }, host)).rejects.toThrow("exact session and absolute")
    expect(host.requests).toHaveLength(0)
  })

  test("encodes session IDs and home directories without changing the project path", async () => {
    const host = fixture()
    const target = { ...registration, coordinatorSessionId: "ses/a b", homeDirectory: "/home/first mate/projects/sunrise", projectDirectory: "/repos/sun rise" }
    host.sessions.set(target.coordinatorSessionId, { ...structuredClone(host.sessions.get("ses_current")!), id: target.coordinatorSessionId, directory: target.homeDirectory })
    await associateFirstMateSession(unsupportedCli, target, host)
    expect(host.requests[0].url).toBe("http://127.0.0.1:4096/api/openchamber/sessions/ses%2Fa%20b/metadata?directory=%2Fhome%2Ffirst%20mate%2Fprojects%2Fsunrise")
    expect(host.sessions.get(target.coordinatorSessionId)!.metadata.openchamber.projectDirectory).toBe(target.projectDirectory)
    expect(host.sessions.get("ses_current")!.metadata.openchamber.projectDirectory).toBeUndefined()
  })

  test("an empty metadata response for a missing session never authorizes a write", async () => {
    const host = fixture()
    host.sessions.delete("ses_current")
    const fetcher: typeof host.fetcher = async (url, init) => url.includes("/metadata") ? { status: 200, text: async () => '{"metadata":{}}' } : host.fetcher(url, init)
    await expect(associateFirstMateSession(unsupportedCli, registration, { ...host, fetcher })).rejects.toThrow("is saved")
    expect(host.requests.some((request) => request.method === "POST")).toBe(false)
  })
})
