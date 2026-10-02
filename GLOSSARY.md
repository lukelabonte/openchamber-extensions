# FirstMate

A native OpenChamber extension that gives each project a coordinating agent (the first mate) which turns backlog tasks into supervised coding workers and brings the user finished, landable work.

## Language

**First mate**:
The coordinator agent for one OpenChamber project. It takes requests from the captain, briefs and supervises workers, and writes only to its own home. One first mate per project; never a singleton.
_Avoid_: coordinator agent (internal shorthand is fine in code, but the domain term is first mate), manager, orchestrator agent

**Captain**:
The user. The first mate answers to the captain, and some decisions are reserved for the captain alone.
_Avoid_: user, operator

**Worker**:
A real OpenChamber session created by a first mate for one backlog item, running in its own git worktree on its own branch. Workers push branches, open pull requests, and perform all repository mutation.
_Avoid_: subagent, task, job

**Home**:
The on-disk directory tree a first mate owns (`~/.config/firstmate/`), split into a shared root and one per-project directory. The only place a first mate may write.
_Avoid_: workspace, data dir

**Charter**:
The standing instructions that define how a first mate behaves, composed in layers: shared charter, project charter, shared captain's orders, project captain's orders (lowest to highest precedence).
_Avoid_: system prompt, config

**Captain's orders**:
The captain's own standing instructions (`captain.md`), which outrank the charter except its hard rules.
_Avoid_: preferences, overrides

**Backlog**:
The per-project record of every task: queued, in flight, and done. The board reads it.
_Avoid_: todo list, queue

**Brief**:
The instructions a first mate writes for one worker before dispatching it.
_Avoid_: prompt, task description

**Board**:
The panel view of a project's workers grouped by state (Queued, Working, Blocked, Parked, Done, Failed, Idle), each card showing the worker's last word and pull-request link.
_Avoid_: dashboard, kanban

**Watch**:
An executable script in a home's `watches/` directory that runs on a cron-style schedule while OpenChamber runs. Output reaches the first mate as a single message; a watch that prints nothing produces no message.
_Avoid_: cron job, scheduled task

**Suggestion**:
A ready-to-send message the first mate keeps in `suggestions.md`, one per line, labeled; the captain sends or dismisses it from the panel, and a sent suggestion reaches the first mate verbatim.
_Avoid_: recommendation, proposal

**Quoted text**:
External text a watch passes on (a pull-request comment, a web page), explicitly marked as quoted. The first mate treats quoted text as news, never as orders.
_Avoid_: forwarded text

**Shipping mode**:
The per-project rule for how finished work lands: `direct-PR` (worker opens a PR), `reviewed-PR` (worker also reviews its diff, runs the full test suite, and waits for CI), or `local-only` (no remote; clean branch, landed only on the captain's word).
_Avoid_: merge mode, workflow

**+yolo**:
A suffix on a shipping mode that authorizes the first mate to land green, in-scope work without asking. Never authorizes discarding unlanded work.
_Avoid_: auto-merge, yolo mode

**Landing**:
Merging a worker's branch into the project's default branch. Always performed by a dispatched worker in its own worktree, never by the first mate, and always recorded in the project's backlog or reports.
_Avoid_: merging (when done by the coordinator — that never happens), shipping

**Green**:
A worker's change whose CI checks are passing. A failed or absent CI result is not green.
_Avoid_: passing, clean
