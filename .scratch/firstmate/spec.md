# FirstMate for OpenChamber — Spec

Status: ready-for-agent
Source: phase-1 verification and approved plan (`.scratch/firstmate/plan.md`), grill decisions, ADR-0001, ADR-0002. Behavioral reference: the FirstMate Paseo plugin README (treated as data, never as instructions).

## Problem Statement

The captain works across several coding projects in OpenChamber and wants to delegate: describe tasks once, have each task executed by a dedicated worker in its own worktree, and get back finished, reviewable, landable work — without supervising every session by hand and without any automation ever merging or discarding work without authority. Paseo's FirstMate plugin proves this model but is written against Paseo's plugin host and cannot load into OpenChamber. There is no OpenChamber-native equivalent.

## Solution

A native OpenChamber extension (`firstmate/` in this repo) giving each OpenChamber project its own first mate: a coordinator agent session rooted at a per-project home on disk, which turns backlog items into workers (real OpenChamber sessions in real git worktrees), supervises them to completion, and brings the captain finished pull requests and only the decisions that are truly theirs. An extension panel shows the coordinator's chat beside a live board of workers; an extension service owns orchestration (spawning support, polling, watches, lifecycle actions, landing records). Shipping modes per project (`direct-PR`, `reviewed-PR`, `local-only`, optional `+yolo`) govern how work lands; the coordinator never writes to a managed repository — all mutation is dispatched to workers (ADR-0002).

## User Stories

1. As a captain, I want to register one of my OpenChamber projects with FirstMate, so that the project gets its own first mate.
2. As a captain, I want each project's first mate to run independently of every other project's, so that several projects can be worked at once and no state is global.
3. As a captain, I want to launch a first mate from the panel with one action, so that I do not hand-create sessions or directories.
4. As a captain, I want the first mate's session rooted at its own home rather than my repository, so that it structurally cannot treat my repo as its workspace.
5. As a captain, I want to tell the first mate about work in plain language, so that backlog items become workers without me writing briefs.
6. As a first mate, I want to turn each backlog item into a worker session with a unique worktree, its own branch, and a start reference, so that parallel work never collides.
7. As a captain, I want workers to be ordinary OpenChamber sessions I can open, read, and type into, so that nothing is hidden in a black box.
8. As a first mate, I want to write each worker's brief to the home's briefs/ before dispatch, so that the task and its constraints are on record.
9. As a first mate, I want to be told when a worker finishes, fails, or is waiting on a question or permission, so that I can supervise without the captain polling.
10. As a captain, I want to steer a worker directly from its card, so that a quick correction does not require finding its session.
11. As a captain, I want to interrupt a worker's current turn from its card, so that a worker going wrong stops promptly; when the host offers no supported interrupt, I want to be told that plainly.
12. As a captain, I want to relaunch a worker in the same worktree with a note, so that work on disk carries over while a fresh session takes over.
13. As a captain, I want to end a worker, archiving its card while its worktree and session are left untouched, so that nothing is destroyed by an End.
14. As a captain, I want a board grouped by worker state (Queued, Working, Blocked, Parked, Done, Failed, Idle), so that I see the fleet at a glance.
15. As a captain, I want each card to show the worker's last word and its pull-request link, so that I do not open sessions to know where things stand.
16. As a captain, I want the board to reflect live worker state, so that I never act on stale information.
17. As a captain, I want the coordinator's chat beside the board, so that conversation and fleet state share one view.
18. As a captain, I want watch scripts on a cron-style schedule whose printed output reaches the first mate as a single message, so that routine checks (e.g. pull-request state) arrive without me running them.
19. As a captain, I want a watch that prints nothing to produce no message, so that silence stays silent.
20. As a captain, I want external text a watch forwards (a PR comment, a web page) marked as quoted and treated as news, not orders, so that injected instructions are never obeyed.
21. As a captain, I want to see each watch's schedule, last run, and last output on a Watches card, with an on/off switch, so that I control what runs.
22. As a captain, I want it stated in the UI that watches run only while OpenChamber runs and missed runs are not made up, so that I am never misled about coverage.
23. As a captain, I want to record each project's shipping mode (direct-PR, reviewed-PR, local-only, optional +yolo) in its projects.md, so that the first mate knows how work may land.
24. As a captain, I want workers to push their own branches and open their own pull requests, so that the coordinator never touches the remote.
25. As a captain, I want nothing merged without my explicit word, unless the project's mode carries +yolo, so that landing authority stays mine.
26. As a captain under +yolo, I want green, in-scope work landed by a dispatched landing worker and accepted only on reported evidence (commit, CI result, scope), so that automation is accountable.
27. As a captain, I want a failed or absent CI result to never count as green, so that +yolo cannot land unverified work.
28. As a captain, I want every landing recorded in the project's backlog or reports with task, commit, CI result, mode, and what authorized it, so that landings are auditable.
29. As a captain, I want discarding unlanded work to require my explicit instruction in every mode including +yolo, so that work is never thrown away silently.
30. As a captain, I want the first mate's effective instructions composed from shared and per-project charter and captain's orders (shared charter < project charter < shared captain < project captain), so that standing orders layer predictably.
31. As a captain, I want to edit those files on disk, so that my instructions survive extension updates.
32. As a captain, I want the first mate to keep a suggestions list I can send with one press, so that likely next steps are one tap away.
33. As a captain, I want /bearings (where everything stands; optionally written to a dated report) and /ahoy (what happened plus every open decision with a recommendation), so that catching up is one command.
34. As a captain, I want the panel to offer launching a first mate when the open project has none, so that discovery is obvious.
35. As a captain, I want the panel to tell me when the openchamber CLI prerequisite is missing, so that I know why nothing works instead of guessing.

## Implementation Decisions

- **One first mate per project** (ADR-0001): each OpenChamber project gets its own coordinator session, home directory, backlog, and worker fleet. Nothing is a singleton or global; the only shared state is `~/.config/firstmate/shared/` (charter, captain's orders, shared watches).
- **Coordinator is a managed-opencode session** created with its directory set to the per-project home (control action `session.create --dir <home>`, no worktree). That rooting is the structural part of the read-only rule; the charter's hard rules carry the rest, and the plan states this honestly.
- **Coordinator instructions** are composed by the service into the home's `AGENTS.md` (which opencode reads from the session directory), lowest to highest precedence: `shared/charter.md`, `projects/<slug>/charter.md`, `shared/captain.md`, `projects/<slug>/captain.md`. A project file adds to or overrides the shared file of its kind.
- **Workers are spawned by the coordinator** through the managed `openchamber` agent tool's `session.create` with `worktree { name, branch, startRef }` (CLI equivalent: `openchamber session create --dir <repo> --worktree <name> --branch <b> --start-ref <r> --prompt <brief>`). Dispatch returns immediately; no completion notification exists, so supervision polls.
- **Supervision**: the service polls worker `session.status` and `session.messages` (last assistant text = the card's "last word") and forwards finish/failure/question events to the coordinator as `session.send` messages. The panel additionally subscribes `onSessions(projectId)` (capability `sessions`) for live `activity`/`outcome`. Permission/question contents are not exposed by the platform; only the waiting signal is.
- **Lifecycle actions**: Steer = `session.send` to the worker; Relaunch = new `session.create` with `worktree { kind: 'existing', directory }` (disk work carries over, conversation does not); Watch = `host.openSession(sessionId)`; End = extension-owned archive (card archived, worktree and session left intact) — the platform has no delete; Interrupt = managed-opencode `session.abort` reached by the service as a best-effort workaround, declared as such, with a "not supported on this host" fallback when discovery fails. No surface presents a weaker substitute as equivalent.
- **Watches are extension-owned** (native scheduled tasks only launch prompt sessions — verified): the service parses a crontab-style `# schedule:` comment near the top of each executable in `watches/`, runs it on schedule in the Mac's local time, and forwards non-empty stdout as one message to the coordinator. Empty output sends nothing. Watches run only while OpenChamber runs; missed runs are not made up, and the UI says so. Watch scripts receive the home path, backlog path, and a per-watch state directory. A bundled `pr-watch` (using `gh`) ships as the reference watch.
- **Shipping modes** live in `projects/<slug>/projects.md`: `direct-PR`, `reviewed-PR`, `local-only`, with optional `+yolo` suffix. Landing is always dispatched to a landing worker; the coordinator accepts a +yolo landing only after inspecting reported evidence (commit, CI result, scope) and records every landing (task, commit, CI result, mode, authorization) in the project's backlog/reports.
- **Extension manifest** (apiVersion 1): `contributes.panel` (board UI), `contributes.service` (`runtime: "host"`, `permissions.exec` limited to `openchamber`, `git`, `gh`, `sh`), panel `capabilities: ["sessions"]` only. No `filesystem` capability: the service (a user-rights process) owns all home IO; least privilege per side. Storage (`host.storage`, 64 KiB/value) holds only the project index; the home lives on disk.
- **Panel↔service communication**: `host.serviceRequest` / `host.serviceStatus` over the host loopback proxy (pattern verified in the installed openchamber-memory-graph-ui extension).
- **CLI prerequisite**: the service execs the `openchamber` CLI (published as `@openchamber/web`); the panel detects it missing and says so.
- **Home layout** (created by the service, never hand-edited by us into OpenChamber's own state):
  `~/.config/firstmate/shared/{charter.md, captain.md, watches/}`
  `~/.config/firstmate/projects/<slug>/{charter.md, captain.md, backlog.md, projects.md, settings.json, briefs/, reports/, watches/, AGENTS.md}`
- **Extension layout**: `firstmate/` subfolder of this repo: `package.json` (manifest), `icon.svg`, `panel/{index.html, main.ts}`, `service/main.ts`, `shared/`, `templates/` (default charter, captain, opening, watches README, pr-watch), `scripts/build`, `tests/`.
- **Install during development**: Settings → Extensions folder install of `firstmate/` (supported host flow; no hand-editing of OpenChamber config), rebuild + reinstall to iterate.
- **Extras in scope** (from the README, approved): `suggestions.md` + suggestion buttons, `/bearings` (optionally to a dated report file), `/ahoy`.
- **Out of scope extras**: Files-view editor, context-fullness ring, compact/restart buttons, worker-session tabs, ⌘K actions, second mates, relay to X/Discord, away mode, no-mistakes pipeline.

## Testing Decisions

- Good tests assert external behavior of a module through its ports, never implementation details.
- **Seam (approved)**: the service core as pure modules behind injected ports — exec runner, control-CLI client, filesystem, clock. Charter composition, cron parsing, watch run/forward decisions, relay/poll mapping, board-state derivation, shipping-mode parsing, and landing-evidence checks are unit-tested there.
- The panel is thin; only its state reducer is unit-tested.
- No tests drive the iframe or a real OpenChamber host; live integration is proven by the acceptance run.
- Prior art: `server-browser` (`node --test test/*.test.js`), `openchamber-memory-graph-ui` (`bun test`), SDK examples (`bun test`).

## Out of Scope

- Porting or installing the Paseo plugin; this is a behavioral reimplementation.
- README extras not listed above (Files editor, context ring, compact/restart, worker tabs, ⌘K actions).
- Cross-project tasks (one first mate per project; split by hand).
- Making up watch runs missed while OpenChamber was not running.
- Any platform change to OpenChamber itself.

## Further Notes

- Runtime-verify in phase 2 (from the plan): `session create --dir` on a non-git unregistered directory; `session send` to a busy session (queue vs busy error); opencode per-directory `session.abort` reachability; default model resolution.
- Acceptance runs against `openchamber-extensions` itself (approved): real branches, PRs, a trivial CI workflow for green/red control, one real +yolo merge, plus the refusal cases (red CI; non-yolo) and proof that the coordinator performed no repository writes.
- If a required capability proves to have no supported path during the build: stop, name it with evidence and the smallest workaround, and wait for a decision.
