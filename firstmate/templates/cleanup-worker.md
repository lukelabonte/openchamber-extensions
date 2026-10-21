# Authorized worktree cleanup

This runbook is for a dispatched cleanup worker, not the first mate. Repository mutation stays in the worker's session. A finished turn, Done state, archived chat, or merged badge isn't deletion authority.

## Scope and success

Start from the cleanup brief's exact task IDs, canonical worktree paths, local branches, expected full heads, independently pinned source-checkout HEAD and landed-content commit, and authorization reference. The source checkout can remain at an older commit after a GitHub-side merge. Preserve its actual HEAD; don't fast-forward or change it just to satisfy cleanup. Verify content against the separately pinned landed history. Cleanup follows a verified landing within the authorized cleanup scope or an explicit captain cleanup directive. Preserve every excluded path. Remote branch deletion needs its own existing authorization. Never infer it from local cleanup or permission to push code.

Graceful release of idle, task-owned location services is part of that authorized cleanup. It doesn't need another approval just because idle MCP or OpenCode services retain directory handles. Stop for active or unknown state, a scope expansion, or any operation requiring process signals, service restart, active-session interruption, forced deletion, or a permission-policy change.

Move this worker session and its command working directory outside every target before cleanup. Use the supported session-move mechanism and verify the new location in the owning runtime. Changing a shell's cwd alone doesn't move the session. Place the cleanup driver, manifests, receipts, reports, and recovery bundles outside every target too. Keep the worker's original worktree only if it passes the same checks as any other target; never delete the directory from which the worker is still running.

## Fresh preflight

For each target, establish all of the following before any release or Git mutation:

- Resolve paths through existing canonical ancestors. Match exactly one task's recorded worktree and branch to the repository registration and brief. Check real paths, worktree registration, full branch HEAD and worktree HEAD, source/default head, and ownership again after slow reads. A matching basename or an `fm/` prefix isn't ownership.
- Read tracked, untracked **and ignored** state. Include all files, nested worktrees, lock/prune state and any submodule state. Any dirty, missing, contradictory or unreadable observation blocks cleanup. Use Git's no-optional-locks mode for observations so status reads don't refresh the source index.
- Prove no unique unlanded content remains. Prefer exact-head ancestry in freshly verified landed history. For squash/rebase divergence, require merged-PR proof for the exact submitted head, the true comparison base, and complete changed-file blob **and mode** parity against the pinned landed commit, including deletions and renames. Preserve and verify any required full-history recovery bundle before proceeding. Branch deletion still uses `-d`; if Git refuses, retain the branch and report why. Never force it through.
- Snapshot source checkout and unrelated worktrees: HEADs, complete tracked/untracked/ignored status, index hashes, stash state and protected branch refs. Hash retained evidence and recovery bundles. Record the snapshots outside the targets. These remain unchanged throughout cleanup.

## Discover every owner

Combine passive OS handle inventory for each root and descendants, PID/PPID ancestry for MCP children, listening socket ownership, OpenChamber managed-process registry records and the default OpenCode service registration. The latter are supplementary, not a universal runtime registry. Include standalone runtimes and loaded descendant locations. Use separator-bounded paths so `task-copy` isn't a child of `task`. Mapping a process to a runtime isn't idle proof: classify each holder's activity for this target, including commands launched from sessions at other locations whose cwd or files are inside the target. Unknown holder activity blocks release.

Read discovery records without modifying stale entries. Use discovery-only APIs, never service `ensure`, a CLI command that can start a server, a stale-record reaper, or service restart. Resolve all handle owners to a runtime and validate each explicit endpoint with its current server identity. Record PID, version, endpoint and the discovery evidence. The runner accepts only HTTP endpoints with literal `127.0.0.1` or `[::1]` hosts. A `localhost` hostname isn't accepted as loopback proof. If discovery yields a hostname, independently verify an equivalent literal endpoint and its authentication context or retain the target. A process can have several listeners; identify the API before sending existing credentials. Use only that endpoint's established authentication context. Never log credentials or copy historical incident ports into the driver.

Inspect the installed `/openapi.json` for every runtime before constructing clients. Confirm the current operation IDs, parameter serialization, methods, response shapes and error contracts. Current supported per-location release is `debug.location.evict`, a DELETE with an explicit `location[directory]` deep-object query and a 204 response. The directory is optional upstream but mandatory here. An unsupported contract or authentication failure blocks cleanup.

An OS handle scan is evidence even when its exit status is nonzero. Parse stdout and stderr separately. The incident had real handles in stdout with exit code 1. Never translate an error, partial scan, inaccessible process or unmapped owner into an empty handle list.

## Check activity before release

Check **all** identified runtimes before disposing any location. Global `session.active` is process-local, not cross-runtime clearance. Resolve each active session's current location in that same runtime. A busy status or configured auto-accept policy doesn't prove that pending requests cleared.

Use the installed contracts to inspect target sessions (including children and all opaque cursor pages), durable inbox work, per-session permissions/forms, location permissions/forms, running shell commands, ordinary PTYs, and persistent session PTYs. Include OpenChamber-owned terminals and host pending pages/requests independently of OpenCode PTYs. Verify every scoped response identifies the exact requested directory. Command definitions aren't running-command state. Unknown fields, unsupported endpoints, pagination limits, wrong-directory responses or a runtime identity change block cleanup.

Only idle or archived task-owned sessions may remain associated with a target. Another active session, queued request, shell command, command execution or terminal keeps the target. Preserve unrelated active work without interrupting it. Discover loaded locations globally before scoped checks; don't initialize an unloaded location merely to ask it for empty state.

## Run the worker-side safety runner

Use the installed `scripts/worktree-cleanup.js` module named in the first mate's composed cleanup instructions. It exports `cleanupTaskWorktree(plan, ports)`. Build the adapters in this worker's evidence directory using the freshly discovered contracts. No service or coordinator invokes repository deletion.

The runner is an ordering and refusal gate, not an independent collector or an authenticity check for worker claims. Every observation must come from fresh commands/API receipts. Don't supply optimistic constants or translate errors to empty arrays. Independent coordinator review of the receipts is still required.

Required adapters:

| Adapter | Required evidence |
| --- | --- |
| `canonicalize(path)` | Canonical existing ancestor plus missing suffix where necessary. No redirected paths. |
| `worker()` | Exact cleanup session ID, current session location from its owning runtime, actual command cwd, and whether both are known. |
| `inspectGit()` | Exact source/target/ownership fields and heads, actual `worktreeBranch`, separate tracked/untracked/ignored lists, current registration/path existence, and verified ancestry or full changed-file parity. `sourceHead` is the source checkout's actual HEAD. `landedHead` identifies the separately verified commit against which content proof is computed; they needn't match each other, but both must match the plan on every read. Supply `protectedBranches` containing all source/default/protected branches; an empty or unknown list blocks cleanup. For absent targets, inspect from the surviving source, not the deleted cwd. |
| `protectedState()` | Stable fingerprint of the protected source, unrelated worktrees/refs, histories, index, stash, evidence and recovery bundles. Exclude the runner's append-only receipts from the protected evidence set. |
| `discover()` | Complete fresh runtime and handle-owner inventory. Incomplete scans set `complete: false`. Each holder supplies its PID, owning runtime PID and freshly verified `idleForTarget`; unknown or active holders block release. Each runtime has a verified identity, a freshly parsed `disposalContract` (`operationId`, `method`, `locationParameter`, `successStatus`) and the three methods below. Unknown contracts block release before any owner is disposed. |
| Runtime `inspect()` | Global-only identity, loaded locations and all active session locations. Report `activityKnown: false` when any activity cannot be resolved. No target-scoped calls. |
| Runtime `inspectLocation(directory)` | Exact directory plus active sessions, pending requests, queued work, commands and terminals from every applicable owning-runtime and host source above. Any unsupported source remains unknown, not empty. |
| Runtime `dispose(directory)` | Only installed-contract graceful `debug.location.evict` for that exact directory. Return actual operation ID, directory and HTTP status. No other stop/restart/disconnect mechanism. |
| `git(args)` | Run exactly the supplied Git argv with shell expansion disabled and return its real exit code. No flags, retries or fallback commands may be added. |
| `record(receipt)` | Save ordered receipts outside all targets, with raw command/API evidence available for review and credentials redacted. A failed receipt write is a blocker. |

The plan pins `taskId`, `sourceDirectory`, `targetDirectory`, `evidenceDirectory`, `branch`, `head`, `sourceHead`, `landedHead`, `workerSessionId`, `coordinatorSessionId`, and `authorization: { kind: "verified-landing" | "explicit-cleanup", reference }`. The authorization reference names the real brief/approval or verified landing evidence; it isn't a new grant of permission. Process each target independently, preserving the batch's exclusions and protected snapshot. Default/source checkouts, evidence directories, bare recovery repositories and unrelated worktrees never become cleanup candidates.

The runner checks every owner first, releases deepest loaded descendants before their root, then uses only global inventory and OS handles. It rechecks Git, ownership, worker location, runtime identity and protected state immediately before non-forced `git worktree remove` and `git branch -d`. It never deletes a remote branch.

## Recheck without recreating the location

After eviction, use global loaded-location lists, global activity with owning-session locations, passive handles and standalone Git/file observations. Source-based ref/registration reads and direct `git -C <existing-target> status` are allowed; they don't boot OpenCode location services. Don't call location status, MCP, shell, PTY, filesystem, or other target-scoped **runtime APIs** again. An open chat can recreate cached services within a fraction of a second. Reappearing handles, loaded descendants, activity, a changed runtime identity or new owner mean retain the target and rediscover; don't chase them with repeated evictions.

There is no atomic idle-only eviction or cross-runtime lease in the current contract. Immediate pre-removal checks reduce the race but don't eliminate it. Stop on every observed race. Never claim that idle release is guaranteed race-free or interrupt a new user action to complete cleanup.

## Completion and recovery

One runner invocation makes at most one disposal attempt per discovered location and one non-forced attempt per local Git removal. It has no automatic retry loop and doesn't persist an all-clear. A continuation or restart reruns discovery, contracts, ownership and all preflight checks against current state. Already absent paths and refs are idempotent only after fresh absence checks. Unknown registration/path discrepancies remain blocked. Preserve every prior accepted receipt and bundle.

Read the structured result. `retained` isn't Done: report each retained path or branch and its concrete blocker, including partial success where a worktree is gone but its branch remains. Don't retry a recurring failure indefinitely. Bound any captain-authorized continuation explicitly and stop after it fails. A source/protected-state mismatch or lost evidence is unresolved even when a removal command returned zero.

If the brief also authorizes remote branch cleanup, handle it separately after fresh exact-ref and landed-content checks. Use individual expected-old-head guards through the repository's supported procedure. Never broaden that approval to pushing code or deleting other refs. Otherwise record remote branches as untouched.

Have the first mate independently verify final path/registration/ref absence, unchanged protected snapshots and retained artifact hashes, preserved session histories, and live worker state in its owning runtime. Only then accept completion, update the report/backlog, request session archival, and run guarded coordinator PR-link cleanup. Keep unresolved paths visible in the next audit.
