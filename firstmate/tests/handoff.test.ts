import { describe, expect, test } from "bun:test"
import { handoffToFirstMate } from "../service/handoff"
import { InMemoryFileSystem } from "./helpers/in-memory-file-system"

function fixture() {
  const filesystem = new InMemoryFileSystem()
  filesystem.seedFile("/fm/registry.json", JSON.stringify({ sunrise: { slug: "sunrise", projectDirectory: "/repos/sunrise", homeDirectory: "/fm/projects/sunrise", coordinatorSessionId: "ses_mate", createdAt: "2026-10-13T00:00:00Z" } }))
  const calls: string[][] = []
  return { filesystem, calls, exec: async (_command: string, args: readonly string[]) => { calls.push([...args]); return "{}" } }
}

describe("FirstMate handoffs", () => {
  test("preserves a multiline request and marks it as relayed, not approval", async () => {
    const { filesystem, exec, calls } = fixture()
    const text = 'Review this\n`$(touch unsafe)`\n  keep spacing'
    await handoffToFirstMate({ filesystem: filesystem.port, exec, homeRoot: "/fm", directory: "/repos/sunrise", sessionId: "ses_worker", text })
    const prompt = calls[0][calls[0].indexOf("--prompt") + 1]
    expect(prompt.endsWith(text)).toBe(true)
    expect(prompt).toContain("Relayed to FirstMate, from")
    expect(prompt).toContain("not merge approval")
    expect(calls[0]).toContain("ses_mate")
  })

  test("resolves a recorded worktree without routing to another project", async () => {
    const { filesystem, exec, calls } = fixture()
    filesystem.seedFile("/fm/projects/sunrise/backlog.md", "- Login\n  state: Working\n  session: ses_worker\n  worktree: /worktrees/login\n")
    await handoffToFirstMate({ filesystem: filesystem.port, exec, homeRoot: "/fm", directory: "/worktrees/login", text: "Review" })
    expect(calls[0]).toContain("ses_mate")
  })

  test.each(["", " ", "a".repeat(12001)])("rejects empty or oversized input", async (text) => {
    const { filesystem, exec, calls } = fixture()
    await expect(handoffToFirstMate({ filesystem: filesystem.port, exec, homeRoot: "/fm", directory: "/repos/sunrise", text })).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })

  test("unknown directories don't fall back to the first registered mate", async () => {
    const { filesystem, exec, calls } = fixture()
    await expect(handoffToFirstMate({ filesystem: filesystem.port, exec, homeRoot: "/fm", directory: "/repos/other", text: "Review" })).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })
})
