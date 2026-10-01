import { connectHost } from "@openchamber/sdk"
import { applyHostReady } from "@openchamber/sdk/ui"

const host = connectHost()

host.onReady((ctx) => {
  applyHostReady(ctx, document.documentElement)
  renderEmptyBoard()
})

function renderEmptyBoard(): void {
  const root = document.getElementById("firstmate-root")
  if (!root) return
  root.replaceChildren()
  const heading = document.createElement("h1")
  heading.textContent = "FirstMate"
  const emptyBoard = document.createElement("p")
  emptyBoard.textContent = "The board is empty."
  root.append(heading, emptyBoard)
}
