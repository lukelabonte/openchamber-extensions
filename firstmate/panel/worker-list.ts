import type { BoardCard } from "./board"
import type { Board } from "./state"

function isActive(worker: BoardCard): boolean {
  return worker.state === "Queued" || worker.state === "Working" || worker.state === "Blocked" || worker.state === "Idle"
}

/** Fleet membership comes only from the backlog, not titles or native parent IDs. */
export function createWorkerList(openSession: (sessionId: string) => Promise<void>) {
  let expanded = false
  let navigationGeneration = 0
  let feedback = ""
  let feedbackElement: HTMLElement | null = null

  function showFeedback(message: string): void {
    feedback = message
    if (feedbackElement !== null) feedbackElement.textContent = message
  }

  async function openWorker(sessionId: string): Promise<void> {
    const generation = ++navigationGeneration
    showFeedback("")
    try {
      await openSession(sessionId)
    } catch {
      if (generation === navigationGeneration) showFeedback("Could not open the worker session. Try again.")
    }
  }

  return {
    reset(): void {
      expanded = false
      navigationGeneration += 1
      feedback = ""
      feedbackElement = null
    },

    render(board: Board, currentSessionId: string | null): HTMLElement {
      const section = document.createElement("section")
      section.className = "fm-worker-picker"
      const toggle = document.createElement("button")
      toggle.type = "button"
      toggle.className = "fm-button"
      section.append(toggle)
      if (board.kind !== "ready") {
        toggle.textContent = board.kind === "loading" ? "Workers loading…" : "Workers unavailable"
        toggle.disabled = true
        if (board.kind === "error") toggle.title = board.message
        feedbackElement = null
        return section
      }

      const seen = new Set<string>()
      // Prefer unfinished work when several backlog tasks share one session.
      const workers = board.columns.flatMap((column) => column.cards)
        .sort((left, right) => Number(isActive(right)) - Number(isActive(left)))
        .filter((worker) => {
          if (worker.kind === "captain" || worker.sessionId === undefined || worker.sessionId.trim() === "" || seen.has(worker.sessionId)) return false
          seen.add(worker.sessionId)
          return true
        })
      const count = workers.filter(isActive).length
      toggle.textContent = `${count} active ${count === 1 ? "worker" : "workers"}${board.refreshError === undefined ? "" : " (stale)"}`
      toggle.title = "Unfinished worker sessions, including idle and blocked workers. Parked, done and failed workers are listed but not counted."
      toggle.setAttribute("aria-expanded", String(expanded))
      toggle.setAttribute("aria-controls", "fm-worker-list")
      const content = document.createElement("div")
      content.id = "fm-worker-list"
      content.hidden = !expanded
      toggle.addEventListener("click", () => {
        expanded = !expanded
        toggle.setAttribute("aria-expanded", String(expanded))
        content.hidden = !expanded
      })
      const caption = document.createElement("p")
      caption.className = "fm-caption"
      caption.textContent = "All tracked worker sessions. Select a row to open its chat."
      content.append(caption)
      if (board.refreshError !== undefined || board.warning !== undefined) {
        const warning = document.createElement("p")
        warning.className = "fm-worker-list-warning"
        warning.textContent = [board.refreshError === undefined ? undefined : `Showing the last successful read. ${board.refreshError}`, board.warning].filter(Boolean).join(" ")
        content.append(warning)
      }
      const list = document.createElement("ul")
      list.className = "fm-worker-links"
      for (const worker of workers) {
        const item = document.createElement("li")
        const row = document.createElement("button")
        row.type = "button"
        row.className = "fm-button fm-worker-link"
        if (worker.sessionId === currentSessionId) row.setAttribute("aria-current", "true")
        const title = document.createElement("span")
        title.className = "fm-worker-link-title"
        title.textContent = worker.title
        const status = document.createElement("span")
        status.className = "fm-worker-link-state"
        status.textContent = worker.state
        row.append(title, status)
        row.addEventListener("click", () => { void openWorker(worker.sessionId!) })
        item.append(row)
        list.append(item)
      }
      content.append(list)
      if (workers.length === 0) {
        const empty = document.createElement("p")
        empty.textContent = "No worker sessions yet."
        content.append(empty)
      }
      feedbackElement = document.createElement("p")
      feedbackElement.className = "fm-worker-list-warning"
      feedbackElement.setAttribute("role", "status")
      feedbackElement.textContent = feedback
      content.append(feedbackElement)
      section.append(content)
      return section
    },
  }
}
