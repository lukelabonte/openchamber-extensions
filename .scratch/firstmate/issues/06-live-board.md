# 06: Live board panel

**What to build:** The panel shows the coordinator's chat link beside a board of worker cards grouped by state, each card carrying the worker's last word and pull-request link. State is live: the panel subscribes to session snapshots for the project and pulls board data from the service; a static or stale board is a defect.

**Blocked by:** 05 (Supervision relay)

**Status:** ready-for-agent

- [ ] Columns Queued, Working, Blocked, Parked, Done, Failed, Idle; empty columns hidden
- [ ] Cards show task title, state, last word, PR link (opens externally)
- [ ] Live updates: `onSessions(projectId)` subscription refreshes card activity without reload
- [ ] Panel state reducer unit-tested; board renders from service payload + live activity
