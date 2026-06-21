# PiService

> **Status:** evolving

PiService (`src/pi-service.ts`) is the core lifecycle manager behind every
`SessionWindow`. It is the **runtime branch point**: a single instance drives
*either* the in-process TypeScript SDK (`@earendil-works/pi-coding-agent`) *or*
an out-of-process Rust binary (`pi --mode rpc`), chosen per session. It handles
runtime/SDK resolution, agent session creation, event subscription/translation,
model cycling, thinking level management, and usage stat tracking — presenting
the same `PiServiceEvent` stream to the webview regardless of runtime.

See [Runtime Selection](runtime-selection.md) for the architecture-level split;
this page covers PiService's internals for both paths.

## Why it exists

The Pi SDK is loaded dynamically at runtime from the user's global npm install
— it is not bundled with the extension. PiService encapsulates the full lifecycle:
finding the SDK on disk (`resolvePiPackagePath`), importing modules (`PiSdk`,
`PiAi`), configuring auth/model-registry/session-manager, building custom tools
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
- **Session init** (`initialize`) — 11-step async sequence: resolve SDK, load
  modules, setup auth/registry, pick model, build tools, create session manager,
  restore model/thinking from session file, create agent session, subscribe to
  events, bind extensions, send initial message history.
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
  current active set. Selection persists to the session file as
  `tools_active_change` entries and restores on resume. The older static
  `pi-code-gui.tools` VS Code settings allowlist has been removed in favor
  of runtime-per-session control.
- **Session listing** (`PiService.listSessions`, `PiService.deleteSessionFile`) —
  static methods for the Past Sessions tree view.

## Dual runtime (TypeScript SDK vs Rust binary)

`_backendKind: Runtime` (`"typescript" | "rust"`) records which path a session
uses. `initialize()` dispatches to either the SDK init sequence or
`initializeRust()`, and most action methods branch on `_backendKind` (early-return
the Rust path, fall through to the SDK path). Notable Rust-path details:

- **Spawn + handshake** (`initializeRust` → `spawnRust`) — launches `pi --mode rpc`
  via `RustProcess` (`src/rust-process.ts`), then handshakes `get_state` →
  `get_available_models` → `get_messages` → `get_commands`. `get_state` doubles
  as a **liveness check**: if the subprocess died during/after spawn, init fails
  here instead of returning success on a dead process (`RustProcess.isAlive()`).
- **Event ingress** (`handleRustEvent`) — raw RPC events are normalized
  (`normalizeRustEvent` in `src/rust-events.ts`) to the shapes the shared Zod
  schema expects (the Rust runtime sends `null` where the SDK sends objects/
  strings), then routed through the same `handleAgentEvent` as the SDK path.
- **Typed RPC commands** — all `request()`/`send()` calls use `RUST_RPC.*`
  constants (no bare strings), so a typo is a compile error, not a silent timeout.
- **Synthetic steer/follow-up queue** — rust-pi 0.1.18 emits no `queue_update`,
  so PiService tracks the pending queue itself (`_rustSteering`/`_rustFollowUp`),
  emits `queue-update` on send, and clears an entry when the binary folds it into
  a user turn. See [Runtime Selection](runtime-selection.md) for the trade-offs.
- **Settings over RPC** — `toggleAutoCompaction`/`toggleAutoRetry` call
  `set_auto_compaction`/`set_auto_retry` on the Rust path (the binary owns the
  setting; there is no in-process session to mutate).
- **Duplicate `agent_end` guard** — rust-pi can emit `agent_end` twice on the
  abort/error path; `_agentRunActive` dedupes it.

State that the SDK exposes via its session object is mirrored in `_rust*` fields
for the out-of-process runtime: `_rustSessionPath`, `_rustUsage`,
`_rustContextWindow`, `_rustEntries`, `_rustSlashCommands`.

## Related

- [Runtime Selection](runtime-selection.md) — the TypeScript-vs-Rust split and trade-offs
- [Session Window](session-window.md) — the SessionWindow that owns PiService
- [Event Translation](event-translation.md) — how SDK events become PiServiceEvent types
- [SDK Resolution & Init](../operations/sdk-resolution.md) — detailed walkthrough of the init sequence

> **Last updated:** 2026-06-21 — documented the dual-runtime (Rust) path: `_backendKind` branching, `initializeRust` handshake + liveness check, `RUST_RPC` constants, synthetic steer/queue, settings-over-RPC, `agent_end` dedupe
