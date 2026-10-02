# Projects

Shipping mode for the project served by this home. Write it as exactly one field line:

- `mode: direct-PR` — the worker pushes its branch and opens a pull request
- `mode: reviewed-PR` — the worker also reviews its own diff, runs the full test suite, and waits for CI before handing over
- `mode: local-only` — no remote; the worker leaves a clean branch, landed only on the captain's word

Any of the three may carry the suffix `+yolo` (for example `mode: reviewed-PR+yolo`), which lets the first mate land green, in-scope work without asking. Landing never happens without the mode's authorization.

Until the captain sets it, this file keeps the default:

`mode: unset — ask the captain`
