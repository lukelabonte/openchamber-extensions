# 12: Acceptance run

**What to build:** The observed-evidence proof, run against openchamber-extensions as the managed project: register it, launch its first mate, and demonstrate every required behavior with observed output. A trivial CI workflow is added to the managed repo first so green/red is controllable.

**Blocked by:** 07 (Card actions), 08 (Interrupt), 09 (Watches), 10 (Shipping modes), 11 (Extras)

**Status:** ready-for-agent

- [x] Two independent tasks produce two workers in two distinct worktrees on two distinct branches
- [ ] The coordinator receives a completion, a failure, and a question from workers
- [x] The board reflects live worker state; each card action (Watch, Steer, Interrupt, Relaunch, End) reaches its worker
- [x] A watch script fires and its output arrives as one coordinator message
- [x] +yolo project, green CI, in-scope change: lands through a dispatched landing worker; landing recorded with commit, CI result, mode, authorization
- [x] Same +yolo project, red CI: refuses to land
- [x] Non-yolo project, green CI: refuses to land and asks for the captain's word
- [x] Proof the coordinator performed no repository write at any point; all its writes confined to its home
- [ ] Runtime-verify: the poller's `session status --dir <projectDirectory>` resolves worker sessions that live in worktrees of the project; if the control service scopes by exact directory only, switch the poller to the worker's worktree directory
- [x] If ticket 08 found no supported interrupt path: the report names the capability, the evidence, and the workaround state instead

### Recovery checkpoint, 2026-10-01

Status is still **blocked** overall: runtime diagnosis found write/edit effects lagging 2m51s to 5m8s inside the bundled opencode v2.0.21 server, with the internal cause unresolved. Validation observed so far is green: the focused 90-pass / 0-fail run, the full suite (`bun test --timeout 60000 tests/`: 308 pass, 0 fail, 776 expects, 35 files, 79.72s), and the build (`sh scripts/build`) all exited 0. Code fixes for landing warnings, duplicate-label 409s, per-project busy guards, send-success-with-warning, and panel action feedback are uncommitted edits in the tree. The full report is at [`recovery-report.html`](../recovery-report.html). The checkboxes above stay unchecked and this ticket stays `ready-for-agent`; nothing in this recovery counts as acceptance evidence.

### Acceptance checkpoint, 2026-10-02

Status: **run complete** — 12 of 13 matrix items observed PASS against openchamber-extensions (fresh coordinator `ses_f048e32ec…`; PRs #1–#4; evidence in [`acceptance-evidence.md`](../acceptance-evidence.md)). Two items carry qualifications: the question event stayed BLOCKED (worker `question` tool stuck `executed:false` — the known upstream opencode tool-execution defect; poller reads the session as `busy`, so no `waiting-question` event fired and the board never showed Blocked(question)), and poller notifications were PARTIAL (board display and worktree resolution correct; the landing worker's completion and the waiting-question event both needed nudges). PR #2 (CODEOWNERS, green) awaits the captain's word; PR #4 (red probe) left open. Mode restored to direct-PR. Landed worktrees/branches (README, land-pr1, probe-yolo-green-land, land-probe3) await the captain-run cleanup runbook.
