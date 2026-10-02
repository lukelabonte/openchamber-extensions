# 01: Extension scaffold and install loop

**What to build:** The `firstmate/` extension package exists with a valid OpenChamber manifest (apiVersion 1, panel + service contributions), a build that produces the built panel and service JS, a service answering `GET /health`, and an empty board panel that renders. The folder installs into OpenChamber through Settings → Extensions and the capability approval flow, with no hand-editing of OpenChamber configuration.

**Blocked by:** None (can start immediately)

**Status:** resolved

- [ ] `firstmate/package.json` carries the `openchamber` manifest: panel (id `firstmate`, icon, `panel/index.html`), service (`service/main.js`, `runtime: "host"`, exec permissions limited to `openchamber`, `git`, `gh`, `sh`), panel capabilities `["sessions"]`
- [ ] Build produces IIFE `panel/main.js` and Node `service/main.js`; install checks pass (no `invalid-manifest` / `missing-build`)
- [ ] Service binds loopback with bearer auth and answers `GET /health` 200
- [ ] Panel mounts, applies host theme, shows an empty-board state
- [ ] Folder install via Settings → Extensions succeeds; panel opens from the rail; `serviceStatus()` reaches `ready`
