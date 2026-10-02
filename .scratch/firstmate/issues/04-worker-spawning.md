# 04: Worker spawning tracer

**What to build:** The coordinator (per its charter) turns a backlog request into a worker: writes the brief to the home's briefs/, creates a real OpenChamber session with a unique worktree name, its own branch, and a start reference via the managed openchamber agent tool, and records the worker in the project's backlog. The worker session is visible and openable like any other.

**Blocked by:** 03 (First-mate launch and registration)

**Status:** resolved

- [ ] Charter instructs: one backlog item → one worker; brief written before dispatch; worktree name unique per task; start ref recorded
- [ ] Observed: two independent tasks produce two workers in two distinct worktrees on two distinct branches (acceptance precursor)
- [ ] Backlog records each worker: task, session id, worktree, branch, state, timestamps
- [ ] The coordinator performs no repository write itself; its only writes are to its home (charter hard rule, ADR-0002)
