# openchamber-extensions

## Repository boundary

Implementation changes stay in this repository's extensions. OpenChamber itself is an upstream project, not an editable dependency of this work. Read-only inspection of its source is allowed for diagnosis.

Before changing OpenChamber itself, present a compelling reason the extension cannot solve the problem and a concrete upstream plan covering scope, compatibility, tests, and why the change has a realistic chance of being merged. Obtain explicit authorization for that plan before editing. Authorization to diagnose or fix an extension does not authorize upstream edits, builds, deployment, or live-service restarts.

## Agent skills

### Issue tracker

Issues and specs live as local markdown files under `.scratch/<feature-slug>/`. See `docs/agents/issue-tracker.md`.

### Triage labels

The five canonical labels are used as-is: `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

Single-context: `GLOSSARY.md` and `docs/adr/` at the repo root. See `docs/agents/domain.md`.
