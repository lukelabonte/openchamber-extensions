# FirstMate for OpenChamber

Each project gets its own first mate. It turns requests into workers in isolated worktrees, supervises them, and brings back findings, pull requests, and decisions.

## Getting started

Install the built `firstmate/` folder through OpenChamber's extension settings. Open a project, then open FirstMate and choose **Launch first mate**. Set its shipping mode in the home's `projects.md` before asking it to land work.

The panel includes task-specific decisions and answers, worker controls, suggestions, watches, retained watch notes, model settings, and template comparisons. A worker's session shows its own card and a note box for the first mate. Column order and folds stay with the browser.

## Handoffs and shortcuts

- `/fm <request>` sends the exact request to this project's first mate without asking the current session's model to execute it.
- `/fm-bearings` requests a status report. `/fm-bearings file` also saves it in the home.
- `/fm-open` opens the first mate's chat.
- Session actions offer Open FirstMate and FirstMate bearings. A user message can be handed to FirstMate from its action menu.

These are native extension commands, not installed OpenCode skills. OpenChamber keeps an existing command or skill with the same name. The action menu and terminal relay remain alternatives.

For a terminal handoff, run `node firstmate/scripts/tell.js --dir /path/to/project "Review the login changes"` from this repository. Add `--session <id>` to identify the claimed origin. `--stdin` reads exact UTF-8 text, including newlines, instead of positional words. Requests are limited to 12,000 UTF-8 bytes. `--help` doesn't access a host or read project records.

A handoff is a work request, not merge approval. The charter requires a durable captain-approval hold on work it starts or steers, even under `+yolo`. Hold interpretation and clearing remain agent responsibilities.

## Settings and lifecycle

The settings form stores coordinator and worker `provider/model` IDs, optional host model variants, and a board refresh interval from 5 to 3,600 seconds. Empty model and variant fields keep the host defaults. Coordinator selection applies to new sessions. Worker defaults become instructions for subsequent dispatches; unavailable model/variant combinations still fail at the host.

**Adopt session** accepts an idle, unarchived session listed in this project's existing FirstMate home. **Release** forgets the coordinator without deleting its chat, workers, or worktrees. **Restart in fresh session** creates a new coordinator in the same home and reuses the backlog. The previous chat and existing workers remain intact. These operations refuse a busy or unknown coordinator.

Compact, same-thread context reset, pinning, multi-machine dispatch, and a guaranteed host parent-child fleet aren't exposed by this port. An unrelated session isn't claimed as a worker because its title happens to start with `[FM]`.

## Durable watches and upgrades

Watch outcomes, failure suppression, pending output, and delivered notes persist in each project's `watch-runner.json`. Up to 20 pending notes wait for a verified idle first mate. Delivery batches are bounded, and overflow drops the oldest notes with a count. The latest 50 delivered notes appear in the panel. Empty successful runs send nothing. A crash after host acceptance but before local acknowledgement can still duplicate a delivery.

The PR watch covers active backlog PR links, including other repositories, plus the project's first 50 repository PRs. It reports review/comment excerpts, merge/close/reopen events, and CI red/green transitions. First sightings establish a silent baseline. The old TSV baseline isn't migrated.

Untouched shared charters and bundled PR watches upgrade automatically. Customized copies stay intact. A new default appears beside an outdated copy as `<path>.new`; the panel can display it and acknowledge that version. Acknowledgement doesn't replace personal wording. Provenance lives in `<path>.template.json`. Concurrent editor changes are checked again before writes, but the filesystem port doesn't provide a final compare-and-swap guarantee.

Captain's orders, project charters, openings, backlog records, reports, and learnings remain captain-owned or first-mate-owned records. Existing backlog entries still parse without the new fields. New entries can add stable IDs, task kinds, dependencies, holds, reviewed heads, and answer actions. See `templates/backlog.md` for the format.

## Preserved boundaries

There is one first mate per project. Repository writes and landings always go through workers. End archives a board card only, preserving its session and worktree. Cleanup remains the captain's job. The exact-reviewed-head landing protocol and recovery ladder live in the charter; they aren't automatic merge or repair controllers.

The existing permission auto-accept workaround remains unchanged. It can approve all worker permission requests, so the charter's scope and escalation rules aren't a permission classifier. Quoted watch output is information, not authority.

## Development

Run `bun install --frozen-lockfile`, `bun test`, and `bun run build` from `firstmate/`. The build typechecks and bundles the panel, background commands, service, and terminal relay. Installation of an update can require approval for its contributed actions and the Node command used by the PR watch. Live-host behavior needs a separate acceptance run.

The port references `gpambrozio/bb-plugins/firstmate-crew` at commit `f2d8491208978f13a245f46a34cc195338173c0e`. See `THIRD-PARTY-NOTICES.md` for the adapted PR watch's license.
