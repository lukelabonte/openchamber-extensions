import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import path from "node:path"
import { parseBacklog } from "../service/backlog"

const template = (name: string): string => readFileSync(path.join(import.meta.dir, "..", "templates", name), "utf8")
const charter = template("charter.md")
const backlog = template("backlog.md")
const projectCharter = template("project-charter.md")

describe("FirstMate charter workflows", () => {
  test("keeps project isolation and worker-only repository mutation in a short charter", () => {
    expect(charter.trim().split("\n").length).toBeLessThan(180)
    expect(charter).toContain("one first mate per OpenChamber project")
    expect(charter).toContain("Even an explicit captain request never authorizes you to mutate a managed repository yourself")
    expect(charter).toContain("Landing is always dispatched to a landing worker in its own worktree")
    expect(charter).not.toMatch(/\bbb (?:thread|project|firstmate-crew)\b/)
  })

  test("makes handoff holds durable and dependent on the captain's actual answer", () => {
    expect(charter).toContain("Relayed to FirstMate, from ...")
    expect(charter).toContain("starts, steers, or relaunches")
    expect(charter).toContain("hold: captain's word to land")
    expect(charter).toContain("overrides `+yolo` and standing landing orders")
    expect(charter).toContain("through restarts and relaunches")
    expect(charter).toContain("in the FirstMate chat")
    expect(charter).toContain("`/decision` relays an answer")
    expect(charter).toContain("doesn't clear holds or merge automatically")
  })

  test("puts exact-head checks and final merge proof in the landing worker's brief", () => {
    expect(charter).toContain("review-head:")
    expect(charter).toContain("gh pr view <url> --json state,headRefOid,mergeStateStatus,statusCheckRollup")
    expect(charter).toContain("gh pr checks <url> --required")
    expect(charter).toContain("`OPEN`")
    expect(charter).toContain("`CLEAN`")
    expect(charter).toContain("gh pr merge <url> --match-head-commit <review-head>")
    expect(charter).toContain("gh pr view <url> --json state,mergeCommit")
    expect(charter).toContain("`MERGED`")
    expect(charter).toContain("A failed or absent CI result is never green")
    expect(charter).toContain("None required isn't proof of green CI")
  })

  test("uses durable findings and requires authorization for scout promotion", () => {
    expect(charter).toContain("Ship (`kind: ship`)")
    expect(charter).toContain("Scout (`kind: scout`)")
    expect(charter).toContain("learnings.md")
    expect(charter).toContain("reports/<id>.md")
    expect(charter).toContain("isolated reproduction, not a fix")
    expect(charter).toContain("end-to-end reproduction")
    expect(charter).toContain("disconfirming evidence")
    expect(charter).toContain("Only after the captain authorizes implementation")
    expect(charter).toContain("same task id and title")
    expect(charter).toContain("A finding or recommendation isn't implementation authority")
  })

  test("bounds recovery and doesn't infer unsupported host failure causes", () => {
    expect(charter).toContain("event summaries, not every-turn native full-message relays")
    expect(charter).toContain("`session.status`")
    expect(charter).toContain("`session.messages`")
    expect(charter).toContain("manual interruption, or an unknown interruption cause")
    expect(charter).toContain("captain's approval before steering or relaunching")
    expect(charter).toContain("Relaunch at most once")
    expect(charter).toContain("`directory` set to the recorded existing worktree")
    expect(charter).toContain("The CLI's busy/idle status doesn't identify")
    expect(charter).toContain("only with actual supporting evidence")
  })

  test("cites returned message IDs and keeps reads within the host's supported message API", () => {
    expect(charter).toContain("openchamber://session/<sessionId>?message=<messageId>")
    expect(charter).toContain("returned message id")
    expect(charter).toContain("bounded `session.messages` reads")
    expect(charter).toContain("doesn't expose a single-message read")
    expect(charter).toContain("never invent a message id")
  })

  test("keeps provider-specific variant IDs intact and names the unsupported session-option boundary", () => {
    expect(charter).toContain("provider's exact variant id")
    expect(charter).toContain("not a fixed reasoning-level enum")
    expect(charter).toContain("doesn't accept arbitrary provider session options")
  })

  test("states the host auto-accept boundary rather than promising a permission classifier", () => {
    expect(charter).toContain("Permission sensitivity belongs in every brief")
    expect(charter).toContain("auto-accept can approve every permission request")
    expect(charter).toContain("isn't a permission classifier or a pre-request safety gate")
    expect(charter).toContain("workers must stop before an out-of-scope or sensitive action")
  })

  test("keeps watches conservative, dismissal history read-only, and End non-destructive", () => {
    expect(charter).toContain("act on it only when the captain asks")
    expect(charter).toContain("Read the current `suggestions.md` and `suggestions-dismissed.md` before rewriting")
    expect(charter).toContain("Never edit or overwrite `suggestions-dismissed.md`")
    expect(charter).toContain("End archives the board card only; it preserves the session and worktree")
    expect(charter).toContain("Cleanup after a landing is the captain's job")
    expect(charter).toContain("Discarding unlanded work always needs explicit captain approval")
  })

  test("lets the coordinator retire checked workers explicitly without treating idle or Done alone as authorization", () => {
    expect(charter).toContain("archive-session: <exact current session id>")
    expect(charter).toContain("Done alone doesn't request archival")
    expect(charter).toContain("Respect captain requests to keep a session active")
    expect(charter).toContain("Wait for its confirmation")
    expect(charter).toContain("a request for an old session never authorizes archiving its replacement")
    expect(backlog).toContain("archive-session:")
    expect(backlog).toContain("The backlog entry and saved report remain after archival")
  })

  test("documents immutable ids, task-specific answers and evidence-based dependency release", () => {
    expect(backlog).toContain("at most 64 characters")
    expect(backlog).toContain("Keep the id and title immutable")
    expect(backlog).toContain("explicit task id")
    expect(backlog).toContain("only after its blocker is evidence-backed `Done`")
    expect(backlog).toContain("Remove `hold:` and `actions:` only after interpreting")
    expect(projectCharter).toContain("Hard rules still apply")
    expect(projectCharter).toContain("doesn't authorize repository mutation, landing, scope expansion, or discard")
  })

  test("ships an empty backlog and parseable examples of the approved field contract", () => {
    expect(parseBacklog(backlog)).toEqual({ tasks: [], errors: [] })
    const examples = [...backlog.matchAll(/```markdown\n([\s\S]*?)\n```/g)]
    expect(examples).toHaveLength(2)
    expect(parseBacklog(examples[0][1]).tasks.map((task) => task.title)).toEqual([
      "Add dark mode",
      "Audit dark mode contrast",
      "Choose cache policy",
    ])
    for (const example of examples) {
      const parsed = parseBacklog(example[1])
      expect(parsed.errors).toEqual([])
      expect(parsed.tasks.length).toBeGreaterThan(0)
    }
  })
})
