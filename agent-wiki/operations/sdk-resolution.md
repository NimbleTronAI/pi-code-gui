# SDK Resolution & Initialization

> **Status:** stable

## Candidate paths: the PATH entry itself (#81)

Every candidate used to be derived from a `$PATH` entry's **parent** —
`<dirname>/lib/node_modules/…`, and on Windows `<dirname>/node_modules/…`. That
assumes the npm prefix sits one level above the binaries, which holds for
`<prefix>/bin` on POSIX and `<prefix>/npm` on Windows, and fails whenever the prefix
directory is on `PATH` itself with `node_modules` beside its binaries.

Node installed to `D:\nodejs` (npm prefix `D:\nodejs`, packages in
`D:\nodejs\node_modules`) therefore had **no candidate at all**: `dirname` gives
`D:\`, so the probe looked in `D:\lib\node_modules` and `D:\node_modules` and gave
up. The user sees "Pi coding agent SDK is not installed" while `pi --version` answers
fine in a shell — a failure that sends people to inspect their npm install rather than
the extension. nvm-windows lays the active version out the same way.

`buildPiPackageCandidates` now also probes the PATH entry itself, on **every**
platform (the layout is not Windows-specific, and a candidate that does not exist
costs one `stat`), added last within the loop so it cannot outrank a working
resolution.

> **Last updated:** 2026-08-31 — added the PATH-entry candidate (#81, shipped 0.1.12).
