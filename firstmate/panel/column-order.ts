import { boardColumnOrder, type BoardWorkerState } from "./board"

export function parseColumnOrder(value: unknown): BoardWorkerState[] {
  const order: BoardWorkerState[] = []
  if (Array.isArray(value)) {
    for (const state of value) {
      if (typeof state !== "string" || !boardColumnOrder.includes(state as BoardWorkerState)) continue
      if (!order.includes(state as BoardWorkerState)) order.push(state as BoardWorkerState)
    }
  }
  for (const state of boardColumnOrder) {
    if (!order.includes(state)) order.push(state)
  }
  return order
}

export function moveColumn(
  order: readonly BoardWorkerState[],
  state: BoardWorkerState,
  direction: "up" | "down",
): BoardWorkerState[] {
  const moved = [...order]
  const index = moved.indexOf(state)
  const neighborIndex = index + (direction === "up" ? -1 : 1)
  if (index < 0 || neighborIndex < 0 || neighborIndex >= moved.length) return moved
  moved[index] = moved[neighborIndex]
  moved[neighborIndex] = state
  return moved
}
