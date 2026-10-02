# 07: Card actions — Watch, Steer, Relaunch, End

**What to build:** Each worker card carries four working actions. Watch opens the worker's session in OpenChamber. Steer sends the captain's word straight to the worker and tells the coordinator what was said and what the worker answered. Relaunch asks the coordinator for a fresh worker in the same worktree with the captain's note; work on disk carries over, the conversation does not. End archives the card; the worktree and session are left exactly as they are.

**Blocked by:** 06 (Live board panel)

**Status:** resolved

- [ ] Watch calls `openSession` on the worker's session
- [ ] Steer delivers a message to the worker session and forwards the exchange to the coordinator
- [ ] Relaunch creates a fresh session against the existing worktree (`kind: 'existing'`) with the note; old card superseded
- [ ] End archives the card in extension state only; no session or worktree deletion is attempted
- [ ] Every action is observable reaching its worker (acceptance precursor)
