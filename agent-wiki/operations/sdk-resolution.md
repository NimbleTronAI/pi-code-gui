# SDK Resolution & Initialization

> **Status:** evolving
> **Last updated:** 2026-07-20 — migrated to pi-coding-agent ≥ 0.80.8 `ModelRuntime` (removed `AuthStorage`/`ModelRegistry`); steps 4/5/9/10 updated + new "SDK version compatibility" section (incl. the OAuth-not-live-verified caveat).

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

2. **Load SDK modules** — Dynamic `import()` of `dist/index.js` (PiSdk)
   and `node_modules/@earendil-works/pi-ai/dist/index.js` (PiAi). Catches
   missing dependency errors (openai, @anthropic-ai/sdk) with specific fix
   instructions.

3. **Load Typebox** — Dynamic import of `typebox/build/index.mjs` for
   `defineTool()` type schemas.

4. **Model runtime (auth + models)** — `await ModelRuntime.create()` (the unified
   async auth+model facade; see "SDK version compatibility" below), apply runtime API
   key overrides from VS Code settings (`await modelRuntime.setRuntimeApiKey(...)`),
   create `SettingsManager`.

5. **Pick a model** — Try `await modelRuntime.getAvailable()` first (respects API
   keys), fall back to `modelRuntime.getModel()` and `AI.getModel()` for built-in
   models. Apply user's default model from VS Code settings if configured.
   Apply context budget override.

6. **ResourceLoader** — Build custom system prompt with VS Code context,
   inject virtual context files (`/virtual/vscode-guidelines.md`,
   `/virtual/project-stack-typescript.md`), register custom slash commands
   (`/fix-diagnostics`, `/explain-code`, `/refactor`). Reload to discover
   skills and prompts.

7. **Build tools** — Combine SDK's `createCodingTools()` with bridge tools
   from `createBridgeTools()`.

8. **Session manager** — `SessionManager.open()` for explicit path,
   `SessionManager.create()` for fresh sessions, or
   `SessionManager.continueRecent()` for restore. Applies custom `sessionDir`
   from VS Code settings.

9. **Restore model/thinking** — Walk session entries in reverse to find the
   last `model_change` and `thinking_level_change` entries. Resolve model
   via `modelRuntime.getModel()`.

10. **Create agent session** — `SDK.createAgentSession()` with all
    configuration: model, thinking level, `modelRuntime` (carries auth + the
    catalog), tools, resource loader, settings manager, session manager, scoped
    models.

11. **Bind extensions & emit history** — Subscribe to agent events, bind
    extension UI context, emit initial message history (with batch-start/end
    wrappers), report status, emit scoped models and settings.

## Error handling

Each step returns `{ success: false, error: "..." }` on failure. The caller
(`initSessionInBackground` in `extension.ts`) posts error messages to the
webview, shows VS Code error notifications with action buttons (Install Pi,
Retry, Learn More), and updates the tree view to reflect the failure state.

## SDK version compatibility (ModelRuntime, pi-coding-agent ≥ 0.80.8)

**0.80.8 was a breaking redesign** (its CHANGELOG: "Unified model runtime and
provider authentication"). It **removed the `AuthStorage` export and
`ModelRegistry.create(auth)`** and replaced both with a single **async
`ModelRuntime`**. On the removed API the extension died at init with
`Auth/registry setup failed: Cannot read properties of undefined (reading 'create')`
(`SDK.AuthStorage.create()` → `undefined.create`). The extension migrated to
`ModelRuntime` rather than pinning an old SDK — it runs on current 0.80.x.

The mapping (`src/sdk-service.ts` + `src/pi-service.ts`):

| Removed | ModelRuntime (0.80.8+) |
|---|---|
| `AuthStorage.create()` + `ModelRegistry.create(auth)` | `await ModelRuntime.create()` — one object |
| `authStorage.setRuntimeApiKey(p,k)` | `await modelRuntime.setRuntimeApiKey(p,k)` (async) |
| `authStorage.getApiKey(p)` | `await modelRuntime.getAuth(p)` → `.apiKey` |
| `modelRegistry.find(p,id)` | `modelRuntime.getModel(p,id)` (sync) |
| `modelRegistry.getAvailable()` | `await modelRuntime.getAvailable()` (async) |
| `modelRegistry.refresh()` | `await modelRuntime.refresh()` (async) |
| `modelRegistry.getAll()` / `getProviderDisplayName(id)` | `modelRuntime.getProviders()` / `getProvider(id).name` |
| `authStorage.login/list/logout` | `modelRuntime.login(id, "api_key"\|"oauth", interaction)` / `listCredentials()` / `logout(id)` |
| `createAgentSession({ authStorage, modelRegistry })` | `createAgentSession({ modelRuntime })` |

**`/login` and `/logout`** (`PiService.login`/`logout`) drive
`modelRuntime.login(providerId, type, interaction)`, where `interaction` is a pi-ai
`AuthInteraction` — a unified `{ prompt(AuthPrompt), notify(AuthEvent) }` pair
serving BOTH the api-key and OAuth flows. `makeAuthInteraction()` adapts it to VS
Code: `prompt({text|secret|select|manual_code})` → input box / quick pick;
`notify({auth_url|device_code|info|progress})` → `openExternal` + progress.

> **⚠ OAuth login is wired-to-spec but NOT live-verified.** The **api-key** path and
> logout were validated end-to-end against real 0.80.10 (secret prompt → credential
> persisted via `listCredentials` → `logout` removed it). The **OAuth** path shares
> the exact same `AuthInteraction` contract but was never driven through a real
> provider round-trip (needs a live subscription login), so treat a first real OAuth
> `/login` as unverified — check that `notify({type:"auth_url"})` opens the browser and
> the manual-code/`prompt` step round-trips before trusting it.

**Do not pin the SDK to dodge a shape change** — the devcontainer installs
`@latest` intentionally. When a future release shifts the API again, adapt the
`ModelRuntime` call-sites (the headless `sdk-service.test.ts` fakes + a real-SDK
`createAgentSession` smoke are the net), don't freeze the version.

## Related

- [PiService](../architecture/pi-service.md) — owns this initialization sequence
- [Session Window](../architecture/session-window.md) — calls initSessionInBackground
- [Build Pipeline](build-pipeline.md) — how the extension itself is built

> **Last updated:** 2026-05-15 — initial documentation
