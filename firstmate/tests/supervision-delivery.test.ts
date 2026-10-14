import { expect, test } from "bun:test"
import { createSupervisionDelivery } from "../service/supervision-delivery"

const note = (slug: string, message: string) => ({ slug, message, coordinatorSessionId: `ses_${slug}`, homeDirectory: `/fm/projects/${slug}` })
const flush = async () => { for (let index = 0; index < 10; index++) await Promise.resolve() }

test("one busy first mate doesn't block another project's delivery or enqueue", async () => {
  let release: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve })
  const delivered: string[] = []
  const delivery = createSupervisionDelivery({
    deliver: async (notification) => {
      if (notification.slug === "busy") await blocked
      delivered.push(notification.message)
    },
    failed: () => {}, succeeded: () => {},
  })
  delivery.enqueue(note("busy", "first"))
  delivery.enqueue(note("ready", "other project"))
  delivery.enqueue(note("busy", "second"))
  await flush()
  expect(delivered).toEqual(["other project"])
  release!()
  await flush()
  expect(delivered).toEqual(["other project", "first", "second"])
})

test("pending supervision updates are bounded and drops are disclosed", async () => {
  let release: () => void
  const blocked = new Promise<void>((resolve) => { release = resolve })
  const delivered: string[] = []
  const delivery = createSupervisionDelivery({
    deliver: async (notification) => { if (notification.message === "first") await blocked; delivered.push(notification.message) },
    failed: () => {}, succeeded: () => {},
  })
  delivery.enqueue(note("busy", "first"))
  for (let index = 0; index < 30; index++) delivery.enqueue(note("busy", String(index)))
  release!()
  await flush()
  expect(delivered[1]).toContain("10 older supervision updates were coalesced")
  expect(delivered[1]).toContain("10")
})
