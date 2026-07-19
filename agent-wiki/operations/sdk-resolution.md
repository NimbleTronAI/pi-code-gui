# SDK Resolution & Initialization

> **Status:** evolving

SDK Resolution & Initialization (`src/pi-service.ts` — `resolvePiPackagePath()`,
`PiService.checkInstall()`, and `PiService.initialize()`) is the startup sequence
that locates the Pi coding agent SDK on disk and creates an operational agent
session. It is the most complex code path in the extension — failure at any
of 11 steps must be communicated cleanly to the user.

## Why it exists

The Pi SDK (`@earendil-works/pi-coding-agent`) is not bundled with the
extension. It lives in the user's global npm install, an nvm-managed Node
version, or a project-local `.pi/npm/` directory. The extension must find it,
verify its integrity, load its modules, and construct a full agent session
before any chat interaction can begin.

## The 11-step init sequence

1. **Resolve SDK path** — `resolvePiPackagePath()` searches candidates:
   project-local `.pi/npm/`, global npm (`~/.npm-global/`, `~/.local/`),
   nvm versions directories, Windows `%APPDATA%/npm`. Returns the first
   directory containing a `package.json`.

2. **Load SDK module** — Dynamic `import()` of `dist/index.js`, using a file URL
   on Windows so absolute paths work with native ESM. PiService no longer imports
   the `pi-ai` root module directly because SDK 0.80 removed its legacy global
   model lookup and completion exports.

3. **Load Typebox** — Dynamic import of `typebox/build/index.mjs` for
   `defineTool()` type schemas.

4. **Runtime services and extensions** — Create `ModelRuntime` and
   `SettingsManager`, apply runtime API key overrides, then call SDK 0.80's
   `createAgentSessionServices()`. Its ResourceLoader injects VS Code context and
   custom prompts, loads package extensions, applies pending provider
   registrations, and refreshes ModelRuntime before model selection.

5. **Pick a model** — Resolve defaults only after dynamic providers exist. The
   priority is Pi Code Gui's configured provider/model, Pi's SettingsManager
   default, then the first available model. Apply the context budget override.
   Scoped models are resolved through ModelRuntime with unresolved entries
   omitted. An unavailable configured GUI default is logged explicitly.

6. **Resource reporting** — Cache the ResourceLoader returned by the service
   factory and log its discovered skills and diagnostics. The same coherent
   service set is reused when creating the AgentSession.

7. **Build tools** — Combine SDK's `createCodingTools()` with bridge tools
   from `createBridgeTools()`.

8. **Session manager** — `SessionManager.open()` for explicit path,
   `SessionManager.create()` for fresh sessions, or
   `SessionManager.continueRecent()` for restore. Applies custom `sessionDir`
   from VS Code settings. All subsequent model, thinking, and Pi Code Gui
   metadata writes go through SessionManager APIs; direct `.jsonl` appends are
   forbidden because they can create a fresh file before its session header.

9. **Restore model/thinking** — Walk session entries in reverse to find the
   last `model_change` and `thinking_level_change` entries. Resolve model
   against registry.

10. **Create agent session** — `SDK.createAgentSessionFromServices()` with the
    already-loaded service set, selected model/thinking level, tools, session
    manager, and resolved scoped models. This prevents provider discovery from
    occurring after model selection.

11. **Bind extensions & emit history** — Subscribe to agent events, bind
    extension UI context, emit initial message history (with batch-start/end
    wrappers), report status, emit scoped models and settings.

## Error handling

Each step returns `{ success: false, error: "..." }` on failure. The caller
(`initSessionInBackground` in `extension.ts`) posts error messages to the
webview, shows VS Code error notifications with action buttons (Install Pi,
Retry, Learn More), and updates the tree view to reflect the failure state.

## Related

- [PiService](../architecture/pi-service.md) — owns this initialization sequence
- [Session Window](../architecture/session-window.md) — calls initSessionInBackground
- [Build Pipeline](build-pipeline.md) — how the extension itself is built

> **Last updated:** 2026-07-19 — moved provider loading before default-model resolution using SDK 0.80 service factories
