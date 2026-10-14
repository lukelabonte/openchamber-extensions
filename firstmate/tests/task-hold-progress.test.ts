import { expect, test } from "bun:test"
import { buildBoardWorker } from "../service/board"

test("a landing hold doesn't hide a worker that's still working", () => {
  const worker = buildBoardWorker(
    { title: "Review login", state: "Working", id: "review-login", sessionId: "ses_1", hold: "captain's word to land" },
    { status: { activity: "running", outcome: null } },
  )
  expect(worker.state).toBe("Working")
  expect(worker.hold).toBe("captain's word to land")
})

test("a worker waiting after completion still exposes its landing hold", () => {
  const worker = buildBoardWorker(
    { title: "Review login", state: "Working", sessionId: "ses_1", hold: "captain's word to land" },
    { status: { activity: "idle", outcome: "completed" } },
  )
  expect(worker.state).toBe("Blocked")
})
