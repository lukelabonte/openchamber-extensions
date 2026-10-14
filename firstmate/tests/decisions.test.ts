import { describe, expect, test } from "bun:test"
import { sendTaskDecision } from "../service/decisions"
import { InMemoryFileSystem } from "./helpers/in-memory-file-system"

function fixture(backlog = "- Approve PR\n  id: approve-pr\n  kind: captain\n  state: Blocked\n  hold: Merge?\n  actions: Merge => Merge https://github.com/example/repo/pull/1 | Hold => Leave it open\n") {
  const filesystem = new InMemoryFileSystem()
  filesystem.seedFile("/fm/registry.json", JSON.stringify({ sunrise: { slug: "sunrise", projectDirectory: "/repos/sunrise", homeDirectory: "/fm/projects/sunrise", coordinatorSessionId: "ses_mate", createdAt: "2026-10-13T00:00:00Z" } }))
  filesystem.seedFile("/fm/projects/sunrise/backlog.md", backlog)
  const calls: string[][] = []
  return { filesystem, calls, exec: async (_command: string, args: readonly string[]) => { calls.push([...args]); return "{}" } }
}

describe("captain task decisions", () => {
  test("an action answers the first mate, never a worker or a merge command", async () => {
    const { filesystem, calls, exec } = fixture()
    await sendTaskDecision({ filesystem: filesystem.port, exec, homeRoot: "/fm", slug: "sunrise", taskId: "approve-pr", label: "Merge", expectedText: "Merge https://github.com/example/repo/pull/1" })
    expect(calls).toHaveLength(1)
    expect(calls[0]).toContain("ses_mate")
    expect(calls[0][calls[0].indexOf("--prompt") + 1]).toBe("Task approve-pr — Approve PR: Merge https://github.com/example/repo/pull/1")
    expect(filesystem.fileContents("/fm/projects/sunrise/backlog.md")).toContain("hold: Merge?")
  })

  test("free answers preserve the text under a stable task identity", async () => {
    const { filesystem, calls, exec } = fixture()
    await sendTaskDecision({ filesystem: filesystem.port, exec, homeRoot: "/fm", slug: "sunrise", taskId: "approve-pr", text: "Hold\nuntil tomorrow" })
    expect(calls[0][calls[0].indexOf("--prompt") + 1]).toContain("Hold\nuntil tomorrow")
  })

  test("a stale action is rejected, not substituted with new instructions", async () => {
    const { filesystem, calls, exec } = fixture()
    await expect(sendTaskDecision({ filesystem: filesystem.port, exec, homeRoot: "/fm", slug: "sunrise", taskId: "approve-pr", label: "Merge", expectedText: "Old prompt" })).rejects.toThrow("changed")
    expect(calls).toHaveLength(0)
  })

  test("an action without the displayed prompt can't bypass the stale-action guard", async () => {
    const { filesystem, calls, exec } = fixture()
    await expect(sendTaskDecision({ filesystem: filesystem.port, exec, homeRoot: "/fm", slug: "sunrise", taskId: "approve-pr", label: "Merge" })).rejects.toThrow("required")
    expect(calls).toHaveLength(0)
  })

  test.each([{ taskId: "../escape", text: "yes" }, { taskId: "missing", text: "yes" }, { taskId: "approve-pr", text: "" }, { taskId: "approve-pr", label: "Missing" }, { taskId: "approve-pr", label: "Merge", text: "Also this" }])("rejects invalid or ambiguous requests: %j", async (answer) => {
    const { filesystem, calls, exec } = fixture()
    await expect(sendTaskDecision({ filesystem: filesystem.port, exec, homeRoot: "/fm", slug: "sunrise", ...answer })).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })

  test("malformed or duplicate task records can't authorize a decision", async () => {
    const { filesystem, calls, exec } = fixture("- One\n  state: Blocked\n  id: approve-pr\n- Two\n  state: Blocked\n  id: approve-pr\n")
    await expect(sendTaskDecision({ filesystem: filesystem.port, exec, homeRoot: "/fm", slug: "sunrise", taskId: "approve-pr", text: "yes" })).rejects.toThrow()
    expect(calls).toHaveLength(0)
  })
})
