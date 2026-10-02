export interface CancellableTimer {
  cancel(): void
}

// Time and scheduling behind a port: the forwarder's retry backoff and the
// service's poll interval run on injected time, so no test ever sleeps.
export interface ClockPort {
  nowMs(): number
  delay(ms: number): Promise<void>
  startInterval(callback: () => void, intervalMs: number): CancellableTimer
}

export function createNodeClock(): ClockPort {
  return {
    nowMs: () => Date.now(),
    delay: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
    startInterval: (callback, intervalMs) => {
      const timer = setInterval(callback, intervalMs)
      return { cancel: () => clearInterval(timer) }
    },
  }
}
