# 11: Extras — suggestions, /bearings, /ahoy

**What to build:** The first mate keeps a suggestions.md (one `- <label> :: <what to send>` per line); the board turns it into buttons that send the request immediately, with a trash button to dismiss. /bearings reports what needs the captain's call, what landed, what is under way, and what is next — `file` also writes a dated report into the home's reports/. /ahoy summarizes what happened since the last exchange, then every open decision with a recommendation.

**Blocked by:** 06 (Live board panel)

**Status:** ready-for-agent

- [ ] Suggestion buttons render from suggestions.md via the service; pressing one sends it to the coordinator; trash removes it
- [ ] /bearings and /ahoy available as panel actions that compose and send the corresponding request
- [ ] Charter documents the suggestions file format and the two reports' sections
