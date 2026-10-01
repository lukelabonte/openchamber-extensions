# 10: Shipping modes and landing workers

**What to build:** projects.md records the project's shipping mode: direct-PR (worker opens a PR), reviewed-PR (worker also reviews its own diff, runs the full test suite, waits for CI), local-only (no remote; clean branch; landing only on the captain's word), with an optional +yolo suffix. Merging, landing, and branch cleanup are always dispatched to a worker in its own worktree — in every mode. Without +yolo the coordinator asks for the captain's word even when CI is green. Under +yolo the coordinator dispatches a landing worker and accepts the landing only after inspecting reported evidence: the commit, the CI result, and the scope; a failed or absent CI result is not green. Every landing is recorded in the project's backlog or reports with task, commit, CI result, mode, and authorization. +yolo never authorizes discarding unlanded work.

**Blocked by:** 05 (Supervision relay)

**Status:** ready-for-agent

- [ ] Mode parsing (incl. +yolo suffix) unit-tested at the service-core seam
- [ ] Charter encodes: workers push their own branches and open their own PRs; the coordinator never force-pushes or rewrites history; landing is always a dispatched worker
- [ ] Charter encodes the +yolo evidence rule and the landing record fields
- [ ] Landing record writer is unit-tested: task, commit, CI result, mode, authorization
- [ ] reviewed-PR charter steps: self-review, full test suite, CI wait
