// Fake browser environment for driving the real panel entry point
// (firstmate/panel/main.ts) inside a bun test process: a fake clock whose
// timers fire manually, a minimal DOM shaped like the one the panel draws
// with, and the globalThis installation the panel expects (document, window,
// Date.now). The consumer (the panel-refresh probe) runs in its own
// subprocess, so these overrides can never leak into the rest of the suite.

export const fakeTimeOrigin = 1_760_000_000_000

type ScheduledTimer = { kind: "interval" | "timeout"; ms: number; fn: () => void; nextAt: number }

export class FakeElement {
  tagName: string
  className = ""
  children: FakeElement[] = []
  textContent: string | null = ""
  title = ""
  disabled = false
  tabIndex = 0
  type = ""
  checked = false
  value = ""
  placeholder = ""
  attributes = new Map<string, string>()
  listeners = new Map<string, Array<() => void>>()
  parent: FakeElement | null = null

  constructor(tagName: string) {
    this.tagName = tagName.toLowerCase()
  }

  append(...nodes: Array<FakeElement | string>): void {
    for (const node of nodes) {
      if (typeof node === "string") {
        const textNode = new FakeElement("#text")
        textNode.textContent = node
        textNode.parent = this
        this.children.push(textNode)
      } else {
        node.parent = this
        this.children.push(node)
      }
    }
  }

  replaceChildren(): void {
    this.children = []
  }

  addEventListener(type: string, handler: () => void): void {
    const handlers = this.listeners.get(type) ?? []
    handlers.push(handler)
    this.listeners.set(type, handlers)
  }

  removeEventListener(): void {}

  setAttribute(name: string, value: string): void {
    this.attributes.set(name, value)
  }

  get classList(): { add: (...names: string[]) => void } {
    const self = this
    return {
      add(...names: string[]): void {
        const parts = new Set(self.className.split(/\s+/).filter(Boolean))
        for (const name of names) parts.add(name)
        self.className = [...parts].join(" ")
      },
    }
  }

  click(): void {
    for (const handler of this.listeners.get("click") ?? []) handler()
  }

  emitInput(): void {
    for (const handler of this.listeners.get("input") ?? []) handler()
  }
}

export function findFirst(node: FakeElement, predicate: (element: FakeElement) => boolean): FakeElement | null {
  if (predicate(node)) return node
  for (const child of node.children) {
    const found = findFirst(child, predicate)
    if (found !== null) return found
  }
  return null
}

export function findByAriaLabel(root: FakeElement, label: string): FakeElement | null {
  return findFirst(root, (element) => element.attributes.get("aria-label") === label)
}

export function findByText(root: FakeElement, tagName: string, text: string): FakeElement | null {
  return findFirst(root, (element) => element.tagName === tagName && element.textContent === text)
}

// Concatenates the visible text of the tree: leaf textContent fields plus the
// text nodes the panel appends between elements.
export function collectText(node: FakeElement): string {
  return (node.textContent ?? "") + node.children.map((child) => collectText(child)).join("")
}

export type FakeEnvironment = {
  root: FakeElement
  documentElement: FakeElement
  querySelector: (selector: string) => FakeElement | null
  advanceClock: (ms: number) => void
  flushMicrotasks: (rounds?: number) => Promise<void>
}

export function installFakeEnvironment(): FakeEnvironment {
  const clock = { now: fakeTimeOrigin }
  const timers = new Map<number, ScheduledTimer>()
  let timerSequence = 0

  function schedule(kind: "interval" | "timeout", handler: () => void, ms: number): number {
    timerSequence += 1
    timers.set(timerSequence, { kind, ms, fn: handler, nextAt: clock.now + ms })
    return timerSequence
  }

  // Advances the fake clock, firing due timers in schedule order. Intervals
  // re-arm from their previous firing time, so N seconds advances exactly the
  // ticks a real clock would produce.
  function advanceClock(ms: number): void {
    const target = clock.now + ms
    let guard = 0
    while (true) {
      let nextId: number | null = null
      let nextAt = Infinity
      for (const [id, timer] of timers) {
        if (timer.nextAt <= target && timer.nextAt < nextAt) {
          nextAt = timer.nextAt
          nextId = id
        }
      }
      if (nextId === null) break
      const timer = timers.get(nextId)!
      clock.now = Math.max(clock.now, timer.nextAt)
      if (timer.kind === "interval") timer.nextAt = timer.nextAt + timer.ms
      else timers.delete(nextId)
      timer.fn()
      guard += 1
      if (guard > 10_000) throw new Error("fake timer runaway")
    }
    clock.now = target
  }

  async function flushMicrotasks(rounds = 40): Promise<void> {
    for (let round = 0; round < rounds; round += 1) await Promise.resolve()
  }

  const root = new FakeElement("div")
  const documentElement = new FakeElement("html")
  const localStorageData = new Map<string, string>()
  const fakeDocument = {
    createElement: (tagName: string): FakeElement => new FakeElement(tagName),
    createTextNode: (text: string): FakeElement => {
      const node = new FakeElement("#text")
      node.textContent = text
      return node
    },
    getElementById: (id: string): FakeElement | null => (id === "firstmate-root" ? root : null),
    // The panel looks the refresh control up by this selector on every update.
    querySelector: (selector: string): FakeElement | null => {
      if (selector !== "button.fm-refresh") return null
      return findFirst(
        root,
        (element) => element.tagName === "button" && element.className.split(/\s+/).includes("fm-refresh"),
      )
    },
    documentElement,
  }
  const fakeWindow = {
    setInterval: (handler: () => void, ms: number): number => schedule("interval", handler, ms),
    clearInterval: (id: number): void => void timers.delete(id),
    setTimeout: (handler: () => void, ms?: number): number => schedule("timeout", handler, ms ?? 0),
    clearTimeout: (id: number): void => void timers.delete(id),
    localStorage: {
      getItem: (key: string): string | null => localStorageData.get(key) ?? null,
      setItem: (key: string, value: string): void => void localStorageData.set(key, value),
    },
  }

  ;(globalThis as unknown as { document: unknown }).document = fakeDocument
  ;(globalThis as unknown as { window: unknown }).window = fakeWindow
  Date.now = () => clock.now

  return { root, documentElement, querySelector: fakeDocument.querySelector, advanceClock, flushMicrotasks }
}
