import { expect, test } from "bun:test"
import { createWatchRunner } from "../service/watches"
import { InMemoryFileSystem } from "./helpers/in-memory-file-system"

test("retained watch notes keep more detail than the compact last-run preview", async () => {
  const filesystem = new InMemoryFileSystem()
  const homeDirectory = "/fm/projects/sunrise"
  filesystem.seedFile("/fm/registry.json", JSON.stringify({ sunrise: { slug: "sunrise", projectDirectory: "/repos/sunrise", homeDirectory, coordinatorSessionId: "ses_mate", createdAt: "2026-10-13T00:00:00Z" } }))
  filesystem.seedExecutableFile(`${homeDirectory}/watches/signal`, "#!/bin/sh\n# schedule: @daily\n")
  const output = `Beginning of the report\n${"detail ".repeat(700)}\nEnd of the report`
  const runner = createWatchRunner({
    filesystem: filesystem.port, homeRoot: "/fm", clock: { nowMs: () => Date.UTC(2026, 9, 13) },
    exec: async () => ({ stdout: output, exitCode: 0, timedOut: false }),
    fetcher: async () => { throw new Error("the runner doesn't deliver desktop notifications") },
    resolveSupport: async () => { throw new Error("the runner doesn't discover a desktop") },
  })
  await runner.runNow("sunrise", "project", "signal")
  const pending = await runner.pendingNotifications("sunrise")
  expect(pending.notes[0].notification.message).toContain(output)
  const watches = await runner.listWatches("sunrise")
  expect(watches[0].lastOutput).toContain("truncated")
  expect(watches[0].lastOutput!.length).toBeLessThan(2200)
})
