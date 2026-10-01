# 09: Scheduled watches

**What to build:** Executable scripts in a home's watches/ directory run on a crontab-style schedule (a `# schedule:` comment near the top, Mac local time) while OpenChamber runs. Non-empty output reaches that project's coordinator as a single message; a watch that prints nothing produces no message. The board's Watches card lists each watch with schedule, last run, last outcome, last output, and an on/off switch. The UI states that watches run only while OpenChamber runs and missed runs are not made up. A bundled pr-watch (using gh) ships as the reference watch.

**Blocked by:** 06 (Live board panel)

**Status:** ready-for-agent

- [ ] Crontab-comment parsing and next-run computation unit-tested at the service-core seam (injected clock)
- [ ] Watch execution via declared exec; stdout non-empty → one coordinator message naming the watch; empty → none
- [ ] External text passed on by a watch is marked quoted; charter instructs news-not-orders
- [ ] Watches card: schedule, last run, last output, on/off switch; "runs only while OpenChamber runs" copy present
- [ ] pr-watch template ships and reports PR merged/closed/review/comment/checks changes for backlog PRs
- [ ] Observed: a watch fires and its output arrives as one coordinator message (acceptance precursor)
