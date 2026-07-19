# PiService

> **Status:** evolving

PiService (`src/pi-service.ts`) is the core lifecycle manager that bridges the
Pi coding agent SDK (`@earendil-works/pi-coding-agent`) to VS Code. Every
`SessionWindow` owns one PiService instance. It handles SDK resolution, agent
session creation, event subscription/translation, model cycling, thinking level
management, and usage stat tracking.

## Why it exists

The Pi SDK is loaded dynamically at runtime from the user's global npm install
— it is not bundled with the extension. PiService encapsulates the full lifecycle:
finding the SDK on disk (`resolvePiPackagePath`), importing the coding-agent
module, configuring `ModelRuntime`/model-registry/session-manager, building custom tools
(via `bridge-tools.ts`), creating the agent session, subscribing to events, and
cleaning up on disposal.

Without this abstraction, every command and view would need to manage SDK state
independently, leading to duplicated init logic and inconsistent error handling.

## Key responsibilities

- **SDK resolution** (`resolvePiPackagePath`) — searches global npm, nvm, and
  project-local `.pi/npm/` directories for the Pi SDK.
- **Install check** (`PiService.checkInstall`) — static method that verifies
  the SDK and its critical transitive dependencies (openai, @anthropic-ai/sdk)
  are actually installed.
- **Session init** (`initialize`) — async sequence: resolve SDK, load the SDK,
  create runtime services, load provider extensions, pick a model, build tools,
  create a session manager, restore model/thinking from the session file, create
  the agent session, subscribe to events, bind extensions, and send history.
  SDK 0.80's `createAgentSessionServices()` and
  `createAgentSessionFromServices()` enforce this two-phase order so dynamic
  providers are registered before defaults are resolved. New sessions prefer
  the Pi Code Gui default, then Pi's SettingsManager default, then the first
  available model.
- **Model runtime compatibility** (`src/pi-model-runtime.ts`) — centralizes model
  lookup, scoped-model construction, and lightweight completion on the canonical
  `ModelRuntime` API. Pi SDK 0.80 removed root `pi-ai.getModel()` and
  `pi-ai.complete()` exports, so PiService must not call those legacy globals.
- **Event emission** (`onEvent` / `emit`) — observer pattern: listeners (webview
  panel, extension commands) subscribe to typed `PiServiceEvent` emissions.
- **User actions** — `sendPrompt`, `abort`, `cycleModel`, `setThinkingLevel`,
  `setEffort`, `login`, `logout`, `toggleAutoCompaction`, `toggleAutoRetry`.
- **Interactive pickers** — `pickModel()` and `pickThinkingLevel()` provide
  unified QuickPick dialogs (with ★ default / ✓ current indicators and
  save-as-default prompts). These replaced duplicated implementations that
  previously lived in `extension.ts` and `webview-panel.ts`. `pickModel()`
  also surfaces SDK-reported pricing and context window in the `detail` field via
  `PiService.formatModelDetail()`.
- **Tool management** — `getAllTools()`, `getActiveToolNames()`, `setActiveTools()`
  expose the SDK's tool registry/activation for per-session control. The
  `pickActiveTools()` method (bound to `/tools`) opens a grouped checkbox
  QuickPick (Built-in, VS Code Bridge, Extension) pre-populated from the
  current active set. Selection persists through
  `SessionManager.appendCustomEntry("pi-code-gui.active-tools", ...)` and
  restores on resume, with read compatibility for legacy
  `tools_active_change` entries. Model and thinking changes likewise rely on
  SDK session APIs; PiService never appends directly to a `.jsonl` file, so a
  fresh session cannot be created without its required header. The older static
  `pi-code-gui.tools` VS Code settings allowlist has been removed in favor of
  runtime-per-session control.
- **Session listing** (`PiService.listSessions`, `PiService.deleteSessionFile`) —
  static methods for the Past Sessions tree view.

## Related

- [Session Window](session-window.md) — the SessionWindow that owns PiService
- [Event Translation](event-translation.md) — how SDK events become PiServiceEvent types
- [SDK Resolution & Init](../operations/sdk-resolution.md) — detailed walkthrough of the init sequence

> **Last updated:** 2026-07-19 — adopted two-phase SDK service creation so dynamic-provider defaults resolve correctly
