import { describe, expect, test } from "bun:test"
import type { ExecRunner } from "../service/control-client"
import type { ClockPort } from "../service/clock"
import { deliverNotification, type Notification } from "../service/forwarder"

const notification: Notification = {
  slug: "sunrise",
  coordinatorSessionId: "ses_coord_1",
  homeDirectory: "/home/firstmate/projects/sunrise",
  message: "FirstMate (sunrise) worker update",
}

function busyExec(busyAttempts: number): { exec: ExecRunner; attempts: () => number } {
  let count = 0
  const exec: ExecRunner = async (_command, args) => {
    count += 1
    if (count <= busyAttempts) {
      throw new Error("openchamber exited with code 1: SESSION_BUSY: the session is busy")
    }
    expect(args.includes("ses_coord_1")).toBe(true)
    return '{"ok":true}'
  }
  return { exec, attempts: () => count }
}

function failingClock(): { clock: ClockPort; delays: number[] } {
  const delays: number[] = []
  const clock: ClockPort = {
    nowMs: () => 0,
    delay: async (ms) => {
      delays.push(ms)
    },
    startInterval: () => ({ cancel: () => undefined }),
  }
  return { clock, delays }
}

describe("deliverNotification", () => {
  test("delivers the notification to the coordinator session via session send", async () => {
    const { exec, attempts } = busyExec(0)
    const { clock, delays } = failingClock()

    await deliverNotification({ exec, clock, notification })

    expect(attempts()).toBe(1)
    expect(delays).toEqual([])
  })

  test("retries a busy coordinator with backoff: 30s, then 2m", async () => {
    const { exec, attempts } = busyExec(2)
    const { clock, delays } = failingClock()

    await deliverNotification({ exec, clock, notification })

    expect(attempts()).toBe(3)
    expect(delays).toEqual([30_000, 120_000])
  })

  test("keeps retrying every 5 minutes after the initial schedule", async () => {
    const { exec, attempts } = busyExec(4)
    const { clock, delays } = failingClock()

    await deliverNotification({ exec, clock, notification })

    expect(attempts()).toBe(5)
    expect(delays).toEqual([30_000, 120_000, 300_000, 300_000])
  })

  test("a non-busy failure is raised to the caller without retrying", async () => {
    const exec: ExecRunner = async () => {
      throw new Error("openchamber exited with code 1: no such session")
    }
    const { clock, delays } = failingClock()

    await expect(deliverNotification({ exec, clock, notification })).rejects.toThrow("no such session")
    expect(delays).toEqual([])
  })
})
