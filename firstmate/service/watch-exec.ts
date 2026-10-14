import { spawn } from "node:child_process"
import type { WatchExecPort, WatchExecution } from "./watches"

function boundedTail(limit: number) {
  const chunks: Buffer[] = []
  let totalBytes = 0
  let keptBytes = 0
  return {
    append(chunk: Buffer): void {
      totalBytes += chunk.length
      keptBytes += chunk.length
      chunks.push(chunk)
      while (keptBytes > limit) {
        const overflow = keptBytes - limit
        if (chunks[0].length <= overflow) keptBytes -= chunks.shift()!.length
        else { chunks[0] = chunks[0].subarray(overflow); keptBytes -= overflow }
      }
    },
    text(): string {
      const dropped = totalBytes - keptBytes
      return `${dropped > 0 ? `…[truncated ${dropped} bytes]\n` : ""}${Buffer.concat(chunks).toString("utf8")}`
    },
  }
}

export function executeWatch(input: Parameters<WatchExecPort>[0], stopGraceMs = 1500): Promise<WatchExecution & { stderr: string }> {
  return new Promise((resolve, reject) => {
    const grouped = process.platform !== "win32"
    const child = spawn(input.scriptPath, [], { cwd: input.cwd, env: { ...process.env, ...input.env }, detached: grouped, stdio: ["ignore", "pipe", "pipe"] })
    const stdout = boundedTail(256 * 1024)
    const stderr = boundedTail(6000)
    let timedOut = false
    let forceStopTimer: ReturnType<typeof setTimeout> | undefined
    const stop = (signal: NodeJS.Signals): void => {
      try {
        if (grouped && child.pid !== undefined) process.kill(-child.pid, signal)
        else child.kill(signal)
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ESRCH") {
          try { child.kill(signal) }
          catch (stopError) { reject(stopError) }
        }
      }
    }
    const timer = setTimeout(() => {
      timedOut = true
      stop("SIGTERM")
      forceStopTimer = setTimeout(() => stop("SIGKILL"), stopGraceMs)
    }, input.timeoutMs)
    child.stdout.on("data", stdout.append)
    child.stderr.on("data", stderr.append)
    child.on("error", (error) => { clearTimeout(timer); clearTimeout(forceStopTimer); reject(error) })
    child.on("close", (exitCode) => {
      clearTimeout(timer)
      clearTimeout(forceStopTimer)
      resolve({ stdout: stdout.text(), stderr: stderr.text(), exitCode, timedOut })
    })
  })
}
