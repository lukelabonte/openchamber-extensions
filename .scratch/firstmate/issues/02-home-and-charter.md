# 02: Home provisioning and charter composition

**What to build:** The service creates the first-mate home layout from shipped templates — shared root plus per-project directories — and composes the coordinator's effective instructions into the home's AGENTS.md from the four layers, lowest to highest precedence: shared charter, project charter, shared captain's orders, project captain's orders. A project file adds to or overrides the shared file of its kind. Nothing is hard-coded to a single project.

**Blocked by:** 01 (Extension scaffold and install loop)

**Status:** resolved

- [ ] Service creates `~/.config/firstmate/shared/` (charter.md, captain.md, watches/) and `projects/<slug>/` (charter.md, captain.md, backlog.md, projects.md, settings.json, briefs/, reports/, watches/) from templates, without overwriting user-edited files
- [ ] Charter composition writes the home's AGENTS.md in the specified precedence order; composition is unit-tested at the service-core seam (injected filesystem)
- [ ] Slug derivation from a project directory is deterministic and collision-tested
- [ ] Project registration refuses nothing by default: any directory becomes a manageable project home
