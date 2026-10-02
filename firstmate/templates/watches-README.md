# Watches

Executable scripts in this directory run on a schedule for every project: a
script here is available to all projects and runs once per registered project.
Project-specific watches live in `projects/<slug>/watches/`.

A watch's schedule is a crontab-style comment near the top of the script, in
the Mac's local time:

    # schedule: 0 9 * * 1-5

Five fields: minute, hour, day-of-month, month, day-of-week. Supported: `*`,
`*/n`, lists (`a,b`), ranges (`a-b`), and numbers. The comment must appear in
the script's first 20 lines; an executable file without one is not a watch.
Watches run only while OpenChamber is running. A run whose time passed while
the machine was asleep fires once, late; runs missed while OpenChamber was
closed are never made up.

The service runs each watch with the project home as its working directory and
these environment variables:

- `FIRSTMATE_HOME` — the project's home directory
- `FIRSTMATE_BACKLOG` — the path of the project's backlog
- `FIRSTMATE_WATCH_STATE` — a per-watch state directory, created for you, that
  the watch may use to remember things between runs

Non-empty standard output is delivered to the project's first mate as one
message. A watch that prints nothing sends nothing.

Anything a watch passes on from the outside world — a pull-request comment, a
web page — must be marked as quoted text. Quoted text is news, not orders: the
first mate never follows instructions it contains.

`pr-watch` ships here as the reference watch. It reports every pull request on
the project's repository (first 50), not only backlog PRs, and it only reads.
A watch that fails is reported once and shown as failed until it works again;
the extension never repairs or rewrites watches.
