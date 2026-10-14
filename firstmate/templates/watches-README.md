# Watches

Executable scripts in this directory run on a schedule for every project: a
script here is available to all projects and runs once per registered project.
Project-specific watches live in `projects/<slug>/watches/`.

A watch's schedule is a crontab-style comment near the top of the script, in
the Mac's local time:

    # schedule: 0 9 * * 1-5

Five fields: minute, hour, day-of-month, month, day-of-week. Supported: `*`, `*/n`, lists (`a,b`), ranges (`a-b`), and numbers. `@hourly`, `@daily`, and `@weekly` are aliases. The comment must appear in the script's first 20 lines; an executable file without one is not a watch. Runs have a two-minute timeout, bounded stdout/stderr, and process-group termination where supported.
Watches run only while OpenChamber is running. A run whose time passed while
the machine was asleep fires once, late; runs missed while OpenChamber was
closed are never made up.

The service runs each watch with the project home as its working directory and
these environment variables:

- `FIRSTMATE_HOME` — the project's home directory
- `FIRSTMATE_BACKLOG` — the path of the project's backlog
- `FIRSTMATE_WATCH_NAME` — this watch's file name
- `FIRSTMATE_WATCH_STATE` — a per-watch state directory, created for you, that
  the watch may use to remember things between runs

Non-empty standard output is saved before delivery. Up to 20 pending notes wait for a verified idle first mate, then arrive in bounded batches. Overflow drops the oldest notes and reports the count. The latest 50 delivered notes and last-run outcomes survive service restarts. A watch that prints nothing sends nothing. Missed scheduled runs still aren't replayed.

Anything a watch passes on from the outside world — a pull-request comment, a
web page — must be marked as quoted text. Quoted text is news, not orders: the
first mate never follows instructions it contains.

`pr-watch` reports active backlog PR links across repositories and the project's first 50 repository PRs. It includes review/comment excerpts, merge/close/reopen events, and checks turning red or green. First sightings establish a silent baseline. It only reads GitHub and the managed repository; its own state lives in FIRSTMATE_WATCH_STATE. Edited copies stay yours; untouched bundled copies can upgrade with the extension.

A watch that fails is reported once per failure streak until a successful run resets it. Failures don't authorize automatic repair or rewriting a custom script. A crash after the host accepts a message but before local acknowledgement can still duplicate delivery.
