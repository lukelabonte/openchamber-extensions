# FirstMate upstream parity, 2026-10-20

This is the pre-change inventory at `a72774a466e110cdb03d8f438367c2d60d798fcb`, not the final remaining-work list. Local file/line links describe that snapshot and can shift after edits. See [the implementation record](implementation-20261020.md) for the changes made afterward.

## Result and exact comparison points

**There are no new upstream default-branch features since the port's cited baseline.** GitHub's repository API reports `main` as the default branch. `GET /repos/gpambrozio/bb-plugins/commits/main` returned **`f2d8491208978f13a245f46a34cc195338173c0e`**, exactly the baseline in [firstmate/README.md:64](../../firstmate/README.md#L64). Its commit date is 2026-10-10T23:48:34Z. The latest commit touching `firstmate-crew/` is [`aca52188a1cb257536aaac3a7c76096f6badfa85`](https://github.com/gpambrozio/bb-plugins/commit/aca52188a1cb257536aaac3a7c76096f6badfa85), dated 2026-10-10T00:23:39Z, which ships version 0.5.0 and batch crew metadata reads ([changelog][u-changelog]).

The remaining work is **pre-existing behavior parity**, not catching up with newer upstream commits. The earlier [comparison.md](comparison.md) is a useful inventory, but most of its missing-feature claims no longer describe this port.

- Local port snapshot: clean tracked/untracked status at start, HEAD **`a72774a466e110cdb03d8f438367c2d60d798fcb`**. Local source links below refer to that inspected checkout.
- Sibling checkout `../bb-plugins`: HEAD **`d95bc3691387858c060d8b7305c50799621ba906`**. It doesn't contain the baseline object, so a local baseline-to-HEAD log fails. It wasn't used as current-upstream evidence. Current upstream files were read through GitHub's contents API with `ref=f2d8491208978f13a245f46a34cc195338173c0e`.
- Upstream links below all pin that full SHA. Issue links are mutable discussion, not evidence of shipped code.
- Applicable guidance read: this repository's `AGENTS.md` and `docs/agents/issue-tracker.md`, the sibling's local `AGENTS.md`, and remote root/`firstmate-crew/AGENTS.md`. No other checkout was changed.
- This is source inspection. No tests, builds, live sessions, scripts, permission changes, installs, or issue/PR mutations were run. Proposed tests below are acceptance candidates, not passing-test claims.

## Recommended order

1. **Preserve suggestions correctly during sends and concurrent edits (R1).** Existing functionality can remove newer captain/coordinator text.
2. **Keep the last usable board and reject stale responses (R2).** Small panel-only change with direct user benefit.
3. **Recover a missing coordinator and make adoption reachable without launching another (R3).** Separate verified absence from unknown/unreachable state.
4. **Expose parsed worker closing reports without treating them as completion proof (R4).** More useful status and PR links with no BB dependency.
5. **Share a captain-message send gate and show command failures (R5).** Existing per-action guards don't cover the whole panel.

R6-R8 cover watch/process and filesystem safety parity. They need their own focused changes rather than being bundled into panel polish. R9-R11 are smaller product choices. Host-only differences and deliberately stricter authority rules are listed separately.

## Portable enhancements still missing or partial

### R1. Exact suggestion identity and edit-preserving removal

**Upstream:** removes the suggestion identified by **label and prompt**, not just its label. It rereads and retries a bounded number of times if the file changes before replacement. Its parser also treats HTML comments as hidden notes, preserves their bytes, accepts common Markdown label/bullet variants, and limits the visible list to eight ([identity and parsing][u-suggestions], [checked replacement and dismissal][u-suggestion-home]).

**Port:** [service/suggestions.ts:121-143,157-169](../../firstmate/service/suggestions.ts#L121) removes every matching label after delivery. A coordinator can replace `Review :: old prompt` with `Review :: new prompt` while the send is pending; the subsequent label-only removal deletes the new request too. The file is read once and renamed without a second content check. The per-project suggestion lock only covers this service's actions, not the coordinator/editor ([service/main.ts:1090-1096](../../firstmate/service/main.ts#L1090)). The parser reads raw `- label :: text` lines even inside a multiline HTML comment ([service/suggestions.ts:12-33](../../firstmate/service/suggestions.ts#L12)). Persistent dismissal suppression itself is already implemented.

**Smallest scope:** first change sent-item removal to match the exact original label and prompt. Then add checked replacement for suggestion and dismissal files, preserving the existing successful-send/removal-warning contract. Treat hidden-comment parsing and the display cap as a separate optional parser change; don't silently expand the documented grammar.

**Tests:** extend `firstmate/tests/suggestions.test.ts`, `suggestion-dismissals.test.ts`, `service-suggestions.test.ts`, and the panel suggestion harness. Cover same label/new prompt during send, unrelated edits between read and rename, failed checked replacement after successful delivery, hidden suggestions in HTML comments, and no accidental removal of other entries. No resend when only local removal fails.

### R2. Last-good board retention and newest-response-wins refreshes

**Upstream:** keeps its last fleet after a refresh error and labels it stale. A monotonically increasing request number rejects slower answers from earlier refreshes ([use-fleet.ts:28-44][u-refresh], [panel.tsx:86-100][u-panel]).

**Port:** `board-failed` replaces a ready board with an error object, discarding its cards ([panel/state.ts:130-132](../../firstmate/panel/state.ts#L130)). `fetchBoard()` checks registration identity, but not which request is newest ([panel/main.ts:381-413](../../firstmate/panel/main.ts#L381)). Manual, timer, and session-subscription refreshes can overlap for the same registration. Auxiliary reads already have a request-generation pattern at [panel/main.ts:521-536](../../firstmate/panel/main.ts#L521), so this doesn't require a new abstraction.

**Smallest scope:** `panel/state.ts` and the board fetch/render functions in `panel/main.ts`. Retain ready columns plus an explicit refresh error. Use a request generation for board responses. Keep initial-load failure distinct. Decide whether stale-card actions stay available with server-side revalidation or are disabled; never make stale cards look live.

**Tests:** `panel-state.test.ts`, `panel-refresh.test.ts`, `panel-reliability.test.ts`, and their helpers. Load-success-then-failure retains the same cards; initial failure doesn't invent cards; recovery clears the notice; older success/error arriving after a newer result is ignored; project/session switches still reject old answers.

### R3. Missing-coordinator recovery and no-coordinator adoption

**Upstream:** resolves deleted/archived coordinators as absent, retains the backlog, shows a specific missing-coordinator notice, and permits launch/adoption without first creating another coordinator ([bb-ports.ts:134-147][u-adapter], [mate.ts:62-72,154-174][u-mate], [panel.tsx:26-83][u-panel]).

**Port:** existing registration/remembered IDs are reused without a liveness check ([service/launch.ts:55-70,94-109](../../firstmate/service/launch.ts#L55)). Adopt, release, and restart all require the previous ID's status to be idle; missing/unreadable status throws or remains unknown, with no verified-gone branch ([service/lifecycle.ts:34-60,78-95,129-132](../../firstmate/service/lifecycle.ts#L34)). Also, the adoption form exists only in the registered settings section. An unregistered/released panel renders only the welcome/launch path ([panel/main.ts:629-656,854-889,935-962](../../firstmate/panel/main.ts#L629)). The backend can resolve an existing home without a registry, but the normal UI doesn't expose that path.

**Smallest scope:** add a coordinator-resolution result that distinguishes live, explicitly missing/archived, and unknown/unreachable. Use verified absence to offer an explicit replacement/adoption flow without discarding the old records. Don't infer deletion from absence in a bounded session list. Add an existing-home lookup/adoption entry point to the welcome state. Preserve the current busy/unknown safety refusal.

**Tests:** `launch.test.ts`, `lifecycle.test.ts`, `service-launch.test.ts`, and `panel-port.test.ts`. Missing and archived recorded ID, transient host failure, partial-list omission, release then adopt without launch, adoption failure preserving the registry, and concurrent replacement requests. Host absence/error semantics need confirmation before choosing the adapter implementation.

### R4. Parsed worker reports, useful closing summaries, and report PR links

**Upstream:** parses a worker's final few nonempty lines into `working`, `needs-decision`, `blocked`, `paused`, `done`, `failed`, or `resolved`. Idle worker reports refine columns; a live worker's `done:` never makes the task Done. Cards show the parsed status summary and can link a URL from the report before the coordinator records it ([crew-report.ts:16-62][u-report], [fleet.ts:62-93,115-140][u-fleet], [card.tsx:123-152][u-card]).

**Port:** the charter requests closing status lines, but code stores the entire last message as `lastWord`, doesn't parse that protocol, and truncates from the start. `mapBoardState()` accepts host status/outcome only; card PR links come only from backlog `pr:` ([templates/charter.md:40](../../firstmate/templates/charter.md#L40), [service/poller.ts:282-298](../../firstmate/service/poller.ts#L282), [service/board.ts:76-126](../../firstmate/service/board.ts#L76)). A long reply can hide its important closing `blocked:` or `needs-decision:` line. Native question/permission observation already exists and isn't missing.

**Smallest scope:** a pure closing-report parser, additive report fields on `WorkerObservation`/board wire types, and a clearly labeled worker-reported summary. Initially preserve coordinator-owned states and authoritative host failures. Any upstream-style column override needs an explicit precedence decision because existing tests intentionally preserve Blocked/Parked/Done/Failed/Idle. A report URL must be validated and labeled as worker evidence, not as verified PR readiness.

**Tests:** parser cases for CRLF, Markdown/bold prefixes, no matching line, prose containing status words, a closing status after a long message, and stale reports during a new turn. Extend `board-state.test.ts`, `panel-board.test.ts`, `poller.test.ts`, and `message-links.test.ts`; never convert `done:` into Done or substitute the wrong message ID.

### R5. One captain-message send gate and visible delivery failures

**Upstream:** a module-lifetime gate covers suggestions, decisions, Bearings, and palette sends. It closes synchronously, survives tab switches, and releases after success or failure ([send-gate.ts:1-49][u-send-gate], [card.tsx:93-100,137-140][u-card]).

**Port:** suggestions, decisions, worker notes, and worker actions have separate pending flags/locks. The Status report and Catch me up buttons don't gate sends. `sendCommand()` neither checks a non-200 service response nor displays failures ([panel/main.ts:1040-1073](../../firstmate/panel/main.ts#L1040)). A command can overlap a suggestion or decision; repeated report presses can send repeatedly. Some service routes serialize through the lifecycle queue, but serialization isn't duplicate suppression or shared UI pending state ([service/main.ts:1096-1115,1178-1205,1244-1287](../../firstmate/service/main.ts#L1096)). Background extension commands already parse delivery responses correctly ([panel/commands.ts:53-70](../../firstmate/panel/commands.ts#L53)).

**Smallest scope:** share one per-project user-send gate in the panel and reuse the existing response-validation behavior for panel command buttons. Separate background frames need a service-side gate if cross-surface overlap is part of the guarantee. Keep automation delivery queues separate; don't globally block unrelated projects.

**Tests:** extend `panel-port.test.ts`, `panel-suggestions.test.ts`, `commands.test.ts`, and focused service tests. Double-click report, suggestion then decision, report then context switch, synchronous failure, non-200 response, and a different project proceeding independently. Retain drafts on refusal and don't claim delivery success on a failed response.

### R6. Watch cancellation, graceful drain, and independent due-watch execution

**Upstream:** stops scripts through an abort signal and waits for ticks, deliveries, and saves before a new runner starts ([watches.ts:212-259][u-watch-stop], [server.ts:125-181][u-server]). It executes different due watches concurrently ([watches.ts:276-290][u-watch-tick]). Its process-group SIGKILL remains scheduled even if the script exits first because descendants may survive ([watch-run.ts:1-5,69-79,98-118][u-watch-run]).

**Port:** the runner has no stop/drain API. Service shutdown cancels timers, then exits on server close or after 500 ms ([service/main.ts:1534-1542](../../firstmate/service/main.ts#L1534)). `executeWatch()` has no abort input and clears the force-stop timer when the direct child closes ([service/watch-exec.ts:26-57](../../firstmate/service/watch-exec.ts#L26)). Due watches execute serially across projects ([service/watches.ts:238-269](../../firstmate/service/watches.ts#L238)). One slow watch can delay unrelated due watches and delivery for the whole round.

**Smallest scope:** first add cancellation/active-run tracking to `WatchExecPort` and `WatchRunner`, then drain service work before exit with a bounded shutdown deadline. Preserve escalation for the process group after the parent exits. Add bounded independent-watch concurrency separately, retaining per-watch non-overlap and store serialization.

**Tests:** `watch-exec.test.ts`, `watches.test.ts`, `watch-reliability.test.ts`, `service-round-serialization.test.ts`, plus a focused shutdown integration fixture. Stop during a run/send/save; no new run after stop; a descendant that ignores TERM while its parent exits; slow watch A doesn't prevent watch B; one watch never overlaps itself. These tests may need fixture processes, so they weren't run during this read-only investigation.

### R7. Watch behavior without a coordinator, invalid-script diagnostics, and per-watch delivery state

**Upstream:** a prepared home can keep running watches without a coordinator and queue output for later. Release forgets the mate, not the home or watch runner ([mate.ts:81-88,172-174][u-mate], [server.ts:94-122,125-151][u-server], [watch-delivery.ts:29-52][u-watch-delivery]). Watch discovery lists invalid regular scripts with a reason, including missing schedule, executable bit, or shebang. Summaries include running and queued/delivered/dropped state ([watch-files.ts:80-127][u-watch-files], [watches.ts:407-430][u-watch-summaries]).

**Port:** release removes the registration, and scheduled execution iterates registrations only ([service/lifecycle.ts:56-73](../../firstmate/service/lifecycle.ts#L56), [service/watches.ts:238-250](../../firstmate/service/watches.ts#L238)). Existing pending notes survive on disk, but newly due runs for that released project aren't generated. Discovery starts from executable files and silently skips unreadable scripts or missing schedules; it doesn't validate a shebang ([service/main.ts:78-95](../../firstmate/service/main.ts#L78), [service/watches.ts:182-214](../../firstmate/service/watches.ts#L182)). The port persists execution outcome and delivery history, but each watch row doesn't carry upstream's running/queued/delivered/dropped lifecycle ([service/watches.ts:391-417](../../firstmate/service/watches.ts#L391), [service/watch-store.ts:4-18](../../firstmate/service/watch-store.ts#L4)).

**Smallest scope:** split these into separate choices. (1) Define whether Release pauses scheduling or only releases the coordinator; if the latter, keep a durable enabled-home association separate from the coordinator registry. (2) List regular candidate scripts and show invalid metadata rather than hiding them. (3) Derive per-watch pending/delivered state from the existing store rather than inventing another queue.

**Tests:** `durable-watches.test.ts`, `watch-reliability.test.ts`, `panel-watches.test.ts`, `service-watches.test.ts`. Release, due run with no coordinator, later adoption, invalid/non-executable/no-shebang scripts, running state, delivery backlog, overflow, and execution-success/delivery-failure remaining distinct. Continuing watches after Release changes current behavior and needs approval.

### R8. Home confinement and canonical-path identity

**Upstream:** its plugin-owned file access checks relative paths and real paths, refuses symlink escapes, uses exclusive creation and staged writes, and checks content on edited shared records. Watch folders themselves must be plain directories. Adoption compares real paths ([files.ts:31-125,283-310][u-files], [watch-files.ts:113-127][u-watch-files], [mate.ts:137-164][u-mate]). These controls don't sandbox arbitrary scripts or eliminate final check/use races.

**Port:** the filesystem port delegates directly to `stat/readFile/writeFile/mkdir/rename`; project normalization is `path.resolve`, not realpath ([service/main.ts:52-98](../../firstmate/service/main.ts#L52), [service/slug.ts:5-7](../../firstmate/service/slug.ts#L5)). A direct symlink watch file is filtered by `Dirent.isFile`, but a symlinked parent watch directory is still followed by `readdir`. Lexical home checks and template content rereads already exist, but they're not equivalent to upstream's realpath confinement ([service/template-upgrades.ts:58-61,94-118](../../firstmate/service/template-upgrades.ts#L58)). A symlink alias for the same home is also rejected by adoption's lexical comparison ([service/lifecycle.ts:41-48](../../firstmate/service/lifecycle.ts#L41)).

**Smallest scope:** a home-aware filesystem adapter that permits the shared root and the correct per-project home, with explicit rules for allowed internal links, creation, rename, and script directories. Apply it to plugin-owned data operations, not arbitrary repository reads or worker tools. This is a safety-hardening change requiring its own plan, not a cosmetic parity patch. Canonical adoption identity can be handled separately.

**Tests:** real filesystem fixtures for linked home/ancestor, internal and escaping links, missing ancestors, exclusive creation, concurrent edits, and plain watch directories. Preserve captain edits. Do not claim race-free confinement or a sandbox. No exploit or filesystem mutation was attempted here.

### R9. Full controls on a worker's own panel

**Upstream:** its worker view uses the normal card with `showOpen={false}`. Decisions, Steer, Interrupt, Relaunch, and End remain available, along with the note box ([panel.tsx:79-82][u-panel], [card.tsx:137-174][u-card], [crew-panel.tsx:13-61][u-worker-panel]).

**Port:** the worker context intentionally returns from `boardCard()` before decisions and worker actions. It provides only the worker facts, message-link copy, Open first mate, and a handoff note ([panel/main.ts:1485-1510,1594-1602](../../firstmate/panel/main.ts#L1485)). [tests/panel-port.test.ts:260-269](../../firstmate/tests/panel-port.test.ts#L260) explicitly expects no Steer control. The note is also deliberately treated as a relay, not upstream's authoritative captain board note.

**Smallest scope if approved:** reuse existing action/decision controls in worker context while omitting redundant Open session. Preserve the existing handoff authority boundary. Change the explicit worker-panel test and add blocked/held worker, action-pending, and failed-send cases. No backend feature needs to be added for the existing controls.

### R10. Task artifact/outcome context and per-card recency

**Upstream:** backlog records include `reportPath`, `outcome`, and `since`; worker cards carry `updatedAt` and pending-interaction counts. Cards show outcome/since for backlog-only entries and relative last activity for workers ([shared/types.ts:62-91][u-types], [card.tsx:111-147,154][u-card]).

**Port:** reports exist by convention and task timestamps exist in the backlog, but the task schema lacks an explicit report artifact/outcome field and the board wire drops created/updated timestamps. The card has no per-task age or count of pending interactions ([service/backlog.ts:22-38](../../firstmate/service/backlog.ts#L22), [service/board.ts:55-74,102-121](../../firstmate/service/board.ts#L55)). The port does show question versus permission and project-level last-poll health; those aren't missing.

**Smallest scope:** first expose the already-recorded task timestamp, labeled as task-record age rather than live worker progress. Add explicit optional report/outcome fields only if the board needs them, with backward-compatible parse/format rules. Don't add a redundant project field to a deliberately single-project board. Pending counts require the observation adapter to retain more than its current activity enum.

**Tests:** `task-records.test.ts`, `backlog.test.ts`, `board-state.test.ts`, `panel-board.test.ts`. Legacy entries still round-trip; invalid timestamps stay unknown; report paths are home-confined; worker testimony doesn't become verified completion.

### R11. Configure a first launch without raw IDs or a prior coordinator

**Upstream:** the launch screen uses the host's provider/model picker, and the settings page exposes the home path before launch ([settings-section.tsx:24-88][u-settings-ui], [settings.ts:14-45][u-settings]).

**Port:** settings use raw provider/model and variant text fields, and appear only after registration. The welcome screen offers just Launch, so selecting the first coordinator model from this UI requires a prior session or manual settings preparation. Home root is a service-start environment option, not a UI setting ([panel/main.ts:629-657,854-889,935-962](../../firstmate/panel/main.ts#L629), [service/main.ts:35](../../firstmate/service/main.ts#L35), [service/launch.ts:114-122](../../firstmate/service/launch.ts#L114)). Arbitrary variant IDs and useful blank-state labels already work.

**Smallest scope:** allow optional coordinator model/variant entry in the initial launch request without changing the saved home layout. A real model picker depends on a verified OpenChamber catalog API; the current guest contract doesn't provide BB's picker. A home-location UI is a separate configuration/migration decision and must preserve active homes, not relocate their records. Changing the default refresh from 30 seconds to upstream's 10 seconds isn't a missing feature: the port already permits 5-3,600 seconds.

**Tests:** `panel-port.test.ts`, `service-launch.test.ts`, `launch.test.ts`, `settings.test.ts`. First launch with chosen defaults, blank defaults, invalid combinations, failed launch, and no secret/provider configuration reads. Don't present a hardcoded model list as host discovery.

## Host-dependent differences, not ready-to-copy missing buttons

| Capability upstream actually has | Current port boundary and disposition |
| --- | --- |
| Guaranteed child workers, coordinator-only spawn command, metadata/task join, orphan child cards | Upstream sets `parentThreadId` and task/kind/project metadata in its guarded CLI, then joins actual children with backlog entries ([cli.ts:196-227][u-cli], [fleet.ts:109-159,251-270][u-fleet]). Local dispatch is agent-driven, and supervision/board membership comes only from backlog session IDs ([templates/charter.md:31-38](../../firstmate/templates/charter.md#L31), [service/poller.ts:233-258,510-517](../../firstmate/service/poller.ts#L233)). A worker created before its backlog session ID is recorded can be invisible. Native parentage isn't exposed by this adapter. A future explicit dispatch/registration operation could narrow the record gap without guessing from `[FM]` titles, but that needs a separate design. Never adopt arbitrary host sessions by title or native parent changes. |
| Every child turn's full last message and detailed host interruption/setup/queued-send causes | BB owns these notifications; upstream charter consumes them ([charter.md:365-443][u-charter-supervision]). Local polling sends event summaries and forwards full changed text after a board steer only. Busy/idle status doesn't encode those reasons ([templates/charter.md:74-82](../../firstmate/templates/charter.md#L74), [service/poller.ts:289-335,341-348](../../firstmate/service/poller.ts#L289)). Every-turn evidence forwarding is potentially portable with message/turn deduplication, but native reason parity can't be fabricated from idle status. |
| Compact, clear context on the same coordinator thread, pinned creation | Upstream calls host operations directly ([mate.ts:120-129,185-216][u-mate], [bb-ports.ts:178-190,232-236][u-adapter]). Local has fresh-session restart and no compact/pin/reset operation ([service/lifecycle.ts:76-95](../../firstmate/service/lifecycle.ts#L76), [service/control-client.ts:37-49](../../firstmate/service/control-client.ts#L37)). The installed guest call union has no such operations ([SDK contract.d.ts:479-546](../../firstmate/node_modules/@openchamber/sdk/dist/contract.d.ts#L479)). Don't imitate compaction by sending ordinary `/compact` text or silently replace fresh-session restart semantics. |
| Worker placement on a configured BB host/checkout | Upstream chooses a project's checkout host or reuses an environment ([bb-ports.ts:84-114][u-adapter]). Local charter creates local OpenChamber worktrees. Multi-machine placement needs host support, not a FirstMate-only flag. |
| Native file-preview links for watch scripts | Upstream calls `experimental_openFilePreview` for the mate's workspace ([use-open-home-file.ts:10-24][u-open-file], [watches.tsx:75-83][u-watches-ui]). The port has no guest open-file call; it has read/write/list/stat and open-session calls ([SDK contract.d.ts:503-546](../../firstmate/node_modules/@openchamber/sdk/dist/contract.d.ts#L503)). Its inline template comparison already covers review of new defaults. Copyable paths or a confined read-only preview are feasible fallbacks, not native editing parity. A whole file editor would be a larger product feature. |
| One-line watch note in chat, expandable chip, full agent-only text, atomic `queue-if-active` send behavior | Upstream uses BB text visibility, path mentions, send modes, and a full-trust app overlay ([watch-delivery.ts:29-52][u-watch-delivery], [bb-ports.ts:193-224][u-adapter], [watch-note-expander.tsx:40-80][u-note-expander]). The port sends the full quoted batch as a normal message after an idle check and retains expandable history in its own panel ([service/main.ts:238-259](../../firstmate/service/main.ts#L238), [panel/main.ts:825-844](../../firstmate/panel/main.ts#L825)). The guest can't inject into the host chat DOM. Idle-check plus ordinary send isn't proof of atomic queue-if-active behavior; preserve that limitation until the host adapter exposes an explicit contract. |

## Deliberate product and authority differences to preserve

- **One coordinator per project.** Upstream is one mate across projects. Local [ADR-0001:9-20](../../docs/adr/0001-one-first-mate-per-project.md#L9) explicitly rejects that model. Cross-project work and global fleet UX aren't unfinished port work.
- **Repository writes always go through workers.** Upstream permits some coordinator repository operations, including authorized landings. Local [ADR-0002:11-19](../../docs/adr/0002-coordinator-never-writes-to-managed-repos.md#L11) is stricter. Exact-reviewed-head checks already exist in the local landing-worker charter; don't import coordinator merge authority.
- **End preserves work.** BB End archives a thread and eventually retires its worktree ([crew.ts:54-72][u-crew]). Local End hides the card and keeps the session/worktree. Cleanup remains the captain's job ([templates/charter.md:87-91](../../firstmate/templates/charter.md#L87)). No archive/delete behavior should be copied for parity.
- **Watch findings aren't unattended repair authority.** Upstream charter routes approved watch findings to workers and cleans up landed tasks ([charter.md:378-390,466-480][u-charter-supervision]). Local watches are informational until the captain asks ([templates/charter.md:93-97](../../firstmate/templates/charter.md#L93)). This is policy, not missing automation.
- **Permission handling differs materially.** Upstream has the mate inspect/approve/deny interactions under a scoped policy. The port retains blanket host auto-accept and warns that it isn't a permission classifier ([charter.md:438-443][u-charter-supervision], [templates/charter.md:42](../../firstmate/templates/charter.md#L42), [service/poller.ts:264-280](../../firstmate/service/poller.ts#L264)). A scoped permission-control feature would need explicit design and an audited host interaction API. Copying prompt text alone wouldn't deliver it.
- **Release while busy is allowed upstream, refused locally.** Upstream release only clears its stored ID ([mate.ts:172-174][u-mate]); local release first requires verified idle ([service/lifecycle.ts:56-60](../../firstmate/service/lifecycle.ts#L56)). Keep the local guard unless that safety tradeoff is explicitly changed. Verified missing-session recovery in R3 is different from allowing release during unknown activity.

## Prior comparison claims now implemented

These are no longer broad missing-feature findings. This table records source inspection, not runtime acceptance.

| Earlier claimed gap | Current code evidence |
| --- | --- |
| `/fm`, terminal handoff, Open/Bearings shortcuts | [package.json:23-34](../../firstmate/package.json#L23), [panel/background.ts:6-34](../../firstmate/panel/background.ts#L6), [service/handoff.ts:23-40](../../firstmate/service/handoff.ts#L23), `scripts/tell.js`. Native commands replace the upstream skill. |
| Stable IDs, Ship/Scout/Captain, dependencies, holds, answer actions | [service/backlog.ts:22-38,54-68](../../firstmate/service/backlog.ts#L22), [service/decisions.ts:16-40](../../firstmate/service/decisions.ts#L16), [panel/main.ts:1559-1590](../../firstmate/panel/main.ts#L1559). See R10 for remaining artifact/recency details. |
| Adoption, release, opening, model defaults, restart | [service/lifecycle.ts:34-95](../../firstmate/service/lifecycle.ts#L34), [service/launch.ts:114-128](../../firstmate/service/launch.ts#L114), [service/settings.ts:3-29](../../firstmate/service/settings.ts#L3), [service/compose.ts:46-55](../../firstmate/service/compose.ts#L46). Restart is deliberately fresh-session; R3/R11 cover remaining reachability and recovery gaps. |
| Durable watch queue/failure suppression/history | [service/watch-store.ts:79-105](../../firstmate/service/watch-store.ts#L79), [service/watches.ts:345-387](../../firstmate/service/watches.ts#L345), [service/main.ts:228-259](../../firstmate/service/main.ts#L228). Twenty queued notes and fifty delivered notes are present. |
| Rich active-backlog PR watch | [templates/pr-watch:162-191,198-254](../../firstmate/templates/pr-watch#L162). Includes external repositories, reviews/comments, self-comment filtering, red/green transitions, bounded parallel lookup, silent baseline, failure suppression, plus local repository-wide first-50 coverage. |
| Safe default-template upgrades and Compare/Acknowledge | [service/template-upgrades.ts:79-139](../../firstmate/service/template-upgrades.ts#L79), [service/provision.ts:28-38,138-147](../../firstmate/service/provision.ts#L28), [panel/main.ts:773-820](../../firstmate/panel/main.ts#L773). See R8 for filesystem safety limits. |
| Persistent dismissal filtering and full suggestion text | [service/suggestions.ts:18-42,88-115](../../firstmate/service/suggestions.ts#L18), `panel/suggestions.ts`, `tests/panel-suggestions.test.ts`. See R1 for identity/edit preservation. |
| Worker-specific card/note panel and persistent column order | [panel/main.ts:874-879,1446-1459,1594-1602](../../firstmate/panel/main.ts#L874), `panel/column-order.ts`. See R9 for deliberate omission of worker-local controls. |
| Exact-head landing policy, recovery ladder, scout reports and learnings | [templates/charter.md:13-42,44-83,87-103](../../firstmate/templates/charter.md#L13), [service/provision.ts:40-48](../../firstmate/service/provision.ts#L40). These remain agent instructions, not code-enforced merge/recovery state machines. |

## Existing upstream issue references, not landed features

[Upstream issue #37](https://github.com/gpambrozio/bb-plugins/issues/37) is open. Its [October 15 follow-up](https://github.com/gpambrozio/bb-plugins/issues/37#issuecomment-6196615923) discusses BB 0.46.1 additions after the current repository commit. Those comments do **not** establish newer `firstmate-crew` code.

- **Batch metadata:** already landed upstream through version 0.5.0, despite the issue remaining open ([fleet.ts:207-215,251-256][u-fleet], [bb-ports.ts:152-156][u-adapter]). The port's batch status read is a different supported optimization because its task metadata lives in Markdown, not BB metadata ([service/poller.ts:231-247,282-292](../../firstmate/service/poller.ts#L231)). No BB metadata endpoint should be simulated.
- **Exact message links and friendly default reasoning labels:** current port implements exact observed-message IDs and meaningful blank placeholders ([service/control-client.ts:224-239](../../firstmate/service/control-client.ts#L224), [service/board.ts:117-120](../../firstmate/service/board.ts#L117), [panel/main.ts:637-646,1514-1532](../../firstmate/panel/main.ts#L637)). Upstream's current closing report schema still has no message sequence ([shared/types.ts:43-46][u-types]).
- **Provider-specific reasoning:** upstream still rejects IDs outside its fixed local list ([bb-ports.ts:12-29,118-124][u-adapter]). The port already accepts opaque variants ([service/settings.ts:17-29](../../firstmate/service/settings.ts#L17), [service/control-client.ts:37-42](../../firstmate/service/control-client.ts#L37)). This isn't a remaining port gap.
- **Arbitrary provider session options:** the comment suggests adding `--option`, but current upstream `crew spawn` has provider/model/reasoning only ([cli.ts:176-190,214-227][u-cli]). The port doesn't expose options either. That is an unlanded enhancement and adapter limitation, not an upstream feature missing from this port.
- **Parent-change refresh:** current upstream subscribes to created/active/failed/archived/pending/idle, not `parentChanged` ([server.ts:217-233][u-server]). The port already refreshes on its broader `onSessions` snapshot and intentionally keeps backlog membership ([panel/main.ts:245-272](../../firstmate/panel/main.ts#L245), [README.md:40](../../firstmate/README.md#L40)). Neither BB's new event name nor descendants API belongs in the port.
- Earlier feature history references: held-card answers [#35](https://github.com/gpambrozio/bb-plugins/pull/35), dismissal suppression [#32](https://github.com/gpambrozio/bb-plugins/pull/32), removal of Ahoy [#30](https://github.com/gpambrozio/bb-plugins/pull/30), batch metadata [#40](https://github.com/gpambrozio/bb-plugins/pull/40). The port retains Catch me up/Ahoy as an extra feature; removing it isn't required for parity.

## Confidence and remaining uncertainty

- High confidence: remote default SHA equals baseline; the listed source differences are visible in the inspected functions and types. There is no post-baseline default-branch feature delta to port.
- Source-derived, not reproduced: suggestion replacement loss, same-registration response races, dead-coordinator recovery failures, detached-process shutdown behavior, and symlink traversal. Their mechanisms are visible, but no live failure or exploit was staged.
- The available adapter and installed SDK establish what this port currently calls. They don't prove the newest OpenChamber host could never support a future model catalog, compact/pin, exact-message read, options, native file opening, or richer parentage API. Those require a separate host/API investigation before implementation.
- A single-message read, provider session options, queue-if-active delivery guarantees, and full native child supervision were not established for this adapter. No substitute behavior is claimed equivalent.
- Scope covered: upstream runtime wiring, mate/crew lifecycle, CLI and BB adapter, fleet/report assembly, settings, home/suggestion/template/file handling, watch discovery/run/queue/delivery/history, panel/card/refresh/worker/watch/file-link/send-gate UI, changelog, charter, and issue #37. Local checks followed the corresponding source and existing test expectations. Vendored UI primitives and unrelated upstream plugins weren't part of the feature comparison.

## Pinned upstream sources

[u-changelog]: https://github.com/gpambrozio/bb-plugins/blob/f2d8491208978f13a245f46a34cc195338173c0e/firstmate-crew/CHANGELOG.md#L8-L29
[u-suggestions]: https://github.com/gpambrozio/bb-plugins/blob/f2d8491208978f13a245f46a34cc195338173c0e/firstmate-crew/server/suggestions.ts#L13-L141
[u-suggestion-home]: https://github.com/gpambrozio/bb-plugins/blob/f2d8491208978f13a245f46a34cc195338173c0e/firstmate-crew/server/home.ts#L140-L193
[u-refresh]: https://github.com/gpambrozio/bb-plugins/blob/f2d8491208978f13a245f46a34cc195338173c0e/firstmate-crew/app/use-fleet.ts#L28-L69
[u-panel]: https://github.com/gpambrozio/bb-plugins/blob/f2d8491208978f13a245f46a34cc195338173c0e/firstmate-crew/app/panel.tsx#L26-L102
[u-adapter]: https://github.com/gpambrozio/bb-plugins/blob/f2d8491208978f13a245f46a34cc195338173c0e/firstmate-crew/server/bb-ports.ts#L12-L237
[u-mate]: https://github.com/gpambrozio/bb-plugins/blob/f2d8491208978f13a245f46a34cc195338173c0e/firstmate-crew/server/mate.ts#L62-L216
[u-report]: https://github.com/gpambrozio/bb-plugins/blob/f2d8491208978f13a245f46a34cc195338173c0e/firstmate-crew/server/crew-report.ts#L16-L62
[u-fleet]: https://github.com/gpambrozio/bb-plugins/blob/f2d8491208978f13a245f46a34cc195338173c0e/firstmate-crew/server/fleet.ts#L62-L274
[u-card]: https://github.com/gpambrozio/bb-plugins/blob/f2d8491208978f13a245f46a34cc195338173c0e/firstmate-crew/app/card.tsx#L93-L174
[u-send-gate]: https://github.com/gpambrozio/bb-plugins/blob/f2d8491208978f13a245f46a34cc195338173c0e/firstmate-crew/app/send-gate.ts#L1-L49
[u-watch-stop]: https://github.com/gpambrozio/bb-plugins/blob/f2d8491208978f13a245f46a34cc195338173c0e/firstmate-crew/server/watches.ts#L212-L259
[u-watch-tick]: https://github.com/gpambrozio/bb-plugins/blob/f2d8491208978f13a245f46a34cc195338173c0e/firstmate-crew/server/watches.ts#L276-L323
[u-watch-summaries]: https://github.com/gpambrozio/bb-plugins/blob/f2d8491208978f13a245f46a34cc195338173c0e/firstmate-crew/server/watches.ts#L407-L430
[u-watch-run]: https://github.com/gpambrozio/bb-plugins/blob/f2d8491208978f13a245f46a34cc195338173c0e/firstmate-crew/server/watch-run.ts#L1-L119
[u-server]: https://github.com/gpambrozio/bb-plugins/blob/f2d8491208978f13a245f46a34cc195338173c0e/firstmate-crew/server.ts#L94-L233
[u-watch-delivery]: https://github.com/gpambrozio/bb-plugins/blob/f2d8491208978f13a245f46a34cc195338173c0e/firstmate-crew/server/watch-delivery.ts#L29-L54
[u-watch-files]: https://github.com/gpambrozio/bb-plugins/blob/f2d8491208978f13a245f46a34cc195338173c0e/firstmate-crew/server/watch-files.ts#L80-L127
[u-files]: https://github.com/gpambrozio/bb-plugins/blob/f2d8491208978f13a245f46a34cc195338173c0e/firstmate-crew/server/files.ts#L31-L310
[u-worker-panel]: https://github.com/gpambrozio/bb-plugins/blob/f2d8491208978f13a245f46a34cc195338173c0e/firstmate-crew/app/crew-panel.tsx#L13-L61
[u-types]: https://github.com/gpambrozio/bb-plugins/blob/f2d8491208978f13a245f46a34cc195338173c0e/firstmate-crew/shared/types.ts#L43-L111
[u-settings-ui]: https://github.com/gpambrozio/bb-plugins/blob/f2d8491208978f13a245f46a34cc195338173c0e/firstmate-crew/app/settings-section.tsx#L24-L88
[u-settings]: https://github.com/gpambrozio/bb-plugins/blob/f2d8491208978f13a245f46a34cc195338173c0e/firstmate-crew/server/settings.ts#L14-L45
[u-cli]: https://github.com/gpambrozio/bb-plugins/blob/f2d8491208978f13a245f46a34cc195338173c0e/firstmate-crew/server/cli.ts#L167-L229
[u-charter-supervision]: https://github.com/gpambrozio/bb-plugins/blob/f2d8491208978f13a245f46a34cc195338173c0e/firstmate-crew/templates/data/charter.md#L365-L480
[u-crew]: https://github.com/gpambrozio/bb-plugins/blob/f2d8491208978f13a245f46a34cc195338173c0e/firstmate-crew/server/crew.ts#L54-L95
[u-open-file]: https://github.com/gpambrozio/bb-plugins/blob/f2d8491208978f13a245f46a34cc195338173c0e/firstmate-crew/app/use-open-home-file.ts#L10-L24
[u-watches-ui]: https://github.com/gpambrozio/bb-plugins/blob/f2d8491208978f13a245f46a34cc195338173c0e/firstmate-crew/app/watches.tsx#L75-L109
[u-note-expander]: https://github.com/gpambrozio/bb-plugins/blob/f2d8491208978f13a245f46a34cc195338173c0e/firstmate-crew/app/watch-note-expander.tsx#L40-L80
