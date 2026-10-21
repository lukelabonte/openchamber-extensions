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

The settings form stores coordinator and worker `provider/model` IDs, optional host model variants, and a board refresh interval from 5 to 3,600 seconds. Empty coordinator fields keep the host defaults. Coordinator selection applies to new first mate sessions.

For workers, each empty field requires the first mate to choose an explicit value before creating, resuming, steering, or relaunching a worker. The first mate checks available models and supported effort variants, then passes both values on the create or send action. It reassesses the next work and can choose a stronger model or higher effort for difficult work, or a smaller model or lower effort for routine work. Each captain-set field stays fixed unless the captain explicitly changes it. Selections and reasons go in the brief or report. An unsupported or unverifiable pair stops dispatch or resume instead of falling back to host defaults.

These rules are composed instructions for the first mate, not a service-level enforcement gate. They also appear when the shared charter has local edits. The board's direct Steer action still relays the captain's message to the worker without selecting a model. The first mate's own resumed sends follow the selection rules.

Variant IDs aren't limited to standard reasoning names. Provider-specific IDs such as `provider:adaptive/extended` pass through unchanged. Empty coordinator variants show “OpenChamber default”; empty worker variants show “Leave it to the first mate.” Those labels aren't saved as variant IDs. Arbitrary provider session options aren't supported by the OpenChamber adapter.

**Adopt session** accepts an idle, unarchived session listed in this project's existing FirstMate home. **Release** forgets the coordinator without deleting its chat, workers, or worktrees. **Restart in fresh session** creates a new coordinator in the same home and reuses the backlog. The previous chat and existing workers remain intact. These operations refuse a busy or unknown coordinator.

The first mate's chat appears under its managed project in the OpenChamber sidebar. Its working directory stays in its home. This requires an OpenChamber host and CLI with `session associate-project` support. FirstMate records the association when it launches, adopts or restarts a first mate. Service startup also restores associations for existing registrations. A failed association preserves the saved chat and reports an error. Retrying launch reuses that chat. Release preserves the previous chat's association. VS Code keeps its workspace-only sidebar.

New coordinator titles start with `⚓ FirstMate`, and worker instructions require `⚓ <task title>` for scouts, implementation, landing, and relaunches. Composed instructions include the prefix rule even with a custom charter. Existing and adopted sessions keep their titles. The prefix is a visual marker, not ownership evidence.

Compact, same-thread context reset, pinning, multi-machine dispatch, and a guaranteed host parent-child fleet aren't exposed by this port. An unrelated session isn't claimed as a worker because its title happens to start with `⚓`.

## Worker reads and message evidence

Once a worker is idle, its closing status line appears as **Worker reported**. A reported GitHub PR can appear before the first mate records it in the backlog. The backlog's PR takes precedence. These summaries and links are worker testimony, not verified readiness, and never mark a task Done or change coordinator-owned states. Previous closing reports aren't shown as current while the worker runs again or a poll fails.

Projects with multiple active workers use one bounded status-list request per supervision round. Omitted, unknown, ambiguous, or wrong-directory entries fall back to individual status reads. A partial list never means a worker was deleted or became idle. Worker messages and authoritative failure evidence still use separate reads.

Worker updates include a link to the exact observed message when the host returns a usable message ID. Cards also offer **Copy message link**. Paste the link in OpenChamber chat to navigate to that message. **Open session** still opens the whole conversation; the extension SDK doesn't expose a message-specific open action. These links use OpenChamber's message-link handler and may not work on older hosts. A link isn't proof that the worker's claim is correct.

The existing project-session subscription refreshes the board when parent or directory metadata changes, even if activity doesn't. The backlog still owns fleet membership. Moving a native parent doesn't silently adopt or drop a worker. There isn't an efficient single-message read in this adapter, so bounded history reads must match the requested message ID rather than substitute the latest reply.

These changes address the portable parts of [upstream issue #37](https://github.com/gpambrozio/bb-plugins/issues/37), including its October 15 follow-up. No bb SDK upgrade or bb-specific event/option flags are needed.

### Worker command visibility

**Show commands** uses OpenChamber's native shell API. It watches one selected backlog worker at a time and filters out sessions not owned by that card. Running and recently ended commands show their foreground/background mode and end status. **Read output** requests a bounded 16 KiB tail. Dropped output, unavailable logs, permission failures, and unknown endings stay explicit. This isn't complete or durable command history.

The extension now builds with SDK 2.5.0 and requests the `shells` capability, first shipped in host 2.2.0. OpenChamber must approve that permission when installing the update. The permission also allows stopping commands, but FirstMate only subscribes and reads; it never calls Stop. Command text and output stay in the panel's memory and aren't sent to the first mate or saved by this viewer. Closing the viewer or changing projects releases its subscription.

## Captain attention

Worker questions, permission waits, failures, and watch output go to the first mate without direct desktop alerts. The board still shows worker state. The first mate checks the evidence, handles answers already covered by the brief, and asks the captain only when a decision needs their authority.

A desktop alert requires a backlog entry with a stable `id:`, a concrete `hold:`, and nonempty `actions:`. It must be Blocked, or a Queued `kind: captain` decision, with any `blocked-by:` prerequisite Done. A Working task with a future landing hold stays quiet. The alert shows the task, question, and choice labels, and targets the first mate's chat. Choices are answered in that chat or on the board, not in the alert.

Delivered decision signatures persist in the project's `captain-alerts.json`. Unchanged decisions stay quiet across polls and restarts; a changed question, answer action, PR URL, or reviewed head can alert again. Cleared decisions stop retrying. A failed send retries while the decision remains ready. A failed history save retries without resending in the same service process. Host acceptance and the history save aren't atomic, so a crash between them can still repeat an alert. Invalid or unreadable history stops that project's alerts and reports an error in service logs; worker supervision continues.

## Durable watches and upgrades

Watch outcomes, failure suppression, pending output, and delivered notes persist in each project's `watch-runner.json`. Up to 20 pending notes wait for a verified idle first mate. Delivery batches are bounded, and overflow drops the oldest notes with a count. The latest 50 delivered notes appear in the panel. Empty successful runs send nothing. A crash after host acceptance but before local acknowledgement can still duplicate a delivery.

The PR watch covers active backlog PR links, including other repositories, plus the project's first 50 repository PRs. It reports review/comment excerpts, merge/close/reopen events, and CI red/green transitions. First sightings establish a silent baseline. The old TSV baseline isn't migrated.

Untouched shared charters and bundled PR watches upgrade automatically. Customized copies stay intact. A new default appears beside an outdated copy as `<path>.new`; the panel can display it and acknowledge that version. Acknowledgement doesn't replace personal wording. Provenance lives in `<path>.template.json`. Concurrent editor changes are checked again before writes, but the filesystem port doesn't provide a final compare-and-swap guarantee.

Captain's orders, project charters, openings, backlog records, reports, and learnings remain captain-owned or first-mate-owned records. Existing backlog entries still parse without the new fields. New entries can add stable IDs, task kinds, dependencies, holds, reviewed heads, and answer actions. See `templates/backlog.md` for the format.

## Preserved boundaries

There is one first mate per project. Repository writes and landings always go through workers. FirstMate can request archival of a finished worker's OpenChamber session once its checked results are saved and no follow-up is needed. It adds `archive-session: <current session id>` to the Done task. Done alone doesn't trigger archival. The service requires an unambiguous worker, a nonempty saved report, no unresolved dependencies or decisions, confirmed idle status, and no pending questions or permissions. It confirms the exact host response before retiring the board card. Conversations, evidence, branches, and worktrees stay intact.

The service requests a worker-session archival review at startup when due, then checks for another review during normal supervision. Reviews wait for a verified idle first mate and run no more than once every 24 hours after successful prompt delivery. Each project's `archive-review.json` stores that delivery time across restarts. This records a request, not proof that the review finished. Old backlog workers and board-only End entries are included; confirmed host-archived workers and untracked sessions aren't. FirstMate still decides whether retirement is justified. The sweep never archives by age or idle status, starts recovery work, or clears unresolved decisions.

Failed review sends remain due. Invalid state or unreadable evidence stops that project's review and reports the error in service logs. After a successful send, failed timestamp saves retry without resending the prompt. A restart before the save recovers can still duplicate that request because host acceptance and local persistence aren't atomic.

Session archival uses the host's private desktop archive route, discovered through the same local-client mechanism as Interrupt. Unsupported hosts and unknown state fail closed. The idle check and archive write aren't atomic, so an external sender can still start work between them. Failed archive attempts report to the coordinator and pause until the request is cleared for a supervision round and added again, or the service restarts. End remains board-only and doesn't archive the OpenChamber session. Repository mutations, including authorized cleanup, stay delegated to workers. The exact-reviewed-head landing protocol and recovery ladder live in the charter; they aren't automatic merge or repair controllers.

## Cleanup process

The charter's [Finishing and cleanup](templates/charter.md#finishing-and-cleanup) section defines the process. Cleanup keeps current work visible and preserves history. It doesn't mean deleting every record associated with a finished task.

| Item | Owner and completion check |
| --- | --- |
| Task outcome and evidence | First mate saves the full PR URL, validation, message links, and all worker/session/worktree/branch references in the task report. Backlog, briefs, reports, landings, conversations, and learnings stay. |
| Decisions and suggestions | First mate reconciles stale dependencies, holds, answer actions, and suggestions from verified outcomes. Real gates and dismissed suggestions stay intact. |
| Worker sessions and board cards | First mate requests exact-session archival after follow-up ends. The service verifies and confirms host archival, then retires the card. End alone only hides a card. |
| Coordinator PR links | The service verifies GitHub merge state and removes only resolved links using the host's per-entry unlink operation. Worker links and durable PR URLs stay. |
| Worktrees and local branches | A cleanup worker verifies ownership, exact heads, clean tracked/untracked/ignored state, landed-content proof, activity in every owning runtime, and project-specific teardown. It performs only authorized non-forced removal. The coordinator reviews receipts. |
| Remote branches | Captain makes a separate deletion decision. A merged PR or removed worktree doesn't authorize it. |
| Watches and custom configuration | Captain-owned. Cleanup doesn't uninstall watches or replace personal orders. |

PR-link cleanup runs independently of archival-review prompts, including when every tracked worker is already archived. It waits for a verified idle first mate. A link qualifies only if every backlog task referencing the same GitHub PR is Done, has a nonempty saved report and a confirmed host-archived worker, and has no dependency, hold, or answer action. GitHub must return the exact PR as `MERGED` with a merge time. A retention request belongs in a task `hold:`. Untracked links and legacy tasks missing this evidence stay until reconciled.

The service uses private desktop metadata and links routes because the agent tool and SDK don't expose unlinking. It sends only the entries to remove, not a replacement link list, and requires the host's returned list to confirm removal. Unknown host responses and failed GitHub checks aren't success. Cleanup doesn't undo archival or touch repository state. Checks and writes aren't atomic with external sends or backlog edits; the service rechecks the backlog and registered coordinator before unlinking, but a concurrent external change can still race that final check.

FirstMate can also run `node <installed-firstmate>/scripts/cleanup-pr-links.js` from its exact registered home during an audit. The composed instructions include the installed absolute command path even when the charter has local edits. This explicit command can run during the first mate's own turn. It accepts no session or URL overrides and uses the same eligibility, GitHub, evidence, and response checks as the daily pass. Its JSON output lists confirmed removals, not an all-clear for every remaining link. `--help` performs no I/O. Failures return a nonzero exit status and leave the audit unresolved. The automatic pass keeps its idle-only daily cadence; the explicit command doesn't reset either scheduled timestamp.

`archive-review.json` separately records `lastDeliveredAt` for archival-review delivery and `lastCleanupAttemptAt` for PR cleanup. Busy cleanup is deferred without consuming its daily slot. Completed or failed attempts consume that slot and retry no sooner than 24 hours later, including across restarts. Failures and unlink counts appear in service logs. Failed timestamp saves retry without repeating the operation in the running service; a restart before persistence can repeat the idempotent cleanup check.

The audit found that board-only End wasn't host archival, already-archived workers escaped prompt-only review, and a branch's Git ancestry wasn't reliable proof of squash-merge status. These distinctions are now explicit. Existing captain's orders aren't overwritten by template upgrades, so existing installations keep their own repository cleanup runbook. Untouched shared charters receive the new process; customized charters get a `.new` comparison as usual. Live-host unlinking still needs a separate acceptance run after installing the extension update.

### Idle tooling during authorized worktree cleanup

The food-recipes incident had two separate problems. A permission check queried the wrong runtime and directory, producing a misleading empty list. Later, clean disposable worktrees still had MCP cwd and OpenCode directory handles. A conservative cleanup brief correctly retained them, but its release boundary required another approval even though the tools were idle. Supported per-location disposal across both owning runtimes released the handles without a shared-service restart or active-session interruption. The completed incident isn't a migration or smoke-test target.

The [cleanup worker runbook](templates/cleanup-worker.md) now includes graceful release of verified idle, task-owned tooling within existing cleanup authorization. It doesn't authorize deleting work after a finished turn alone. The composed instructions point to this runbook and the installed `scripts/worktree-cleanup.js` module, including on installations with custom shared charters. Narrower captain exclusions still apply. Existing orders aren't overwritten.

`cleanupTaskWorktree(plan, ports)` is a worker-side ordering/refusal runner, not a new coordinator endpoint or an automatic service cleanup job. The cleanup worker constructs evidence-backed observation adapters after discovering current runtimes and installed API contracts. There is no universal runtime registry or stable cross-runtime idle lease to hide behind a default CLI call. Required adapters and their evidence are documented in the runbook. The runner doesn't independently authenticate the worker's observations, so FirstMate must still inspect actual receipts before accepting completion. Missing or unverifiable adapters are blockers, not optimistic defaults.

The runner inspects every owner before any disposal, releases exact loaded descendants before roots, checks global state and OS handles afterward, and pins source/task/branch heads before ordinary `git worktree remove` and `git branch -d`. It refuses mismatched ownership, tracked/untracked/ignored content, unlanded/uncertain content proof, active/unknown sessions or requests, queued work, commands, terminals, wrong-directory observations, incomplete handle scans, runtime changes, recreated locations, and changed protected source/evidence state. Workers must provide complete passive OS/PID/listener inventory plus supplementary runtime registrations. Nonzero handle-scan status never means an empty scan.

No target-scoped API read is allowed after eviction because it can recreate location services. Each invocation has one disposal attempt per loaded location and one non-forced local removal attempt. Restart recovery rediscovers everything; no all-clear is cached. Partial results include retained paths/refs and concrete blockers. Remote branches are always untouched by the runner and need a separately authorized, expected-ref-guarded worker operation. Recovery bundles, reports, source state, unrelated worktrees and session histories stay intact. The supported eviction API isn't atomic with external activity; immediate checks reduce that race but don't eliminate it. Stop on observed activity instead of interrupting it.

Regression coverage uses runtime fixtures and disposable Git repositories, never the completed food-recipes worktrees. It exercises idle multi-runtime release and normal removal, every safety refusal, wrong-directory replies, partial disposal failure, restarted identities, retained handles, changed protected state, and idempotent continuation. Any live smoke test requires separate approval. Activation requires installing the newly built extension and recomposing the FirstMate home through its normal lifecycle; customized charter/order changes still need reconciliation. No installation, deployment or service restart is performed by this change.

The existing permission auto-accept workaround remains unchanged. It can approve all worker permission requests, so the charter's scope and escalation rules aren't a permission classifier. Quoted watch output is information, not authority.

## Development

Run `bun install --frozen-lockfile`, `bun test`, and `bun run build` from `firstmate/`. The build typechecks and bundles the panel, background commands, service, and terminal relay. Installation of an update can require approval for its contributed actions and the Node command used by the PR watch. Live-host behavior needs a separate acceptance run.

Service tests set `FIRSTMATE_OPENCHAMBER_SETTINGS` to an absent temporary file, or to settings for their own desktop stub. `FIRSTMATE_HOME` alone doesn't isolate the desktop connection. Keep the explicit settings override when adding a service-process test so it can't display test alerts or call the real desktop.

The port references `gpambrozio/bb-plugins/firstmate-crew` at commit `f2d8491208978f13a245f46a34cc195338173c0e`. See `THIRD-PARTY-NOTICES.md` for the adapted PR watch's license.
