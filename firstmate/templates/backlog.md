# Backlog

Every task for this project: queued, in flight, and done. The board reads this file.

## Entry format

One task per entry: a `- ` bullet with the task title, then indented `key: value` lines.

```
- Add dark mode
  state: Working
  session: ses_8f3a21
  worktree: /repos/sunrise/.worktrees/fm/dark-mode
  branch: fm/dark-mode
  start-ref: 1a2b3c4d
  pr: https://github.com/example/sunrise/pull/12
  created: 2026-10-01T09:30:00Z
  updated: 2026-10-01T09:45:00Z
```

The keys, exact spelling:

```
state:      Queued | Working | Blocked | Parked | Done | Failed | Idle   (required)
session:    the worker's session id
worktree:   the worker's worktree directory
branch:     the worker's branch
start-ref:  the commit sha the worker started from
pr:         the pull-request url, once one exists
created:    ISO 8601 — when the task entered the backlog
updated:    ISO 8601 — when the task last changed state
```

`state:` is required; write the others when they exist. A task with no worker yet carries only `state:`, `created:`, and `updated:`. The `state:` field is what the board reads — the section headings below are for human eyes. No other keys are recognized: an unrecognized key makes the whole entry unreadable to the board, on purpose. So does any indented line that is not a `key: value` field — including nested bullets — and so does repeating a key within one entry.

## Queued

## In flight

## Done
