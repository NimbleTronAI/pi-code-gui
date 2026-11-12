# Debugging a session

> **Status:** active — how to diagnose a misbehaving session.
> **Last updated:** 2026-11-12 — Second runtime removed (0.2.8): one runtime, so the second runtime's checklist, the capability gating note and the runtime chip are gone.
> **Earlier:** 2026-10-17 — Diagnostics for model substitution and stale defaults (removed with the second runtime).

When a user reports a blank status bar or a session that won't start, work this
checklist. Everything the extension logs goes to the **"Pi Code Gui" Output channel**
(View → Output → pick "Pi Code Gui"); the on-disk copy is at
`~/.vscode-server/data/logs/<session>/exthost*/NimbleTron.pi-code-gui/Pi Code Gui.log`
and captures every level regardless of the UI filter.

1. **Output channel.** SDK resolution and load errors surface as `SdkService.initialize`
   failures (`SDK not found`, `Failed to load pi-coding-agent`, `Failed to load pi-ai`,
   `providers/all entrypoint could not load`, `No model available`). The pi-ai
   notice fires once per window: a warning below the supported floor, a nudge when behind
   the version the bundled catalog was generated from.
2. **SDK install.** `npm ls -g @earendil-works/pi-coding-agent`. A broken global
   install (missing `openai`/`@anthropic-ai/sdk`) is reported with the exact
   reinstall command. How the extension finds the package is in
   [SDK Resolution](sdk-resolution.md).
3. **Session files.** `~/.pi/agent/sessions/<encoded-cwd>/*.jsonl` (default pool), or the
   folder named by `pi-code-gui.sessionDir`.
4. **API keys.** `ANTHROPIC_API_KEY` / `OPENAI_API_KEY` / `DEEPSEEK_API_KEY` in the
   env, or a credential stored by `/login` (`~/.pi/agent/auth.json`). The API-key settings
   were removed; any legacy value now lives in SecretStorage.
5. **A model is missing.** The model list is the SDK's `ModelRuntime` view of the user's
   `models.json` and credentials; see [Model Catalog](../architecture/model-catalog.md).
6. **A tab closed itself on reload.** A tab saved by 0.2.7 or earlier for a retired runtime is
   closed on restore, with a message and a log line naming its session file. The file is
   untouched.
7. **Reproduce the init headlessly.** `sdk-service.test.ts` drives the real init path with
   stubs; a new failure mode is worth a test there.
