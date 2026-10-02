# 05: Supervision relay

**What to build:** The service polls each worker's session status and messages via the CLI; when a worker finishes, fails, or waits on a question or permission, the service forwards one message to the coordinator session. The service exposes board data (workers, states, last word, PR link) to the panel over its loopback API. Dispatch semantics are honest: no completion push exists, polling owns detection.

**Blocked by:** 04 (Worker spawning tracer)

**Status:** resolved

- [ ] Poller maps worker session activity/outcome to board states (Queued, Working, Blocked, Parked, Done, Failed, Idle); mapping unit-tested at the service-core seam
- [ ] Finish/failure/waiting events reach the coordinator as a single message each; runtime-verify send-to-busy behavior (queue vs error) and handle whichever is true
- [ ] Board data endpoint returns each worker's last assistant text and recorded PR link
- [ ] A worker the captain prompted by hand is detected on the next poll and adopted into supervision
