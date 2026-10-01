# 03: First-mate launch and registration

**What to build:** From the panel, on an OpenChamber project with no first mate, the captain presses Launch; the service provisions the home, composes AGENTS.md, creates the coordinator session rooted at the home (never the managed repository) via the openchamber CLI, and records the slug ↔ project directory ↔ coordinator session id index in extension storage. The panel then shows the coordinator chat link and empty board for that project.

**Blocked by:** 02 (Home provisioning and charter composition)

**Status:** ready-for-agent

- [ ] Panel offers Launch when the open project (from host context directory) has no first mate
- [ ] Service creates the coordinator session with its directory set to the per-project home; runtime-verifies `session create --dir` on a non-git, unregistered directory
- [x] Index persisted as `registry.json` under the firstmate home root by the service (slug → project dir, home dir, coordinator session id); survives host restart. Amended: the ticket said `host.storage`, but that is a panel-side SDK surface the service process cannot reach; the service owns the index on disk. The coordinator session id is also recorded in the project home's settings.json so a lost registry can be rebuilt.
- [ ] Launch is idempotent: an existing first mate for the project is adopted, not duplicated
- [ ] Missing `openchamber` CLI produces a plain-language panel notice
