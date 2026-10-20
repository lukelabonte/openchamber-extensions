# FirstMate for OpenChamber

Each project gets its own first mate. It turns requests into workers in isolated worktrees, supervises them, and brings back findings, pull requests, and decisions.

## Getting started

Install the built `firstmate/` folder through OpenChamber's extension settings on OpenChamber 2.2.0 or later. Open a project, then open FirstMate and choose **Launch first mate**. Set its shipping mode in the home's `projects.md` before asking it to land work.

The panel includes task-specific decisions and answers, worker controls, suggestions, watches, retained watch notes, model settings, and template comparisons. A worker's session shows its own card and a note box for the first mate. Column order and folds stay with the browser.

A failed board refresh keeps the last usable cards with a stale-data notice. Older responses can't overwrite newer refreshes. Steer, Interrupt, Relaunch, and End still use server-side checks. Panel captain-message controls share an in-flight guard, and failed report requests show their error instead of silently claiming success. This isn't cross-window duplicate suppression.

Sending a suggestion removes only the original label and text, not a newer request with the same label. Suggestion and dismissal rewrites recheck concurrent edits with bounded retries. A successful send followed by a cleanup failure remains a successful send with a warning, not a request to resend. The final filesystem check/rename race remains.

## Handoffs and shortcuts

- `/fm <request>` sends the exact request to this project's first mate without asking the current session's model to execute it.
- `/fm-bearings` requests a status report. `/fm-bearings file` also saves it in the home.
- `/fm-open` opens the first mate's chat.
- Session actions offer Open FirstMate and FirstMate bearings. A user message can be handed to FirstMate from its action menu.

These are native extension commands, not installed OpenCode skills. OpenChamber keeps an existing command or skill with the same name. The action menu and terminal relay remain alternatives.

For a terminal handoff, run `node firstmate/scripts/tell.js --dir /path/to/project "Review the login changes"` from this repository. Add `--session <id>` to identify the claimed origin. `--stdin` reads exact UTF-8 text, including newlines, instead of positional words. Requests are limited to 12,000 UTF-8 bytes. `--help` doesn't access a host or read project records.

A handoff is a work request, not merge approval. The charter requires a durable captain-approval hold on work it starts or steers, even under `+yolo`. Hold interpretation and clearing remain agent responsibilities.

## Settings and lifecycle

The settings form stores coordinator and worker `provider/model` IDs, optional host model variants, and a board refresh interval from 5 to 3,600 seconds. Empty coordinator fields keep the host defaults. Empty worker fields leave selection to the first mate. Coordinator selection applies to new sessions. Worker defaults become instructions for subsequent dispatches; unavailable model/variant combinations still fail at the host.

Variant IDs aren't limited to standard reasoning names. Provider-specific IDs such as `provider:adaptive/extended` pass through unchanged. Empty coordinator variants show “OpenChamber default”; empty worker variants show “Leave it to the first mate.” Those labels aren't saved as variant IDs. Arbitrary provider session options aren't supported by the OpenChamber adapter.

**Adopt session** accepts an idle, unarchived session listed in this project's existing FirstMate home. **Release** forgets the coordinator without deleting its chat, workers, or worktrees. **Restart in fresh session** creates a new coordinator in the same home and reuses the backlog. The previous chat and existing workers remain intact. These operations refuse a busy or unknown coordinator.

Compact, same-thread context reset, pinning, multi-machine dispatch, and a guaranteed host parent-child fleet aren't exposed by this port. An unrelated session isn't claimed as a worker because its title happens to start with `[FM]`.

## Worker reads and message evidence

Once a worker is idle, its closing status line appears as **Worker reported**. A reported GitHub PR can appear before the first mate records it in the backlog. The backlog's PR takes precedence. These summaries and links are worker testimony, not verified readiness, and never mark a task Done or change coordinator-owned states. Previous closing reports aren't shown as current while the worker runs again or a poll fails.

Projects with multiple active workers use one bounded status-list request per supervision round. Omitted, unknown, ambiguous, or wrong-directory entries fall back to individual status reads. A partial list never means a worker was deleted or became idle. Worker messages and authoritative failure evidence still use separate reads.

Worker updates include a link to the exact observed message when the host returns a usable message ID. Cards also offer **Copy message link**. Paste the link in OpenChamber chat to navigate to that message. **Open session** still opens the whole conversation; the extension SDK doesn't expose a message-specific open action. These links use OpenChamber's message-link handler and may not work on older hosts. A link isn't proof that the worker's claim is correct.

The existing project-session subscription refreshes the board when parent or directory metadata changes, even if activity doesn't. The backlog still owns fleet membership. Moving a native parent doesn't silently adopt or drop a worker. There isn't an efficient single-message read in this adapter, so bounded history reads must match the requested message ID rather than substitute the latest reply.

These changes address the portable parts of [upstream issue #37](https://github.com/gpambrozio/bb-plugins/issues/37), including its October 15 follow-up. No bb SDK upgrade or bb-specific event/option flags are needed.

### Worker command visibility

**Show commands** uses OpenChamber's native shell API. It watches one selected backlog worker at a time and filters out sessions not owned by that card. Running and recently ended commands show their foreground/background mode and end status. **Read output** requests a bounded 16 KiB tail. Dropped output, unavailable logs, permission failures, and unknown endings stay explicit. This isn't complete or durable command history.

The extension now builds with SDK 2.5.0 and requests the `shells` capability, first shipped in host 2.2.0. OpenChamber must approve that permission when installing the update. The permission also allows stopping commands, but FirstMate only subscribes and reads; it never calls Stop. Command text and output stay in the panel's memory and aren't sent to the first mate or saved by this viewer. Closing the viewer or changing projects releases its subscription.

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
