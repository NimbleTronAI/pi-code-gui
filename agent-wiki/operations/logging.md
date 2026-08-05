# Logging

> **Status:** stable

All diagnostic logging goes through one tiny module —
[`src/logger.ts`](https://github.com/NimbleTronAI/pi-code-gui/blob/main/src/logger.ts) —
which writes **only** to the "Pi Code Gui" Output channel
(`vscode.window.createOutputChannel("Pi Code Gui", { log: true })`, a
`LogOutputChannel`). Nothing is written to the shared Extension Host `console`.

## Why it exists

A published extension must not pollute the Extension Host `console` — that console
is shared by every installed extension, isn't level-filtered, and isn't something
the user can dial down. The `LogOutputChannel` is the idiomatic surface: it is
per-extension (View → Output → *Pi Code Gui*), timestamps and level-prefixes each
line, respects the user's chosen verbosity ("Developer: Set Log Level…"), and
persists to on-disk log files that ride along in bug reports.

## The three helpers

| Helper | Channel level | Use for |
|--------|---------------|---------|
| `piDebug(msg)` | `debug` | Routine lifecycle / diagnostic chatter — session restore, runtime detection, catalog writes, subprocess spawn/exit, "session … ready", tool selection. **Hidden at the default Info level.** |
| `piLog(msg)` | `info` | The few notable, low-volume events worth seeing by default. Reserved for the startup version banner and the rare managed-Rust-install notice. |
| `piWarn(msg)` | `warn` | Problems and recoverable failures, including the Rust binary's own stderr (`[rust-stderr] …`). Recognized extension-load failures are classified, deduped, and surfaced elegantly instead — see [Error Surfacing](error-surfacing.md). |

The guiding rule: **the Output channel stays quiet at the default Info level.**
`piLog` therefore means "worth everyone seeing"; everything operational is
`piDebug` and only appears when a user raises the log level to Debug/Trace.

## Teardown safety

The channel can be disposed out from under us during extension-host shutdown.
A single guarded `write()` helper backs all three functions: it no-ops before
`initLogger` and after `disposeLogger` (called on `deactivate`), and if a channel
method ever throws it disowns the channel rather than re-entering the global
error handlers. A log emitted outside the channel's lifetime is silently dropped
by design — there is no `console` fallback.

## Test coverage

[`src/test/unit/logger.test.ts`](https://github.com/NimbleTronAI/pi-code-gui/blob/main/src/test/unit/logger.test.ts)
(headless — `logger.ts` only type-imports `vscode`) injects a fake
`LogOutputChannel` and asserts level routing, the **never-touches-`console.*`**
regression guard, pre-init / post-dispose no-throw, and the throwing-channel
latch-off.

## Related

- [Build Pipeline](build-pipeline.md) — where the bundle that emits these logs is produced
- [PiService](../architecture/pi-service.md) — the heaviest logging caller
- [Runtime Selection](../architecture/runtime-selection.md) — the `[rust-stderr]` source
- [Error Surfacing](error-surfacing.md) — classified failures that bypass the raw `piWarn` path

> **Last updated:** 2026-06-25 — recognized extension-load failures are now
> classified/deduped/surfaced (see Error Surfacing) rather than raw-`piWarn`'d.
> **Earlier:** 2026-06-25 — initial page: console writes removed; logging routes
> solely through the `LogOutputChannel` with `piDebug`/`piLog`/`piWarn` level
> discipline (routine chatter demoted to `debug`).
