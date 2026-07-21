# Runtime debugging guide

> **Status:** active — how to diagnose a misbehaving session on either runtime.
> **Last updated:** 2026-07-06

When a user reports "Rust Pi exited unexpectedly," a blank status bar, or a session
that won't start, work the checklist for the relevant runtime. Everything the
extension logs goes to the **"Pi Code Gui" Output channel** (View → Output → pick
"Pi Code Gui"); the on-disk copy is at
`~/.vscode-server/data/logs/<session>/exthost*/NimbleTron.pi-code-gui/Pi Code Gui.log`
and captures every level regardless of the UI filter.

## Rust runtime

1. **Output channel** — look for `[rust-stderr]` lines (raw binary stderr) and any
   one-shot cards: `RPC shape may have drifted` (the binary's version differs from the
   pinned/tested one — `_shapeProbeWarned`), `find/grep tools need fd/ripgrep`
   (missing external prerequisites — `RustDeps.detectMissingTools`), or a
   degraded-capability warning (`warnDegraded` — a get_state/get_messages/get_commands
   RPC failed).
2. **Binary version** — `~/.local/bin/rust-pi --version` (or the `rustBinaryPath`
   setting). Compare to `src/rust-pi-version.json`. A mismatch is the first suspect
   for shape drift; a user-supplied binary of a different version gets a one-time
   warning.
3. **External tools** — `fd --version` and `rg --version`. rust-pi's `find`/`grep`
   tools shell out to them; missing → those tools fail mid-session.
4. **Session files** — `~/.pi/agent/sessions-rust/<encoded-cwd>/*.jsonl` (the Rust
   pool, separate from the TS pool). The `.lock` sidecar means a live/held session.
5. **Extension conflict** — a `.pi/` extension the Rust binary can't load triggers the
   `--no-extensions` self-heal (auto), or a dialog (policy `enabled`). See the
   `rustExtensionPolicy` setting.

## TypeScript runtime

1. **Output channel** — SDK resolution/load errors surface as `SdkService.initialize`
   failures (`SDK not found`, `Failed to load pi-coding-agent`, `Failed to load pi-ai`,
   `providers/all entrypoint could not load`, `No model available`). The pi-ai
   version nudge fires once if the installed SDK predates the supported version.
2. **SDK install** — `npm ls -g @earendil-works/pi-coding-agent`. A broken global
   install (missing `openai`/`@anthropic-ai/sdk`) is reported with the exact
   reinstall command.
3. **Session files** — `~/.pi/agent/sessions/<encoded-cwd>/*.jsonl` (default pool).
4. **API keys** — `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `DEEPSEEK_API_KEY` in the
   env, or a credential stored by `/login` (`~/.pi/agent/auth.json`). The API-key settings
   were removed; any legacy value now lives in SecretStorage.

## Both

- **Which runtime** — the status-bar chip (`π TS` / `π Rust`) and `PiService.runtime`.
- **Capabilities** — a feature that's missing under one runtime is usually gated by
  `BackendCapabilities` (see [runtime-selection.md](../architecture/runtime-selection.md)),
  not a bug.
- **Reproduce the init headlessly** — `sdk-service.test.ts` / `rust-service.test.ts`
  drive the real init paths with stubs; a new failure mode is worth a test there.
