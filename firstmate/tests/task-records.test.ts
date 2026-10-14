import { describe, expect, test } from "bun:test"
import { formatBacklogEntry, parseBacklog, type BacklogState, type BacklogTask } from "../service/backlog"
import { buildBoardWorker } from "../service/board"
import { boardColumnOrder, groupBoardColumns, parseBoardWorkers, toBoardCard, type BoardWorker } from "../panel/board"

const taskRecord: BacklogTask = {
  title: "Review the login fix",
  state: "Queued",
  id: "review-login",
  kind: "scout",
  blockedBy: "fix-login",
  hold: "Captain approval required",
  reviewHead: "a1b2c3d4".repeat(5),
  actions: [
    { label: "Merge", text: "Approve the reviewed head only" },
    { label: "Hold", text: "Keep the merge hold" },
  ],
}

describe("backlog task records", () => {
  test("formats and parses every new field with the canonical markdown keys", () => {
    const markdown = [
      "- Review the login fix",
      "  state: Queued",
      "  id: review-login",
      "  kind: scout",
      "  blocked-by: fix-login",
      "  hold: Captain approval required",
      `  review-head: ${"a1b2c3d4".repeat(5)}`,
      "  actions: Merge => Approve the reviewed head only | Hold => Keep the merge hold",
    ].join("\n")
    expect(formatBacklogEntry(taskRecord)).toBe(markdown)
    expect(parseBacklog(markdown)).toEqual({ tasks: [taskRecord], errors: [] })
  })

  test("decodes escaped pipes and backslashes without interpreting prompt text", () => {
    const markdown = String.raw`- Review
  state: Blocked
  actions: Merge\|hold => Read C:\\work\\report; A => B \| <script>$(command)</script> | Hold => Leave \\ untouched`
    const task: BacklogTask = {
      title: "Review",
      state: "Blocked",
      actions: [
        { label: "Merge|hold", text: "Read C:\\work\\report; A => B | <script>$(command)</script>" },
        { label: "Hold", text: "Leave \\ untouched" },
      ],
    }
    expect(parseBacklog(markdown)).toEqual({ tasks: [task], errors: [] })
    expect(formatBacklogEntry(task)).toBe(markdown)
  })

  test("round-trips a literal backslash followed by a pipe", () => {
    const task: BacklogTask = {
      title: "Escaped punctuation",
      state: "Queued",
      actions: [{ label: "Read\\|note", text: "A\\|B\\" }],
    }
    expect(parseBacklog(formatBacklogEntry(task))).toEqual({ tasks: [task], errors: [] })
  })

  test("preserves an explicitly empty action array", () => {
    const task: BacklogTask = { title: "No decisions", state: "Queued", actions: [] }
    expect(parseBacklog(formatBacklogEntry(task))).toEqual({ tasks: [task], errors: [] })
  })

  test("round-trips four distinct decisions at the action count limit", () => {
    const task: BacklogTask = {
      title: "Decide",
      state: "Blocked",
      actions: [
        { label: "Merge", text: "Approve" },
        { label: "Hold", text: "Wait" },
        { label: "Scout", text: "Investigate" },
        { label: "Cancel", text: "Stop" },
      ],
    }
    expect(parseBacklog(formatBacklogEntry(task))).toEqual({ tasks: [task], errors: [] })
  })

  test.each(["ship", "scout", "captain"] as const)("accepts kind %s without adding defaults", (kind) => {
    const task: BacklogTask = { title: "Task", state: "Queued", kind }
    expect(parseBacklog(formatBacklogEntry(task))).toEqual({ tasks: [task], errors: [] })
  })

  test.each(["a", "0", "a".repeat(64)])("accepts path-safe task IDs at the bounds: %s", (id) => {
    const task: BacklogTask = { title: "Task", state: "Queued", id, blockedBy: id }
    expect(parseBacklog(formatBacklogEntry(task))).toEqual({ tasks: [task], errors: [] })
  })

  test.each(["abcdef0", "ABCDEF12".repeat(5), "a".repeat(64)])("preserves hex review heads: %s", (reviewHead) => {
    const task: BacklogTask = { title: "Task", state: "Queued", reviewHead }
    expect(parseBacklog(formatBacklogEntry(task))).toEqual({ tasks: [task], errors: [] })
  })

  test("legacy records retain their exact shape and canonical formatting", () => {
    const markdown = "- Legacy\n  state: Working\n  session: ses_legacy\n  branch: fm/legacy"
    const task: BacklogTask = { title: "Legacy", state: "Working", sessionId: "ses_legacy", branch: "fm/legacy" }
    expect(parseBacklog(markdown)).toEqual({ tasks: [task], errors: [] })
    expect(formatBacklogEntry(task)).toBe(markdown)
  })

  for (const key of ["id", "blocked-by"]) {
    test.each(["", "../task", "a/b", "a\\b", ".", "..", "UPPER", "a_b", "a b", "-task", "a".repeat(65)])(
      `rejects invalid ${key} values with field-line diagnostics: %s`,
      (value) => {
        const parsed = parseBacklog(`- Invalid\n  state: Queued\n  ${key}: ${value}\n- Valid\n  state: Done`)
        expect(parsed.tasks).toEqual([{ title: "Valid", state: "Done" }])
        expect(parsed.errors).toEqual([{ line: 3, message: expect.stringContaining(`"${key}"`) }])
      },
    )
  }

  test.each([
    ["kind", "build"],
    ["kind", "Ship"],
    ["kind", ""],
    ["hold", "   "],
    ["review-head", "not-a-sha"],
    ["review-head", "a".repeat(6)],
    ["review-head", "a".repeat(65)],
    ["review-head", ""],
    ["actions", "Merge"],
    ["actions", "=> prompt"],
    ["actions", "Merge =>"],
    ["actions", "Merge => prompt | Merge => another prompt"],
    ["actions", "Merge => prompt |   Merge   => another prompt"],
    ["actions", String.raw`Merge\|hold => prompt | Merge\|hold => other`],
    ["actions", "One => 1 | Two => 2 | Three => 3 | Four => 4 | Five => 5"],
    ["actions", "Merge => prompt |"],
    ["actions", "| Merge => prompt"],
    ["actions", "Merge => prompt | unescaped pipe"],
    ["actions", "Merge => prompt\\"],
    ["actions", String.raw`Merge => prompt\q`],
  ])("rejects malformed %s: %s", (key, value) => {
    const parsed = parseBacklog(`- Invalid\n  state: Queued\n  ${key}: ${value}\n- Valid\n  state: Done`)
    expect(parsed.tasks).toEqual([{ title: "Valid", state: "Done" }])
    expect(parsed.errors).toEqual([{ line: 3, message: expect.stringContaining(`"${key}"`) }])
  })

  test.each([
    ["id", "task"],
    ["kind", "ship"],
    ["blocked-by", "other-task"],
    ["hold", "Wait for approval"],
    ["review-head", "a".repeat(40)],
    ["actions", "Merge => Approve"],
  ])("rejects repeated %s fields at the second line", (key, value) => {
    const parsed = parseBacklog(`- Task\n  state: Queued\n  ${key}: ${value}\n  ${key}: ${value}`)
    expect(parsed.tasks).toEqual([])
    expect(parsed.errors).toEqual([{ line: 4, message: expect.stringContaining(`repeats the "${key}" field`) }])
  })

  test.each(["id", "kind", "blocked-by", "hold", "review-head", "actions"])(
    "reports orphan %s fields instead of ignoring them",
    (key) => {
      expect(parseBacklog(`  ${key}: value`)).toEqual({
        tasks: [],
        errors: [{ line: 1, message: expect.stringContaining("no entry") }],
      })
    },
  )

  test("rejects a repeated task ID without losing the first task or unrelated entries", () => {
    const parsed = parseBacklog("- First\n  state: Queued\n  id: same\n- Duplicate\n  state: Working\n  id: same\n- Legacy\n  state: Idle")
    expect(parsed.tasks).toEqual([
      { title: "First", state: "Queued", id: "same" },
      { title: "Legacy", state: "Idle" },
    ])
    expect(parsed.errors).toEqual([{ line: 6, message: expect.stringContaining('"same"') }])
  })

  test("an invalid entry does not reserve its task ID", () => {
    const parsed = parseBacklog("- Invalid\n  id: same\n  kind: unknown\n  state: Queued\n- Valid\n  state: Done\n  id: same")
    expect(parsed.tasks).toEqual([{ title: "Valid", state: "Done", id: "same" }])
    expect(parsed.errors).toEqual([{ line: 3, message: expect.stringContaining('"kind"') }])
  })

  test("a rich record still requires the existing state field", () => {
    const parsed = parseBacklog("- No state\n  id: missing-state\n  kind: captain\n  hold: Answer required\n  actions: Answer => Proceed")
    expect(parsed.tasks).toEqual([])
    expect(parsed.errors).toEqual([{ line: 1, message: expect.stringContaining("no state") }])
  })
})

describe("task record board display", () => {
  const nonterminalStates: BacklogState[] = ["Queued", "Working", "Blocked", "Parked", "Idle"]
  const terminalStates: BacklogState[] = ["Done", "Failed"]
  for (const blocker of [{ hold: "Approval needed" }, { kind: "captain" as const }, { blockedBy: "dependency" }]) {
    test.each(nonterminalStates)(`maps %s tasks with ${Object.keys(blocker)[0]} and running signals`, (state) => {
      const expected = "hold" in blocker && (state === "Queued" || state === "Working") ? "Working" : "Blocked"
      expect(buildBoardWorker({ title: "Task", state, sessionId: "ses_task", ...blocker }, { status: { activity: "running", outcome: null } }).state).toBe(expected)
      expect(buildBoardWorker({ title: "Task", state, ...blocker }).state).toBe("Blocked")
    })

    test.each(terminalStates)(`keeps terminal %s with ${Object.keys(blocker)[0]}`, (state) => {
      expect(buildBoardWorker({ title: "Task", state, sessionId: "ses_task", ...blocker }, { status: { activity: "waiting-question", outcome: null } }).state).toBe(state)
    })
  }

  test("a live terminal failure is not hidden by a task hold", () => {
    expect(buildBoardWorker({ title: "Task", state: "Working", sessionId: "ses_task", hold: "Approval needed" }, { status: { activity: "idle", outcome: "failed" } }).state).toBe("Failed")
  })

  test("an optional resolved dependency only removes the dependency display block", () => {
    const task: BacklogTask = { title: "Task", state: "Queued", blockedBy: "dependency" }
    expect(buildBoardWorker(task).state).toBe("Blocked")
    expect(buildBoardWorker(task, undefined, false).state).toBe("Blocked")
    expect(buildBoardWorker(task, undefined, true)).toEqual({ title: "Task", state: "Queued", blockedBy: "dependency" })
    expect(buildBoardWorker({ ...task, hold: "Wait" }, undefined, true).state).toBe("Blocked")
    expect(buildBoardWorker({ ...task, kind: "captain" }, undefined, true).state).toBe("Blocked")
    expect(task.state).toBe("Queued")
  })

  test("preserves live question and permission reasons when a task is held", () => {
    for (const [activity, blockedReason] of [["waiting-question", "question"], ["waiting-permission", "permission"]] as const) {
      expect(buildBoardWorker({ title: "Task", state: "Working", sessionId: "ses_task", hold: "Wait" }, { status: { activity, outcome: null } })).toMatchObject({ state: "Blocked", blockedReason })
    }
  })

  test("ship and scout without blockers keep existing queued behavior", () => {
    for (const kind of ["ship", "scout"] as const) {
      expect(buildBoardWorker({ title: "Task", state: "Queued", kind }).state).toBe("Queued")
    }
  })

  test("passes exact task metadata through service, panel validation, cards and columns", () => {
    const exactHold = `  <b>${"h".repeat(200)}</b>\n$(command)  `
    const exactLabel = "  Merge=>hold|note  "
    const exactText = `  <script>${"p".repeat(300)} => \\| $(command)</script>\nnext line  `
    const task: BacklogTask = {
      ...taskRecord,
      hold: exactHold,
      actions: [{ label: exactLabel, text: exactText }],
    }
    const wire: BoardWorker = {
      title: task.title,
      state: "Blocked",
      taskId: task.id,
      kind: task.kind,
      blockedBy: task.blockedBy,
      hold: exactHold,
      reviewHead: task.reviewHead,
      actions: [{ label: exactLabel, text: exactText }],
    }
    const worker = buildBoardWorker(task)
    expect(worker).toEqual(wire)
    const parsed = parseBoardWorkers([worker])
    expect(parsed).toEqual({ workers: [wire], malformedCount: 0 })
    expect(toBoardCard(parsed.workers[0])).toEqual(wire)
    expect(groupBoardColumns(parsed.workers)).toEqual([{ id: "Blocked", cards: [wire] }])
    expect(task.state).toBe("Queued")
    expect(task.actions).toEqual([{ label: exactLabel, text: exactText }])
  })

  test("preserves legacy panel payloads without inventing task metadata", () => {
    const worker = { title: "Legacy", state: "Queued" as const }
    expect(parseBoardWorkers([worker])).toEqual({ workers: [worker], malformedCount: 0 })
    expect(toBoardCard(worker)).toEqual(worker)
    expect(boardColumnOrder).toEqual(["Queued", "Working", "Blocked", "Parked", "Done", "Failed", "Idle"])
  })

  test.each([
    { taskId: 5 },
    { taskId: "" },
    { taskId: "../task" },
    { taskId: "task\n" },
    { taskId: "a".repeat(65) },
    { kind: null },
    { kind: "build" },
    { blockedBy: [] },
    { blockedBy: "a/b" },
    { blockedBy: "dependency\n" },
    { hold: false },
    { hold: "   " },
    { reviewHead: {} },
    { reviewHead: "not-a-sha" },
    { reviewHead: `${"a".repeat(40)}\n` },
    { actions: "Merge => prompt" },
    { actions: null },
    { actions: [null] },
    { actions: [[]] },
    { actions: [{ label: "Merge" }] },
    { actions: [{ text: "prompt" }] },
    { actions: [{ label: 1, text: "prompt" }] },
    { actions: [{ label: "Merge", text: 1 }] },
    { actions: [{ label: "  ", text: "prompt" }] },
    { actions: [{ label: "Merge", text: "   " }] },
    { actions: [{ label: "Merge", text: "prompt" }, { label: " Merge ", text: "other" }] },
    { actions: [1, 2, 3, 4, 5].map((index) => ({ label: `Action ${index}`, text: "prompt" })) },
  ])("skips malformed new wire fields without poisoning valid workers: %j", (fields) => {
    const valid: BoardWorker = { title: "Valid", state: "Done" }
    expect(parseBoardWorkers([{ title: "Invalid", state: "Queued", ...fields }, valid])).toEqual({ workers: [valid], malformedCount: 1 })
  })

  test("keeps only action label/text data and accepts zero to four actions", () => {
    for (const actions of [[], [1, 2, 3, 4].map((index) => ({ label: `Action ${index}`, text: "exact prompt" }))]) {
      const parsed = parseBoardWorkers([{ title: "Task", state: "Queued", actions: actions.map((action) => ({ ...action, command: "not executable" })) }])
      expect(parsed).toEqual({ workers: [{ title: "Task", state: "Queued", actions }], malformedCount: 0 })
    }
  })
})
