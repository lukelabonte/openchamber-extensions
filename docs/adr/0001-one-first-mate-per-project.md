# ADR-0001: One first mate per project

## Status

Accepted (2026-10-01)

## Context

The original FirstMate (Paseo plugin) runs a single first mate that manages a registry of projects from one `projects.md`. The reimplementation brief instead specified multiple first mates, one per OpenChamber project, each managing only its own project, with nothing global or singleton.

## Decision

Each OpenChamber project gets its own first mate: its own coordinator session, home directory (`~/.config/firstmate/projects/<slug>/`), backlog, and worker fleet. Shared standing orders live in `~/.config/firstmate/shared/`. A first mate never touches another project's workers or state. Each project's `projects.md` is a one-entry record of that project's path and shipping mode.

## Consequences

- The coordinator's session roots at its per-project home, outside the managed repository, making the read-only rule structural (see ADR-0002).
- Context windows stay small and focused on one backlog; a failing first mate's blast radius is one project.
- A board panel opened on project X shows project X's crew, matching OpenChamber's project-centric session model.
- A task spanning two repositories must be split by hand; there is no cross-project coordination.
- `~/.config/firstmate/shared/` exists precisely to share charter and captain's orders across mates without a global coordinator.
