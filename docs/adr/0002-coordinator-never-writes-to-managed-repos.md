# ADR-0002: The coordinator never writes to managed repositories

## Status

Accepted (2026-10-01)

## Context

A first mate supervises workers that mutate repositories. If the coordinator could also mutate them, a confused or prompt-injected coordinator could silently change code, merge branches, or discard work without the audit trail a worker provides (its own session, worktree, branch, and brief).

## Decision

The coordinator performs no repository mutation, ever. Its session's working directory is its home (`~/.config/firstmate/projects/<slug>/`), not the managed repository, so the rule is structural rather than instructional. All repository writes — merging, landing, branch cleanup — are dispatched to a worker operating in its own worktree, in every shipping mode including `+yolo`. Managed projects are read-only to the coordinator.

## Consequences

- Every repository change carries a worker's audit trail: brief, session, branch, and report.
- Merging never happens without the captain's explicit word, except `+yolo` landing of green, in-scope work — and even then a dispatched landing worker performs the merge and the coordinator accepts it only after inspecting the reported evidence (commit, CI result, scope).
- The coordinator cannot self-heal a broken repo state; it must brief a worker to do it. This is intentional friction.
- Phase-1 verification must name the exact OpenChamber mechanism that roots a session's directory, since the design depends on it.
