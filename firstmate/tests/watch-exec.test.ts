import { describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { executeWatch } from "../service/watch-exec"

describe("bounded watch subprocesses", () => {
  test("drains stderr and preserves a bounded tail", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "firstmate-watch-exec-"))
    try {
      const scriptPath = path.join(directory, "watch")
      writeFileSync(scriptPath, `#!${process.execPath}\nprocess.stderr.write('x'.repeat(100000)); process.stderr.write('final error'); process.stdout.write('signal'); process.exitCode = 3\n`)
      chmodSync(scriptPath, 0o755)
      const result = await executeWatch({ scriptPath, cwd: directory, env: {}, timeoutMs: 2000 })
      expect(result.stdout).toBe("signal")
      expect(result.stderr.endsWith("final error")).toBe(true)
      expect(result.stderr.length).toBeLessThan(7000)
      expect(result.exitCode).toBe(3)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })

  test("a watch ignoring SIGTERM is killed after its timeout", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "firstmate-watch-timeout-"))
    try {
      const scriptPath = path.join(directory, "watch")
      writeFileSync(scriptPath, "#!/bin/sh\ntrap '' TERM\nwhile :; do sleep 1; done\n")
      chmodSync(scriptPath, 0o755)
      const start = Date.now()
      const result = await executeWatch({ scriptPath, cwd: directory, env: {}, timeoutMs: 100 }, 100)
      expect(result.timedOut).toBe(true)
      expect(Date.now() - start).toBeLessThan(2500)
    } finally { rmSync(directory, { recursive: true, force: true }) }
  })
})
