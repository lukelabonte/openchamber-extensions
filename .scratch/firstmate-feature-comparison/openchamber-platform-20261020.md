# OpenChamber extension platform, 2026-10-20

This research records the pre-change FirstMate baseline. The SDK and manifest were updated afterward; see [the implementation record](implementation-20261020.md).

## Decision

The useful additions since FirstMate's SDK 2.1.0 baseline are shell monitoring and stopping, device-scoped preferences, Work Status header controls, anchored previews, and safer model-generation delivery. They have shipped. Upgrading the SDK does **not** add compact/reset, session pinning, writable parent-child relationships, arbitrary provider options, message-specific opening, or single-message reads to the extension bridge. Those gaps remain in the checked 2.5.0 contract. [S1], [S2], [S3], [S4]

Prioritize `shells` if FirstMate needs worker command visibility. Keep backlog-owned membership and existing message links. Correct the supported-host declaration before treating `>=1.22.0` as a tested compatibility guarantee. No code changes or dependency upgrades were made for this research.

## Revisions and evidence boundaries

| Layer | Verified state |
|---|---|
| Local upstream checkout | `../openchamber` HEAD is `6491f51dbcf05d1e3f7f823049f5f097c96c234b`, committed 2026-10-20 12:35:43 UTC. Working tree clean before and after inspection. |
| Official remote default | GitHub identifies `openchamber/openchamber` default branch as `main`. `GET /commits/main` returned that same SHA twice during research. The local checkout is current against the official default, despite its `origin` pointing to Luke's fork. No fetch, pull, checkout, or other mutation of upstream occurred. [S5] |
| Latest released host | Stable `v2.5.0`, published 2026-10-19 16:27:09 UTC, tag commit `ad73d11a6e7cafa0880e238f92ba7cf5cf2cb1fd`. Official main is 5 commits ahead. [S6], [S7] |
| Released versus main APIs | `git diff v2.5.0 HEAD` is empty for `packages/sdk`, `packages/extensions`, `packages/ui/src/lib/guests`, `packages/ui/src/lib/integrations-catalog`, and the server's `openchamber-control` and `openchamber-sessions` directories. The pinned main citations below therefore describe released 2.5.0 for these paths. The 5 later commits concern reference-preview layout, model-picker accessibility, nested-repository UI, and GitLab clone-host matching. [S7] |
| Published SDK | npm `latest` is `@openchamber/sdk@2.5.0`. Its package version follows the host release; wire/manifest `apiVersion` remains 1. A matching SDK package does not make its methods work on an older host. [S1], [S8], [S49] |
| FirstMate source | This repo HEAD is `a72774a466e110cdb03d8f438367c2d60d798fcb`, initially clean. `firstmate/package.json` pins SDK `2.1.0` and declares host `>=1.22.0`. It already declares a background entry, native commands/actions, `sessions`, and a host-runtime service. [F1] |
| Locally installed SDK | Exact read of `firstmate/node_modules/@openchamber/sdk/package.json` returned `2.1.0`. This is local installation evidence, not a claim that the package has been upgraded. |
| Locally installed CLI package | `openchamber` resolves to `/Users/lukelabonte/.local/lib/node_modules/@openchamber/web/bin/cli.js`. Its adjacent package manifest reports `2.5.0` and SDK dependency `2.5.0`. This verifies installed files only. The running desktop/client/server version was not queried or exercised. |

FirstMate's README already records compact/reset/pin/fleet gaps, model/variant handling, native handoffs, exact message links, and project-session refresh behavior. Those are the comparison baseline, not newly proposed work. [F2]

## Shipped changes since October 3

| First released host/SDK | Addition | FirstMate relevance and constraints |
|---|---|---|
| 2.1.1, October 4 | `host.storage` with `{ scope: 'device' }`; syntax theme tokens; `setStatusControls` / `onStatusControl`; `openPopover` and `mountPopoverAnchor`. [S2], [S9] | Device storage can replace custom browser preference plumbing. Header controls can keep common actions visible in Work Status. Popovers can show worker/message previews. Check `ready.features.deviceStorage`, `statusControls`, or `popovers` before calling. Keep old-host fallbacks. |
| 2.1.1 | Agent-created sessions can return their final answer to the calling chat. [S2], [S28] | Useful coordinator dispatch behavior through the agent tool. It doesn't add native parent assignment to FirstMate's CLI create request. |
| 2.2.0, October 8 | `shells` capability with `onRunningShells`, `readShellOutput`, and `stopShell`; running and recently ended commands. [S3], [S10], [S53] | Adds native command-level visibility beyond idle/busy session polling. Requires an SDK rebuild, host >=2.2.0, manifest capability, and user approval. It does not start arbitrary shell commands. |
| 2.3.0, October 12 | Host-served SDK UI look; service/network replies up to 8,000,000 bytes, with oversize replies refused whole; complete paginated `session.messages` reads with `all`. [S11], [S12] | Reduces truncation failures in service-backed boards. Existing bundles get the host look; new SDK sizes require rebuilding. FirstMate's bounded reads should remain bounded unless full history is necessary. |
| 2.3.2, October 14 | A restarted host cleans up guest service processes left by a crash. [S13], [S14] | Useful for FirstMate's service lifecycle. Doesn't promise transactional delivery or exactly-once handoffs. |

The shell API has explicit maintainer confirmation: discussion #4416 says the implementation was merged as #4405. That is stronger evidence than an unaccepted feature request. [S10]

## Changes since October 15

| First released host | Change | Boundary |
|---|---|---|
| 2.4.0, October 17 | Integrations storefront; Resource Monitor one-click install; extensions settings card/detail layout; raised/flat SDK controls inherited from the host. [S15] | Distribution and presentation improvements. No new fleet-control contract. |
| 2.4.0 | Session pins synchronize through session metadata across devices. [S15], [S16] | A host feature. `HostClient` still has no pin operation and guest session records don't include the pin state. |
| 2.4.0 | Agent-rendered pages can wait for a user's selection. [S15] | An agent-tool facility. It isn't a new `connectHost` method. The existing-branch option for `session.moveToWorktree` had already shipped in 2.3.3 on October 14. [S17], [S51] |
| 2.5.0, October 19 | `openSurface` reports failure correctly and can open an extension panel in a no-project chat. [S6], [S18] | Relevant to `/fm-open` and extension affordances. Doesn't provide `openSession(sessionId, messageId)`. |
| 2.5.0 | `onLateGenerateResult`, advertised by `ready.features.lateGenerateResults`; generation timeout increased to 960 seconds for the guest call. [S19], [S20], [S48] | Useful only if FirstMate adopts `host.generate`. Requires `model` approval. Results are kept in the same window for the same extension, project, and surface, for 1 hour, at most 8 per extension. Not durable across app restart and not available to hidden/background frames. |
| 2.5.0 | New worktree sessions start in the project's own subdirectory of that worktree; archive/restore fixes include separately archived subsessions. [S6] | Relevant host correctness fixes. They don't create a parent setter or guaranteed FirstMate fleet tree. |

The relevant extension/control files on current main contain no additional unpublished changes beyond 2.5.0. Work on other local branches was excluded from availability claims. [S7]

## APIs for the FirstMate gaps

### Compact and same-thread reset

**Still unavailable through the extension SDK and the OpenChamber session CLI/control action list.** `HostClient` has no compact or reset method. The control allowlist includes create/send/fork/status/messages/move/link, but no compact/reset action. [S4], [S21]

The app itself can compact through its internal `opencodeClient.compactSession`, backed by OpenCode `session.compact`. This establishes that compaction exists in the underlying runtime. It does not expose it to a sandboxed extension, whose `host.request` only reaches its declared integration origin and whose `serviceRequest` only reaches its own process. [S22], [S14]

Action: retain FirstMate's explicit unsupported state. A future adapter could add a documented host operation or separately authenticated OpenCode integration, but that is new integration work. Sending an instruction to forget history or restarting in a fresh session isn't a same-thread reset.

### Session pinning

**The host gained cross-device pin persistence; the guest bridge didn't gain pin control.** Pins live under `session.metadata.openchamber.pinned`. The host uses internal `setSessionPinned`, which patches metadata. Guest `GuestSessionRecord` doesn't expose raw metadata or a pin field, and `HostClient` has no metadata writer. [S16], [S23], [S24]

There are host HTTP metadata routes, `GET` and `POST /api/openchamber/sessions/:sessionId/metadata`. These are app backend routes, outside the guest contract. They are not reachable by declaring `sessions` alone. Treat any direct use as an adapter/authentication change with its own compatibility review, not an SDK upgrade. [S25], [S14]

Action: continue to let the user pin in the host UI. Don't edit private pin storage from FirstMate.

### Host parent-child fleet

**Parent relationships are readable, not assignable through the checked extension/control contracts.** `listSessions` and `onSessions` return `parentId`, directory/worktree, activity, and outcome. They can display a native tree where the host already has one. [S23], [S26]

`StartSessionRequest` has attach fields, `projectId`, `worktree`, and `navigation`. It has no parent, model, agent, variant, or arbitrary options field. The server control create payload has model/agent/variant/worktree options but no parent field; actual session creation supplies location and title. [S27], [S28], [S29]

`returnResult: true` on an agent's create/send/fork can arrange an asynchronous answer back to its calling session. That is result delivery, not proof that the created session has native `parentID`. The CLI call FirstMate makes has no calling-session result-delivery context. [S28], [S30]

Action: preserve backlog-owned worker membership. Use `parentId` as observed metadata. Don't infer worker ownership from titles, returned answers, or shell-session scoping. The SDK only sees the connected server; it doesn't expose multi-machine dispatch. [S26]

### Message navigation and reads

**Message links already existed at the SDK 2.1.0 baseline.** The host implementation accepts `openchamber://session/<sessionId>?message=<messageId>` and same-instance web links with `session` and `message` query parameters. Message-focus requests survive timeline remounts and expire after 60 seconds. They identify a place on the same server, not a public share. [S31], [S32]

`host.openSession(sessionId)` still takes only a session ID. The extension bridge has no `openMessage` or message-specific open argument. FirstMate's existing copy/paste link approach remains supported by the source. Do not call a source-backed URL handler a new SDK method. [S4], [F2]

Two conversation access paths remain distinct:

- A user-invoked message action carries that message's ID, role, and text. A session action with `payload: ['messages']` gets exported conversation text with a separate `conversation` grant, bounded by the item limits. It is a click-time snapshot, not an unrestricted cross-session reader. [S33]
- FirstMate's service can continue using `openchamber session messages` with role/last/limit/all controls. The current server follows cursor pages; there is no message-ID selector in that control action. Bounded history must still match the requested ID and report a miss. [S11], [S34], [S50], [S52]

The app's internal OpenCode adapter **does** have `getSessionMessage(sessionId, messageID)` using `session.message.get`. Thus the precise missing capability is an exposed FirstMate/extension/control read, not an absent underlying single-message API. [S35]

### Session creation, defaults, and lifecycle

These methods already existed before October 3: `listProjects`, `listWorktrees`, `listSessions`, `onProjects`, `onWorktrees`, `onSessions`, `openSession`, and `startSession`. Workspace access landed in commit `e0cb68f` and is in host 1.24.0. Background actions landed in `ecad0a2` and are in host 1.24.1. [S36], [S37]

SDK `startSession` can target another registered project, an existing known worktree, or a named new worktree with `baseBranch`. Navigation defaults to preserving the current board. It captures the host's current model/agent/variant selection rather than accepting its own selection fields. Check `sent`, `linked`, and `sessionId`; failures can leave a worktree or a created session behind. A 180-second timeout doesn't prove rollback. [S26], [S27]

The service/CLI control route has broader options, including model, agent, variant, goals, fork message, project/directory, new worktree/branch/start ref, and pull request worktrees. These remain separate from the iframe SDK. FirstMate already uses the CLI for its coordinator model/variant. No provider-defined arbitrary options bag was found in either checked request shape. [S28], [S34], [F1], [F2]

For board refresh, `onSessions` provides loading/ready/error and per-directory coverage. Only ready establishes complete empty success. Outcomes are observed in memory, not reconstructed task completion. The simpler `onSessionLifecycle` emits started/completed/failure, where failure means unknown status rather than confirmed abort/crash. [S26], [S33]

### Native background commands and actions

FirstMate already uses the supported path: `contributes.background.entry`, native slash commands resolved through `onResolve`, and message/session actions delivered through `onAction` with `mode: 'background'`. There is no SDK upgrade prerequisite for the existing 2.1.0 implementation. [F1], [S37]

These background invocations are temporary. A fresh hidden frame gets one action, with target context captured at click time. Loading and execution together have a 20-second limit and at most 8 concurrent invocations. The host doesn't retry or undo effects accepted before a timeout. Slash-command conflicts retain the existing host/OpenCode command. They are unsuitable for the long-lived supervision loop, which belongs in the service. [S38]

The newer `shells` API watches actual agent shell commands. Session scope includes native subagents, project scope uses a registered project, and global scope includes all sessions. Each snapshot has up to 200 running shells and 200 observed ended shells. Output is paged with a cursor and a tail limit of 65,536 bytes. Ended observations are memory-only; OpenCode keeps output for its latest 25 ended commands per directory, while stopped output disappears immediately. `NOT_FOUND`, dropped output, and `unknown` endings must remain visible. [S3]

Action: a worker command drawer could use `onRunningShells({ kind: 'project', projectId }, ...)`, filter by verified backlog session IDs, and expose explicit stop controls. Stopping a process is a new destructive action and needs a deliberate user flow. This API doesn't replace worker-result validation or authorize process termination automatically.

### Settings and models

`onSettings` exposes declared integration settings only. It isn't a general host-settings or provider-configuration API. `onReady().session.model` and `.agent` are snapshots, not selectors. `generate` uses the user's Small Model and accepts prompt/system/output length, not a provider/model/options choice. [S4], [S20], [S33]

The control tool already offers `models.list` for defaults/favorites/recents and `models.search` for a directory's current catalog. Search returns opaque variant IDs, preference, status, cost, and pagination. This is a useful service-backed model-picker source; it isn't newly added since October 3 and doesn't expose arbitrary provider request settings. [S39]

Action: retain FirstMate's opaque variant forwarding. If adding a catalog picker, preserve blank/default selections and handle project-specific availability. Don't translate variants into a fixed reasoning-level enum. [F2], [S39]

### Extension service APIs

The supported guest operations remain `serviceRequest({ method, path, query?, body? })` and `serviceStatus()`. The host starts the approved service on its first request, waits for authenticated `/health`, and proxies to its loopback listener. The service runs with the user's full rights. `permissions.exec` and socket lists describe intent; they don't sandbox it. The service doesn't inherit the host's complete environment. [S14]

October improvements include 8 MB complete replies and cleanup of processes left by a crashed host. `REQUEST_FAILED` or an oversized answer can occur after the service acted, so retrying a mutating handoff may duplicate work. There is still no generic service-to-panel streaming RPC. The service guide explicitly calls streaming deferred. [S12], [S14]

`provides: ['browser']` and `surface: true` are existing specialized service facilities for browser control and host-rendered pictures with human takeover. They don't create a generic fleet API or a general plugin-owned tool-registration mechanism. [S14]

## Three catalogs with different counts

### Public extension directory

The actual official website directory at <https://openchamber.dev/extensions/> lists **32 entries** on October 20. The page says most are community-built and marks official entries. Its public listing, rather than GitHub repository search, is the evidence for membership. [S40]

| Category | Count | Listed entries |
|---|---:|---|
| Usage | 5 | DeepSeek Usage; WakaTime; Command Code Usage by dai1012; CommandCode Usage by dorne; Token Plans |
| Monitoring | 5 | TPS Monitor; MLX Scope; Live TPS; System Monitor; DCP RC Stats |
| Preview & files | 5 | Server Browser; Files; Open With; iOS Simulator; Design Studio |
| Workflow | 5 | OpenChamber Queue; OpenSpec; TTS AutoPlay; OpenChamber Kanban; Session Focus |
| DevOps | 4 | Docker; OpenChamber Makefile; GitLab Pipelines; Argo CD |
| Providers | 4 | Casleo; Claude Account Switcher; Providers; Router |
| Memory | 3 | Memory Graph UI; Magic Context; Engram |
| Themes | 1 | Everforest Theme |

Useful comparison candidates from that directory are [OpenChamber Queue](https://github.com/open-tecmz/openchamber-queue), [OpenChamber Kanban](https://github.com/mannu150/openchamber-kanban), and [Session Focus](https://github.com/richkershaw/OpenChamber-SessionFocusPanel). The directory describes project queues, task cards tied to sessions, and per-session progress respectively. Those descriptions establish listing intent only; their runtime correctness and FirstMate equivalence were not validated here. [S40]

The public directory marks Docker Official. It doesn't list Excalidraw or Resource Monitor in the fetched 32-entry page, although both exist in the app's official integration catalog. These lists have different ownership and coverage. The directory offers submission by sending a repository URL and description. It isn't an automatic npm registry. [S40], [S41]

**Historical limit:** the public page has no per-entry dates or revision identifier. Its exact count on October 3 or October 15, and which entries were added between those dates, couldn't be established from the inspected primary sources. Repository creation or update timestamps would not prove directory inclusion dates. No directory growth count is invented.

### App integrations catalog

The released app's curated `CATALOG_ENTRIES` contains **166 integrations**, including exactly **2 `kind: 'extension'` components**, Excalidraw and Resource Monitor. Claude Code and Search Providers in the OpenChamber category are OpenCode plugins. MCP servers and skills make up much of the remainder. Therefore "more than 160 services" doesn't mean 160 OpenChamber extensions. [S41], [S42]

Counts below were reproduced by reading each historical `registry.ts`, counting top-level `id` lines, and separately extracting extension components. They are source-derived counts, not install/test results.

| Commit | Registry entries | Extension components |
|---|---:|---|
| SDK baseline `v2.1.0` | Registry file absent | Not applicable |
| `1d47e6f2f`, October 15 catalog introduction | 36 | Excalidraw |
| `1779c60b0e`, October 15 expansion | 45 | Excalidraw |
| `fa464b8e93`, Dropbox/Hex addition | 47 | Excalidraw |
| `0d604407cc`, 116-entry expansion | 163 | Excalidraw |
| `b8f4e811a5`, OpenChamber category | 165 | Excalidraw; Resource Monitor |
| `eb786545d5`, Search Providers | 166 | Excalidraw; Resource Monitor |
| `v2.5.0` and checked main | 166 | Excalidraw; Resource Monitor |

The historical rows can be checked in the official [catalog introduction](https://github.com/openchamber/openchamber/commit/1d47e6f2f91d9393247459e34097494c4fc58dfc), [45-entry revision](https://github.com/openchamber/openchamber/blob/1779c60b0e2f90d636630ba0ef1525f91c7afffd/packages/ui/src/lib/integrations-catalog/registry.ts), [47-entry revision](https://github.com/openchamber/openchamber/blob/fa464b8e9327b47117c4acb00d9f03e6b6deb1f7/packages/ui/src/lib/integrations-catalog/registry.ts), [116-entry expansion](https://github.com/openchamber/openchamber/commit/0d604407ccd4493a44e98aecb89181f80ea462a2), [OpenChamber category revision](https://github.com/openchamber/openchamber/blob/b8f4e811a5c585ac4f2b1b732642ea6cea9924c9/packages/ui/src/lib/integrations-catalog/registry.ts), and [Search Providers revision](https://github.com/openchamber/openchamber/blob/eb786545d513dee779d8ab69400ae8c37c219d1c/packages/ui/src/lib/integrations-catalog/registry.ts). Author and merge/committer times can differ; these rows name commits rather than imply a precise deployment time.

Resource Monitor's dedicated Settings install card was added in `4b372db3e`, authored October 15 and committed October 16. Its current official repo is at `66c614a1e3bfe593dd20a790817b3f1549d4a8b6`, package 1.3.1, with host floor `>=2.3.3`. This is evidence of an extension service and Work Status section being distributed independently of the app. [S43], [S44]

### Built-in extension allowlist

`packages/extensions/registry.json` contains `"extensions": []`. Its README explicitly says the registry is empty and built-ins update with the app. This is a packaging allowlist, not the 32-entry public directory or the 166-entry integrations list. [S45]

## Explicit direction and roadmap

The official roadmap labels **Extensions System** shipped and describes it as adding capabilities/integrations without changing the core app. It labels **Orchestration Framework** planned, with "Declarative multi-step agent pipelines with stages, branching, and result checks." **Agents Observability Layer** is also planned, described as a control center with progress, history, errors, token usage, and results. **Accounts and Settings Sync** and **Isolated Workspaces** are in progress. [S46]

The roadmap separately labels **Multi-Agent Orchestration** shipped and defines that item as parallel agents from one prompt with isolated worktrees. That statement doesn't establish a declarative pipeline engine, a stable extension parent setter, or FirstMate's complete fleet supervisor. No ETA or extension API contract accompanies the planned orchestration/observability items. [S46]

The SDK's stated scope is a manifest/page/message/UI contract with frozen `apiVersion: 1` and methods added with releases. Services cover privileged local work. The app catalog's contribution policy explicitly includes OpenChamber's own extensions/plugins and vendor-run integrations. These are concrete extension directions backed by documentation and current code. [S49], [S14], [S42]

Two recent Ideas discussions remain proposals, with no maintainer approval in the fetched comments:

- [#4823, expose session context/usage statistics](https://github.com/openchamber/openchamber/discussions/4823), opened October 12. It requests a read-only stats API; it doesn't establish one. The checked `HostClient` and `GuestSessionRecord` still contain no usage/cost statistics. [S4], [S23]
- [#4954, chat-adjacent extension placement and addressable attachment delivery](https://github.com/openchamber/openchamber/discussions/4954), opened October 15. It discusses mini-chat persistence and session/window targeting. No comments were returned. Don't turn its proposed richer surfaces into roadmap commitments.

Inference: current investments favor host-native extension presentation, explicit permissions, and read-only projections of existing state, with local services for privileged tasks. That pattern supports a shell-aware FirstMate board. It doesn't prove the roadmap's orchestration work will absorb FirstMate or expose its missing APIs.

## Version choices and limits

1. **Keep the current feature set:** no SDK upgrade is needed solely for native commands, background actions, session subscriptions, opaque variants, or message links. The current `>=1.22.0` declaration is weaker than the demonstrated API history. Workspace access first appears in released 1.24.0; background actions first appear in 1.24.1. SDK 2.1.0 corresponds to host 2.1.0. A host floor of 2.1.0 is a conservative baseline recommendation pending live compatibility acceptance. This is not a change made by this report. [F1], [S1], [S36], [S37]
2. **Add preferences/header controls/previews:** use SDK and host >=2.1.1, check the advertised feature flags, and retain fallbacks if older hosts stay supported. [S2], [S9]
3. **Add shell-aware worker controls:** use SDK and host >=2.2.0 and request `shells`. Persist only the observations FirstMate needs; memory-only ended lists are not durable job history. [S3], [S53]
4. **Adopt the current released SDK:** SDK 2.5.0 provides all additions researched here. Use a host >=2.5.0 for late-generation retention and corrected `openSurface` behavior. A bare dependency bump won't close compact/reset/pin/parent/message-read gaps. [S4], [S6], [S19]

Extensions still load in web and desktop only. Mobile and VS Code being supported OpenChamber clients doesn't mean those clients load third-party extensions. FirstMate's host service still needs a supported web/desktop extension host. [S1], [S14]

Live documentation has drift: the SDK README links to `openchamber.dev/docs/sdk/...`, but those fetched URLs returned the marketing homepage. The current documentation is at `docs.openchamber.dev/sdk/...`. The fetched live Host API page still says generation waits 90 seconds and omits some newer methods, while pinned source and package API reference describe 960 seconds and late-result delivery. Availability decisions above use release evidence plus the checked source contract. [S1], [S20], [S47], [S48]

No live-host acceptance, builds, installs, dependency changes, service launches, authentication reads, or external writes were performed. GitHub and npm queries were read-only. Only this note was written. Directory historical growth and running host identity remain unverified.

## Sources

[F1]: https://github.com/lukelabonte/openchamber-extensions/blob/a72774a466e110cdb03d8f438367c2d60d798fcb/firstmate/package.json#L11-L46
[F2]: https://github.com/lukelabonte/openchamber-extensions/blob/a72774a466e110cdb03d8f438367c2d60d798fcb/firstmate/README.md#L11-L42
[S1]: https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/sdk/README.md#L3-L27
[S2]: https://github.com/openchamber/openchamber/releases/tag/v2.1.1
[S3]: https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/sdk/API.md#L222-L244
[S4]: https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/sdk/src/host.ts#L98-L219
[S5]: https://api.github.com/repos/openchamber/openchamber/commits/main
[S6]: https://github.com/openchamber/openchamber/releases/tag/v2.5.0
[S7]: https://github.com/openchamber/openchamber/compare/ad73d11a6e7cafa0880e238f92ba7cf5cf2cb1fd...6491f51dbcf05d1e3f7f823049f5f097c96c234b
[S8]: https://registry.npmjs.org/@openchamber%2Fsdk/latest
[S9]: https://github.com/openchamber/openchamber/commit/97ee95fdcf9f467137becbfbc3de49173a6944c9
[S10]: https://github.com/openchamber/openchamber/discussions/4416#discussioncomment-18766103
[S11]: https://github.com/openchamber/openchamber/releases/tag/v2.3.0
[S12]: https://github.com/openchamber/openchamber/commit/7a7022ef1b472840af878f4c68b2e3756e0e0c0f
[S13]: https://github.com/openchamber/openchamber/releases/tag/v2.3.2
[S14]: https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/sdk/GUEST_SERVICES.md#L15-L179
[S15]: https://github.com/openchamber/openchamber/releases/tag/v2.4.0
[S16]: https://github.com/openchamber/openchamber/commit/9cc67436ef885f9532acf8f7d0482ef41ae22d85
[S17]: https://github.com/openchamber/openchamber/commit/364087ea21dad10827e4adc9a1553f19f668b357
[S18]: https://github.com/openchamber/openchamber/commit/fc09cb14b9c008f6fcc77f32e5e61887a39e7fa6
[S19]: https://github.com/openchamber/openchamber/commit/0fd3535e97730272569074e4d73c28ab9a23d153
[S20]: https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/sdk/API.md#L290-L298
[S21]: https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/web/server/lib/openchamber-control/actions.js#L10-L30
[S22]: https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/ui/src/lib/opencode/client.ts#L1527-L1544
[S23]: https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/sdk/src/workspace.ts#L3-L39
[S24]: https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/ui/src/sync/session-actions.ts#L1206-L1224
[S25]: https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/web/server/lib/openchamber-sessions/routes.js#L1322-L1406
[S26]: https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/sdk/API.md#L194-L220
[S27]: https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/sdk/src/contract.ts#L359-L382
[S28]: https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/web/server/lib/openchamber-control/service.js#L500-L642
[S29]: https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/web/server/lib/openchamber-sessions/routes.js#L250-L285
[S30]: https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/docs/content/docs/agent-control-tool.mdx#L8-L34
[S31]: https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/ui/src/lib/sessionLinks.ts#L3-L79
[S32]: https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/ui/src/lib/router/messageFocus.ts#L1-L68
[S33]: https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/sdk/API.md#L61-L136
[S34]: https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/web/bin/lib/commands-session.js#L130-L301
[S35]: https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/ui/src/lib/opencode/client.ts#L1150-L1154
[S36]: https://github.com/openchamber/openchamber/commit/e0cb68fc649ca71dd68261da705a878f0a9f3724
[S37]: https://github.com/openchamber/openchamber/commit/ecad0a2db1aa04c2e1b8f7d452233e9d5dbf1bed
[S38]: https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/sdk/API.md#L276-L288
[S39]: https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/web/server/lib/openchamber-control/service.js#L322-L397
[S40]: https://openchamber.dev/extensions/
[S41]: https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/ui/src/lib/integrations-catalog/registry.ts#L2456-L2509
[S42]: https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/ui/src/lib/integrations-catalog/DOCUMENTATION.md#L1-L34
[S43]: https://github.com/openchamber/openchamber/commit/4b372db3eafd7b41db1f6fc193735cb762c25eba
[S44]: https://github.com/openchamber/openchamber-resource-monitor/blob/66c614a1e3bfe593dd20a790817b3f1549d4a8b6/package.json#L1-L50
[S45]: https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/extensions/README.md#L11-L17
[S46]: https://openchamber.dev/roadmap/
[S47]: https://docs.openchamber.dev/sdk/host/
[S48]: https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/sdk/src/contract.ts#L415-L438
[S49]: https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/sdk/README.md#L265-L267
[S50]: https://github.com/openchamber/openchamber/blob/6491f51dbcf05d1e3f7f823049f5f097c96c234b/packages/web/server/lib/openchamber-control/service.js#L982-L994
[S51]: https://github.com/openchamber/openchamber/releases/tag/v2.3.3
[S52]: https://github.com/openchamber/openchamber/commit/e7999bb0321b71dc773b68d9e6b6d0f23e7f57f2
[S53]: https://github.com/openchamber/openchamber/releases/tag/v2.2.0
