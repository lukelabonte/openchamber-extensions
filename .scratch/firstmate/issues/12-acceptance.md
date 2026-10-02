# 12: Acceptance run

**What to build:** The observed-evidence proof, run against openchamber-extensions as the managed project: register it, launch its first mate, and demonstrate every required behavior with observed output. A trivial CI workflow is added to the managed repo first so green/red is controllable.

**Blocked by:** 07 (Card actions), 08 (Interrupt), 09 (Watches), 10 (Shipping modes), 11 (Extras)

**Status:** ready-for-agent

- [ ] Two independent tasks produce two workers in two distinct worktrees on two distinct branches
- [ ] The coordinator receives a completion, a failure, and a question from workers
- [ ] The board reflects live worker state; each card action (Watch, Steer, Interrupt, Relaunch, End) reaches its worker
- [ ] A watch script fires and its output arrives as one coordinator message
- [ ] +yolo project, green CI, in-scope change: lands through a dispatched landing worker; landing recorded with commit, CI result, mode, authorization
- [ ] Same +yolo project, red CI: refuses to land
- [ ] Non-yolo project, green CI: refuses to land and asks for the captain's word
- [ ] Proof the coordinator performed no repository write at any point; all its writes confined to its home
- [ ] Runtime-verify: the poller's `session status --dir <projectDirectory>` resolves worker sessions that live in worktrees of the project; if the control service scopes by exact directory only, switch the poller to the worker's worktree directory
- [ ] If ticket 08 found no supported interrupt path: the report names the capability, the evidence, and the workaround state instead

### Recovery checkpoint, 2026-10-01

Status is still **blocked** overall: runtime diagnosis found write/edit effects lagging 2m51s to 5m8s inside the bundled opencode v2.0.21 server, with the internal cause unresolved. Validation observed so far is green: the focused 90-pass / 0-fail run, the full suite (`bun test --timeout 60000 tests/`: 308 pass, 0 fail, 776 expects, 35 files, 79.72s), and the build (`sh scripts/build`) all exited 0. Code fixes for landing warnings, duplicate-label 409s, per-project busy guards, send-success-with-warning, and panel action feedback are uncommitted edits in the tree. The full report is at [`recovery-report.html`](../recovery-report.html). The checkboxes above stay unchecked and this ticket stays `ready-for-agent`; nothing in this recovery counts as acceptance evidence.
