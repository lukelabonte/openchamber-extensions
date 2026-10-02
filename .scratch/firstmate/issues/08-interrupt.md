# 08: Interrupt via managed-opencode abort (gated workaround)

**What to build:** Interrupt stops a worker's current turn. No SDK, control-API, CLI, or agent-tool surface exposes stop/abort (verified phase 1), so the service attempts the managed opencode server's own session.abort for the worker's directory — the call the UI's stop button makes. Discovery of the per-directory opencode connection is best-effort; when it fails, the card says Interrupt is not supported on this host instead of pretending. This ticket is isolated: its failure blocks nothing else, and if no path exists it is reported, not worked around silently.

**Blocked by:** 06 (Live board panel)

**Status:** resolved

- [ ] Service discovers the per-directory opencode endpoint and issues session.abort for the worker session
- [ ] Observed: a running worker's turn stops on Interrupt
- [ ] Discovery failure produces an explicit unsupported state on the card
- [ ] The workaround nature is stated in code comments and the panel copy
