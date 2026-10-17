# Runtime debugging guide

> **Status:** active — how to diagnose a misbehaving session on either runtime.
> **Last updated:** 2026-10-17 — the shape-drift card no longer fires on `model: null` (no model resolved); a new session whose configured default can't be resolved — including one the binary rejects at spawn — now falls back to a substitute, says so, and offers to update the default; the runtime-identity block's model line is the launch model, not the current one; a key-only miss tells you how to fix it, injected SecretStorage keys count as credentials, and a rejected models.json is not mistaken for a stale default
> **Earlier:** 2026-07-06

When a user reports "Rust Pi exited unexpectedly," a blank status bar, or a session
that won't start, work the checklist for the relevant runtime. Everything the
extension logs goes to the **"Pi Code Gui" Output channel** (View → Output → pick
"Pi Code Gui"); the on-disk copy is at
`~/.vscode-server/data/logs/<session>/exthost*/NimbleTron.pi-code-gui/Pi Code Gui.log`
and captures every level regardless of the UI filter.

## Rust runtime

1. **Output channel** — look for `[rust-stderr]` lines (raw binary stderr) and any
   one-shot cards: `RPC shape may have drifted` (a get_state key every tested binary
   carries is absent, or `model` has the wrong shape — `getStateMissingFields`,
   `_shapeProbeWarned`; the card names the missing fields), `find/grep tools need fd/ripgrep`
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
5. **No model / substituted model** — when `--model` names nothing the binary knows,
   0.8.0's get_state still sends every key, with `model: null` and `thinkingLevel` set
   (black-box probe, 2026-10-17). That is not drift. The log shows `Rust session has no
   resolved model (configured: P/I)`. Init then switches to a substitute (same provider
   first, else the first model of the credential-scoped list — the full list when no
   credential is detectable), for a resumed session or for a new session
   with a configured default, and posts a warning card naming the substitute.
   The new-session card says whether the default is gone from the catalog or its provider
   has no credential. A non-modal notification offers `★ Save "P/I" as default` /
   `Keep "…" as default`. Nothing is written unless Save is clicked. The write goes to the
   workspace when either key has a workspace value (otherwise user settings), and only
   while the default is still the stale one. A configured default that IS listed (get_state
   merely reported no model) is re-selected quietly, with no notice and no offer.
   If the switch fails, the log shows `Substitution to P/I failed: <reason>`, and the one
   "can't run" card carries the same reason.
   Some stale defaults never reach get_state: 0.8.0 **exits rc 1 at spawn** with
   `No API key found for provider P. …` or `Model P/I not found` (probed 2026-10-17).
   `classifyStaleDefaultExit` recognises exactly those two (matched to the configured pair,
   by equality); init then retries ONCE without `--provider/--model` (log: `Rust start failed
   on the configured default …; retrying once`). With no flags the binary comes up on its own
   built-in default, so the substitution above is forced: never the rejected default, and
   after a missing key never that provider nor an unscoped list. After a missing-key exit
   the notice is shown but no offer is made to overwrite the default (the key may exist on
   another machine; 0.8.0 omits key-based providers that have no key from its model list, so
   the catalog can't tell); the notice says to add a key for that provider or change
   `pi-code-gui.defaultModelProvider` and `pi-code-gui.defaultModelId` (the binary checks
   `--provider` first, so changing only the id repeats the exit; with no provider set, only the id). A key the extension injects from SecretStorage (the Anthropic
   and OpenAI keys) counts as a credential for the substitute and for the model picker.
   If no substitute works, the start fails with both causes named. Any other startup exit is
   not retried — including `Model … not found` when stderr also carries
   `Warning: models.json error:` or its `File: …/models.json` line (the binary rejected the whole file, so the error shown is the
   file's, not a stale default).
   The `--append-system-prompt` runtime-identity block is fixed at spawn: its model line is
   the model *requested at launch* (none for a resumed session or the retry) and says the
   chat/status bar is current. On the TypeScript runtime the block is built at the SDK
   loader's reload (pi-coding-agent 1.3.0), not per turn — so it carries the same caveat.
6. **Extension conflict** — a `.pi/` extension the Rust binary can't load triggers the
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
