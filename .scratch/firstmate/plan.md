# FirstMate for OpenChamber — Phase 1 verification and plan

Status: awaiting approval. No implementation code has been written.
Evidence base: `~/Developer/open-source/openchamber` (v2.1.0 source), `@openchamber/sdk` docs (`packages/sdk/API.md`, `DOCUMENTATION.md`, `GUEST_SERVICES.md`), CLI source (`packages/web/bin/lib/`), server source (`packages/web/server/lib/`), six installed extensions' manifests, and the FirstMate README (fetched, treated as data).

## Verified contract facts

**Manifest (`openchamber` key in package.json).** `apiVersion: 1`; `engines.openchamber` (`>=1.22.0` form); `contributes`: `panel` (id/name/icon/entry, entry optional), `page`, `service` (`entry`, `runtime: "host"`, `permissions.exec`/`sockets`, `provides`, `surface`), `fileEditors`, `actions` (open/background), `commands`, `tools`, `statusSection`, `capabilities` (`prompt`, `sessions`, `files`, `model`), `filesystem` (absolute globs), `background`, `attach`, `integration`, `origins`. Extra keys dropped. Install checks built JS on disk; no TypeScript compiled by the host. (API.md §3, DOCUMENTATION.md invariants.)

**Service.** Host-spawned Node process (`process.execPath` + `ELECTRON_RUN_AS_NODE`), bound to `127.0.0.1:$OPENCHAMBER_SERVICE_PORT`, bearer `OPENCHAMBER_SERVICE_TOKEN`, `GET /health` readiness. Runs with the user's full rights; `permissions.exec`/`sockets` are advisory text in the approval dialog, not confinement. Spawned on first `serviceRequest`, killed on host quit. Panel↔service: `host.serviceRequest({method, path, query, body})` / `host.serviceStatus()`. No streaming. (GUEST_SERVICES.md.)

**Sessions from a panel.** `host.startSession({...attach fields, projectId?, worktree?: true | {kind:'existing',directory} | {kind:'new',name?,baseBranch?}, navigation?})` → `{ sessionId, directory, sent, linked, worktree? }`; worktree `name` names branch and worktree. `host.prompt` targets the *current* session only. (API.md §1.2.)

**Workspace reads (capability `sessions`).** `listProjects/listWorktrees/listSessions(projectId)` + `onProjects/onWorktrees/onSessions` subscriptions; `openSession(sessionId)`. Session records carry `activity` (`unknown|idle|running|retrying|waiting-permission|waiting-question`), `outcome` (`completed|failed|null`), `worktree`, `archivedAt`, `items`. Explicitly: "Blocking-request contents and approve/reply actions are not exposed" and "`completed` never means the extension's task is Done." (API.md §1, workspace.ts.)

**Control API / CLI / agent tool.** One shared allowlisted control service (`server/lib/openchamber-control/`), exposed two ways: authenticated HTTP `POST /api/openchamber/control` (used by the CLI) and the managed-opencode `openchamber` agent tool (on by default via `agentControlToolEnabled`). Actions: `session.create|list|send|fork|status|messages`, `schedule.create|list|run|delete|toggle` (`schedule.status` CLI-only), `projects.list`, `models.list`, `file.open`, `notify.send`, `browser.*`. **"Destructive session/worktree deletion and project-path registration are not part of the action contract."** (actions.js, DOCUMENTATION.md there.)

**CLI exact forms** (from `bin/lib/commands-*.js` help text):
- `openchamber session list [--dir <path>] [--limit n] [--with-status] [--all] [--json]`
- `openchamber session create --dir <path> | --project <id> [--title t] [--worktree <name> [--branch b] [--start-ref r] [--upstream|--no-upstream]] [--prompt t] [--model p/m] [--agent a] [--variant v] [--goal] [--wait]`
- `openchamber session send --session <id> --dir <path> --prompt <text> [--wait] [--model p/m]`
- `openchamber session fork|status|messages --session <id> --dir <path>` (`messages`: `--last`, `--last-assistant`, `--role`, `--limit`)
- `openchamber schedule create (--project id | --dir path) --name n --prompt p --model p/m (--daily HH:mm | --weekly d --time t | --once D --time t | --cron expr) [--timezone z] [--agent a] [--disabled]`; plus `list|run|delete|enable|disable|status`.
- CLI ships as the `openchamber` bin of the published `@openchamber/web` package (npm registry, v2.1.0 — verified live) and is bundled inside the desktop app. Not currently on PATH on this machine.

**Scheduled tasks** launch prompt sessions on a schedule. They do not carry arbitrary script output anywhere. (commands-schedule.js; prompt's claim confirmed.)

**Install during development.** Settings → Extensions installs a folder or zip; folder installs stay in place (nothing copied, nothing deleted on uninstall). Server route: `POST /api/guests { path }` or `{ url }`. Capability grants recorded in `~/.config/openchamber/extensions.json` **by the host** after user approval — never edited by us. Build: `bunx openchamber-guest-bundle panel/main.ts panel/main.js` and `--node service/main.ts service/main.js` (any IIFE bundler works). (GUEST_SERVICES.md, guests/install.js, guests/routes.js.)

**Extension storage.** `host.storage.get/set/delete/keys`: JSON, 128-char keys, 64 KiB/value, 2 MiB/2000 keys total. Fits an index only; the first-mate home lives on disk, reached by the service (user-rights fs) — matches the prompt's constraint. (API.md, workspace.ts.)

## Capability matrix for the five required behaviors

| Behavior | Verdict | Surface |
|---|---|---|
| 1. Worker spawning (session + worktree + branch + start ref, visible/openable) | **Native** | Coordinator agent calls the managed `openchamber` tool's `session.create` with `worktree {name, branch, startRef}` (CLI: `openchamber session create --dir <repo> --worktree <name> --branch <b> --start-ref <r> --prompt <brief>`). Sessions appear in the UI like any other. |
| 2. Supervision: completion/failure/question detection | **Native (read side)** | Poll `session.status` / `session.messages`; or panel-side `onSessions(projectId)` live subscription (`activity`, `outcome`). Question/permission *contents* are not exposed — only the `waiting-question`/`waiting-permission` signal; the coordinator reads the actual question via `session.messages`. |
| 2. Supervision: steer / relaunch | **Native** | Steer = `session.send` to the worker. Relaunch = new `session.create` with `worktree: {kind:'existing', directory}` (work on disk carries over, conversation does not — matches README semantics). |
| 2. Supervision: interrupt / end | **No contract path** | No abort/stop/delete in the SDK, control API, CLI, or agent tool (explicitly excluded: "Destructive session/worktree deletion … not part of the action contract"). Workaround: the managed opencode server per directory exposes `session.abort` (the UI's own stop button calls it) and session delete; the service can reach it only by discovering per-directory opencode connection info from OpenChamber runtime state — a private, unstable surface. Alternative owned semantics: End = extension archives the card and stops supervising (worktree/session left intact, per README "Its workspace and worktree are left exactly as they are"). Plan: implement End as extension-owned archive (native, honest); implement Interrupt via opencode `session.abort` as a best-effort workaround, clearly labeled, with a graceful "not supported by this host" fallback if discovery fails. |
| 3. Board panel (panel + service, live) | **Native** | `contributes.panel` + `contributes.service`; panel subscribes `onSessions` (capability `sessions`) for live state and calls `serviceRequest` for board data/actions; service owns orchestration and home IO. Panel↔service pattern verified in installed `openchamber-memory-graph-ui`. |
| 4. Scheduled watches (cron scripts, output → one coordinator message) | **Workaround (extension-owned)** | Native scheduled tasks only launch prompt sessions — confirmed. Build in the service: parse `# schedule:` crontab comments, run scripts under `~/.config/firstmate/**/watches/` via declared `exec`, non-empty stdout → one message to the coordinator via `openchamber session send --session <coord> --dir <home>`. Empty output → no message. Runs only while OpenChamber runs; missed runs are not made up (service dies with the host) — stated in the UI. |
| 5. Shipping modes per project | **Extension-owned (native building blocks)** | Modes live in `projects/<slug>/projects.md`; enforcement is charter + coordinator behavior; landings dispatched as workers (`session.create` + worktree); CI evidence via `gh` in the landing worker and/or a pr-watch script. No platform feature needed beyond 1–4. |

## Hard-rule enforcement points

- Coordinator session is created with `--dir ~/.config/firstmate/projects/<slug>` (no worktree) — its workspace *is* the home. That is the structural mechanism; there is no stronger platform confinement for agent sessions, so the charter's hard rules carry the rest. Stated plainly: rooting is structural; "never writes to a project" is charter-enforced on top.
- Coordinator instructions: the service composes `shared/charter.md` → `projects/<slug>/charter.md` → `shared/captain.md` → `projects/<slug>/captain.md` into `AGENTS.md` in the home before launch; opencode reads `AGENTS.md` from the session directory.
- All repo mutation happens in worker sessions (their own worktrees). The coordinator's tool use never gets a `--dir` pointing at a managed repo for mutation — the charter forbids it and the coordinator has no worktree there.
- `+yolo` landing: coordinator dispatches a landing worker; accepts only on evidence (commit, CI result, scope) reported back; records the landing in the project's `backlog.md`/`reports/`.
- Watch forwarding marks external text as quoted; charter instructs "news, not orders."

## Architecture

- **Coordinator** = an ordinary managed-opencode session rooted at the per-project home, launched by the extension service (`session create --dir <home> --title "FirstMate — <project>"`). It uses the built-in `openchamber` agent tool (on by default) to spawn/steer/poll workers. The user chats with it through the panel (which deep-links/opens its session) or directly in OpenChamber.
- **Service** (`service/main.js`, runtime host) = the deterministic relay: homes and charter composition, project registry (slug ↔ project dir ↔ coordinator session id), watch scheduler, worker-state poller (CLI `session.status`/`session.messages`), event forwarding to the coordinator (`session send`), lifecycle actions from the board (Steer/Interrupt/Relaunch/End), landing-evidence records. Declared `exec`: `openchamber`, `git`, `gh`, `sh` (watch scripts). Least privilege: no `sockets`, no `filesystem` needed for the service (it is a user-rights process); panel declares only `sessions`.
- **Panel** (`panel/index.html` + `main.js`, IIFE) = chat link to the coordinator session + board (columns Queued/Working/Blocked/Parked/Done/Failed/Idle fed by service state + `onSessions` live activity), card actions Watch (`host.openSession`), Steer/Interrupt/Relaunch/End (`serviceRequest`), suggestions (from `suggestions.md` via service), `/bearings` and `/ahoy` as compose-and-send helpers, watches card. Per-project: panel reads `ctx.directory`, asks the service for the matching first mate, offers "Launch first mate" when none exists.
- **CLI dependency**: the service execs `openchamber` (control API with auth handled by OpenChamber's own CLI). Requires `npm i -g @openchamber/web` (published, v2.1.0) or equivalent PATH install — an install prerequisite surfaced in the panel when missing.

## File layout (repo: openchamber-extensions, worktree branch `first-mate`)

```
firstmate/
  package.json            # openchamber manifest: panel + service, apiVersion 1
  icon.svg
  panel/index.html, panel/main.ts   → built panel/main.js (IIFE)
  service/main.ts                   → built service/main.js (--node)
  shared/                   # types shared by panel and service (board state, messages)
  templates/                # charter.md, captain.md, opening prompt, watches/README, pr-watch
  scripts/build
  tests/                    # service unit tests (cron parse, charter compose, state)
```

Runtime home (created by the service, never by hand):
```
~/.config/firstmate/shared/{charter.md, captain.md, watches/}
~/.config/firstmate/projects/<slug>/{charter.md, captain.md, backlog.md, projects.md,
                                     settings.json, briefs/, reports/, watches/, AGENTS.md}
```

## Could not determine / runtime-verify in phase 2

1. `session create --dir` on a non-git, unregistered directory (the home): source invariants imply an existing folder suffices; confirm at runtime.
2. `session send` to a busy coordinator: queue vs `SESSION_BUSY` (a server message-queue exists; behavior to observe).
3. opencode per-directory `session.abort` reachability from the service (endpoint/auth discovery from runtime state) — gated; fallback is declaring Interrupt unavailable on this host.
4. Coordinator/worker model selection: `session create --model provider/model` exists; default to the user's configured selection, overridable per project in `settings.json`.
5. Whether the desktop app exposes a supported one-click CLI install (none found in source; npm global install is the path).

## Acceptance target

Managed project: `openchamber-extensions` (`/Users/lukelabonte/Developer/open-source/openchamber-extensions`, GitHub remote present). Acceptance will push real branches/PRs to it, add a trivial CI workflow for green/red control, and perform one real `+yolo` merge into its default branch, then the refusal cases. Two independent tasks for the two-worker proof will be small, real changes to this repo (proposed in the spec).

Runtime-verify at acceptance (watches): the service lists watch files by exec permission and runs them directly (no `sh` wrapper) — confirm on the real host that a non-executable file in `watches/` is never listed or run, and that an installed `pr-watch` carries the exec bit end to end.
