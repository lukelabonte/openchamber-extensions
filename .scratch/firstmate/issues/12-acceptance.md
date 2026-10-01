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
- [ ] If ticket 08 found no supported interrupt path: the report names the capability, the evidence, and the workaround state instead
