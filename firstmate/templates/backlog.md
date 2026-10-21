# Backlog

Every task for this project: queued, in flight, and done. The board reads this file.

## Entry format

One task per entry: a `- ` bullet with the task title, then indented `key: value` lines. Keep the id and title immutable. Use distinct ids and titles for new tasks; progress belongs in fields and durable outcomes, not title suffixes.

```markdown
- Add dark mode
  id: add-dark-mode
  kind: ship
  state: Blocked
  hold: captain's word to land the reviewed head
  review-head: 1a2b3c4d5e6f78901a2b3c4d5e6f78901a2b3c4d
  actions: Land => Approve landing task add-dark-mode at head 1a2b3c4d5e6f78901a2b3c4d5e6f78901a2b3c4d from https://github.com/example/sunrise/pull/12 | Keep open => Keep task add-dark-mode and https://github.com/example/sunrise/pull/12 on hold
  session: ses_8f3a21
  worktree: /repos/sunrise/.worktrees/fm/add-dark-mode
  branch: fm/add-dark-mode
  start-ref: 0123456789abcdef0123456789abcdef01234567
  pr: https://github.com/example/sunrise/pull/12
  created: 2026-10-01T09:30:00Z
  updated: 2026-10-01T09:45:00Z

- Audit dark mode contrast
  id: audit-dark-mode-contrast
  kind: scout
  state: Queued
  blocked-by: add-dark-mode
  created: 2026-10-01T09:35:00Z
  updated: 2026-10-01T09:35:00Z

- Choose cache policy
  id: choose-cache-policy
  kind: captain
  state: Blocked
  hold: choose whether this project caches scout findings
  actions: Reuse => For task choose-cache-policy, reuse dated findings after checking their evidence still applies | Fresh => For task choose-cache-policy, commission a fresh scout when prior evidence no longer applies
  created: 2026-10-01T09:40:00Z
  updated: 2026-10-01T09:40:00Z
```

The keys, exact spelling:

```text
state:       Queued | Working | Blocked | Parked | Done | Failed | Idle (required)
id:          stable path-safe task slug, at most 64 characters
kind:        ship | scout | captain
blocked-by:  the id of one prerequisite task
hold:        the concrete gate awaiting the captain's answer
review-head: the exact full reviewed PR head SHA
actions:     Label => <standalone prompt> | Other => <standalone prompt>
session:     the worker's session id
archive-session: the exact current worker session id to retire after checked completion
worktree:    the worker's worktree directory
branch:      the worker's branch
start-ref:   the exact commit SHA the worker started from
pr:          the full pull-request URL, once one exists
created:     ISO 8601 timestamp when the task entered the backlog
updated:     ISO 8601 timestamp when the task record last changed
```

`state:` remains the only required field for backward compatibility. Existing entries without the new fields stay valid. For new tasks, record `id:`, `kind:`, `state:`, `created:`, and `updated:` before dispatch. Use lowercase letters, digits, and single hyphens for new ids, such as `fix-flaky-login`. Assign an id once when an older task needs a dependency or decision. Never derive a new identity from each worker session or rename an id on relaunch or Scout-to-Ship promotion.

Write optional fields only when they exist. Omit them rather than leaving empty values. The state field drives the board; section headings are for human eyes. Unknown keys, repeated keys, and indented prose or nested bullets make an entry unreadable. Keep detail, authorization history, reproduction evidence, and outcome artifact links in `briefs/<id>.md` and `reports/<id>.md`, not extra backlog fields.

`blocked-by:` references one other task's stable id, not its title or session. Release that dependency only after its blocker is evidence-backed `Done`: verified landing for Ship, inspected report for Scout, or recorded captain answer for a decision. Idle workers, open PRs, and recommendations don't unblock work. Missing blockers, self-dependencies, and cycles stay blocked for reconciliation. A cleared dependency doesn't clear a separate hold.

`hold:` gates only the named action. A task can keep working on already-authorized scope while landing is held. Every hold needs `actions:` with distinct short labels and standalone prompts. Every answer must include the explicit task id and, for landing, the full PR URL and reviewed head. Use ` | ` between actions and ` => ` between a label and prompt; avoid either delimiter inside labels or prompts. Keep the entire field on one line.

Remove `hold:` and `actions:` only after interpreting the captain's actual answer and recording its authorized scope in the outcome. Keep or rewrite a hold for remaining gates; clicking an action or receiving `/decision` isn't itself proof of approval. Handoff-origin holds override `+yolo` and remain until the captain approves the current work in the FirstMate chat. If the reviewed head moves, renew review and authorization rather than silently updating an old approval.

Use `kind: captain` for one real decision gate, not a worker. Keep it Queued or Blocked while the answer is pending. Mark it Done only after its recorded answer resolves the gate. A Scout reaches Done after its report is checked; an authorized promotion reuses its id and title, changes its kind to Ship, and reopens its state without losing the earlier findings.

`archive-session:` is an explicit request, not a completion flag. Follow the charter's finishing and preservation rules before adding it. For example, `archive-session: ses_8f3a21` requests retirement of that session only, never a future replacement. Omit it while a worker is still needed. Remove it when reopening or relaunching the task. The backlog entry and saved report remain after archival.

Legacy minimal entries still parse:

```markdown
- Existing queued task
  state: Queued
  created: 2026-10-01T09:30:00Z
  updated: 2026-10-01T09:30:00Z
```

## Queued

## In flight

## Done
