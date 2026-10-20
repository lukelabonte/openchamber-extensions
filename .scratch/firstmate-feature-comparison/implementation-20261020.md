# FirstMate extension refresh, 2026-10-20

## Result

OpenChamber has added useful extension APIs, but most of the remaining BB-specific fleet controls still aren't exposed. This change uses the new shell API and ports four bounded behavior improvements. It doesn't claim full BB parity.

Research snapshots:

- [OpenChamber platform, releases, catalogs, and direction](openchamber-platform-20261020.md).
- [Current BB FirstMate parity and remaining differences](upstream-parity-20261020.md).

The platform research compares released OpenChamber 2.5.0 with official main at `6491f51dbcf05d1e3f7f823049f5f097c96c234b`. BB's default branch is still the port's original reference, `f2d8491208978f13a245f46a34cc195338173c0e`. These are older missing behaviors, not features newly landed in BB.

## Implemented

| Area | Change | Boundary |
| --- | --- | --- |
| Native command visibility | A user-selected worker card subscribes to its running and recently ended shell commands. Output reads request a 16 KiB tail. | One subscription, exact backlog session IDs only. No inferred children, automatic reads, Stop calls, log persistence, or agent delivery. Unknown endings and unavailable/dropped output stay explicit. |
| Suggestions (R1) | Sending removes the original label and prompt only. Suggestion/history rewrites reread staged content and retry conflicting edits up to three times. | Delivery isn't repeated after cleanup failure. The final content-check/rename race remains. The filesystem port has no removal operation, so a failed/conflicting update can leave one staging file. |
| Board refresh (R2) | Keep the last good cards with a stale/error notice. Ignore superseded board replies and refresh verdicts. | Initial failure stays distinct. Stale-card actions still use service-side validation. |
| Closing reports (R4) | Display the worker's closing status summary after it becomes idle. Offer a labeled GitHub PR fallback when the backlog doesn't already name one. | Worker testimony never changes task state, establishes readiness, or overrides host failures. Reports disappear during a new turn or failed observation. |
| Captain sends (R5) | Report commands, suggestions, decisions, and worker notes share a synchronous panel-local send guard. Command failures are visible. | No cross-frame or service-wide deduplication guarantee. Worker controls and automation stay independent. |

Main code is in `firstmate/panel/worker-shells.ts`, `panel/main.ts`, `panel/state.ts`, `service/suggestions.ts`, `service/worker-report.ts`, and both board mapping modules. The README and third-party notices describe the behavior and source attribution. Generated panel/background/service bundles were rebuilt.

## Compatibility and permissions

The SDK pin is now 2.5.0. The host requirement is now `>=2.2.0`, when the public shell API shipped. The previous `>=1.22.0` floor also predated workspace/background APIs already used by this port. This version boundary is source-backed, not a completed live compatibility matrix.

The manifest adds `shells`. OpenChamber must approve it during installation. That capability includes stopping commands, even though this implementation only subscribes and reads. No installed extension, running host, permission setting, real session, worktree, ticket, or pull request was changed by this development pass.

## Deferred

| Difference | Why it remains separate |
| --- | --- |
| Compact, same-thread reset, pin control, writable parent relationships, single-message reads, arbitrary provider options | Still absent from the checked public extension/control contracts. An internal app API isn't a stable extension API. |
| Missing-coordinator recovery and adoption before launch (R3) | Needs a verified distinction between absent, archived, unreachable, and omitted sessions before changing lifecycle records. |
| Watch cancellation/drain and independent due-watch execution (R6) | Process lifecycle work needs its own shutdown and descendant-process tests. |
| Watches after Release and richer watch diagnostics/state (R7) | Continuing scheduled execution after Release changes behavior. It isn't implied by a missing panel label. |
| Canonical-path confinement and symlink handling (R8) | A separate filesystem safety change, not UI parity. No sandbox or race-free confinement is claimed. |
| Extra worker-local action controls (R9) | Existing tests deliberately omit them. The handoff authority boundary stays intact. |
| Task artifact/recency fields and first-launch model picker (R10/R11) | Separate schema and launch-flow work. Neither requires pretending BB's picker exists in the guest SDK. |

One first mate per project, worker-only repository mutation, preserved sessions/worktrees on End, and explicit landing authority remain unchanged.

## Validation snapshot

The initial clean baseline passed 991 tests. New regressions were observed failing before their implementations, including closing-report extraction/rendering, edited suggestions, stale board responses, repeated captain sends, and shell-viewer lifetime handling.

After integration and review corrections: `bun test tests/` passed **1,095 tests across 65 files**, with **4,568 assertions** and zero failures. `bun run build` passed, including TypeScript checking and bundle regeneration. `git diff --check` and `node --check service/main.js` passed.

The report/suggestion review found two closing-report edge cases. Markdown-wrapped PR URLs now extract correctly, and bare status claims explicitly show that no details were supplied instead of displaying a blank note. Eight failing regressions confirmed the missing behavior before the fixes; the follow-up review verified both corrections.

Shell updates also redraw only their own command widgets, rather than rebuilding unrelated form controls. Two failing integration assertions reproduced the input replacement before that correction. Independent follow-up review verified the isolated redraw and subscription cleanup. Both review streams ended with no remaining findings in their scopes.

Live-host acceptance wasn't run. The update remains uncommitted and uninstalled. Installation, permission approval, and real-worker acceptance remain manual.
