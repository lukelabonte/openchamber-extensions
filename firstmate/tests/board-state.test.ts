import { describe, expect, test } from "bun:test"
import type { SessionStatus } from "../service/control-client"
import { buildBoardWorker, mapBoardState, type WorkerObservation } from "../service/board"
import type { BacklogTask } from "../service/backlog"
function status(activity: SessionStatus["activity"], outcome: SessionStatus["outcome"] = null): SessionStatus {
  return { activity, outcome }
}

function observation(activity: SessionStatus["activity"], outcome: SessionStatus["outcome"] = null, lastWord?: string): WorkerObservation {
  return { status: status(activity, outcome), lastWord }
}

function task(overrides: Partial<BacklogTask> = {}): BacklogTask {
  return {
    title: "Fix flaky login test",
    state: "Working",
    sessionId: "ses_11bb",
    worktreeDirectory: "/repos/sunrise/.worktrees/fm/login-fix",
    branch: "fm/login-fix",
    prUrl: "https://github.com/example/sunrise/pull/11",
    ...overrides,
  }
}

describe("mapBoardState", () => {
  test("Working plus waiting-question maps to Blocked(question)", () => {
    expect(mapBoardState({ backlogState: "Working", live: status("waiting-question") })).toEqual({
      state: "Blocked",
      blockedReason: "question",
    })
  })

  test("Working plus waiting-permission maps to Blocked(permission)", () => {
    expect(mapBoardState({ backlogState: "Working", live: status("waiting-permission") })).toEqual({
      state: "Blocked",
      blockedReason: "permission",
    })
  })

  test("Working plus idle plus a completed outcome stays Working — completed never means Done", () => {
    expect(mapBoardState({ backlogState: "Working", live: status("idle", "completed") })).toEqual({ state: "Working" })
  })

  test("Working plus idle with no outcome maps to Idle", () => {
    expect(mapBoardState({ backlogState: "Working", live: status("idle") })).toEqual({ state: "Idle" })
  })

  test("Working plus running or retrying stays Working", () => {
    expect(mapBoardState({ backlogState: "Working", live: status("running") })).toEqual({ state: "Working" })
    expect(mapBoardState({ backlogState: "Working", live: status("retrying") })).toEqual({ state: "Working" })
  })

  test("a failed outcome moves Queued and Working to Failed", () => {
    expect(mapBoardState({ backlogState: "Working", live: status("idle", "failed") })).toEqual({ state: "Failed" })
    expect(mapBoardState({ backlogState: "Queued", live: status("running", "failed") })).toEqual({ state: "Failed" })
  })

  test("Queued plus running maps to Working — a dispatched worker that runs is working", () => {
    expect(mapBoardState({ backlogState: "Queued", live: status("running") })).toEqual({ state: "Working" })
    expect(mapBoardState({ backlogState: "Queued", live: status("retrying") })).toEqual({ state: "Working" })
  })

  test("Queued plus waiting signals maps to Blocked", () => {
    expect(mapBoardState({ backlogState: "Queued", live: status("waiting-question") })).toEqual({
      state: "Blocked",
      blockedReason: "question",
    })
    expect(mapBoardState({ backlogState: "Queued", live: status("waiting-permission") })).toEqual({
      state: "Blocked",
      blockedReason: "permission",
    })
  })

  test("Queued with no live signal stays Queued, including idle sessions that never ran", () => {
    expect(mapBoardState({ backlogState: "Queued" })).toEqual({ state: "Queued" })
    expect(mapBoardState({ backlogState: "Queued", live: status("unknown") })).toEqual({ state: "Queued" })
    expect(mapBoardState({ backlogState: "Queued", live: status("idle") })).toEqual({ state: "Queued" })
  })

  test("an unknown activity leaves the backlog state alone", () => {
    expect(mapBoardState({ backlogState: "Working", live: status("unknown") })).toEqual({ state: "Working" })
  })

  test("Blocked, Parked, Done, Failed, and Idle are coordinator-owned and never refined", () => {
    for (const backlogState of ["Blocked", "Parked", "Done", "Failed", "Idle"] as const) {
      expect(mapBoardState({ backlogState, live: status("waiting-question") })).toEqual({ state: backlogState })
      expect(mapBoardState({ backlogState, live: status("idle", "completed") })).toEqual({ state: backlogState })
      expect(mapBoardState({ backlogState, live: status("idle", "failed") })).toEqual({ state: backlogState })
    }
  })
})

describe("buildBoardWorker", () => {
  test("carries the backlog fields and refines the state from the live observation", () => {
    const worker = buildBoardWorker(task(), observation("waiting-question", null, "Which test runner should I use?"))
    expect(worker).toEqual({
      title: "Fix flaky login test",
      state: "Blocked",
      blockedReason: "question",
      lastWord: "Which test runner should I use?",
      prUrl: "https://github.com/example/sunrise/pull/11",
      sessionId: "ses_11bb",
      worktree: "/repos/sunrise/.worktrees/fm/login-fix",
      branch: "fm/login-fix",
    })
  })

  test("a task without a session keeps its backlog state and no observation is needed", () => {
    const worker = buildBoardWorker(task({ sessionId: undefined, state: "Queued" }), undefined)
    expect(worker.state).toBe("Queued")
    expect(worker.sessionId).toBeUndefined()
    expect(worker.lastWord).toBeUndefined()
    expect(worker.blockedReason).toBeUndefined()
  })

  test("a recorded poll error is surfaced as the worker's lastPollError", () => {
    const worker = buildBoardWorker(task(), {
      status: status("running"),
      error: "openchamber exited with code 1: no such session",
    })
    expect(worker.lastPollError).toBe("openchamber exited with code 1: no such session")
    expect(worker.state).toBe("Working")
  })

  test("the last word is truncated to about 280 characters", () => {
    const longWord = "w".repeat(400)
    const worker = buildBoardWorker(task(), observation("idle", null, longWord))
    expect(worker.lastWord).toBe(`${"w".repeat(280)}…`)
  })
})
