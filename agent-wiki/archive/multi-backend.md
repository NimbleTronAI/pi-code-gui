# Multi-Backend Architecture

> **Status:** superseded — 2026-06-05  
> **Superseded by:** [architecture/runtime-selection.md](../architecture/runtime-selection.md) and [architecture/runtime-switching-ux.md](../architecture/runtime-switching-ux.md)  
> The 2025 "rejected" verdict (below) was reversed: dual-runtime support shipped in v0.0.56 with the custom-card incompatibility accepted as a documented markdown fallback. This page is retained for its original design notes (path resolution, RPC, install flow), some of which were refined during implementation (e.g. Rust uses a *separate* session pool, and host-executed bridge tools are NOT possible over RPC).
>
> **Original status:** rejected — May 2025  
> **Last updated:** 2026-05-25 — decision not to proceed; archived for reference

## Verdict

**Will not implement.**  The Rust Pi backend is technically viable at the session
and RPC level, but the extension UX model is fundamentally incompatible.

Pi Code Gui relies on a custom message renderer system: extensions inject
JavaScript functions via `globalThis.__piRegisterMessageRenderer(customType,
sourceCode)`.  The source code is forwarded to the webview, wrapped in a
`<script nonce>` tag, and executed in the browser context to produce rich
interactive cards (buttons, clickable rows, live polling, custom HTML).

This mechanism works because TypeScript Pi extensions run **in-process** —
they share the Node.js `globalThis` with our extension host.  Our injected
handler catches the registration call before `SDK.createAgentSession()` runs.

Rust Pi extensions run in an embedded QuickJS sandbox or as native Rust code.
They have no access to the extension host's `globalThis`.  Their UI surface is
the TUI hostcall system (`ui.setWidget`, `ui.notify`, `ui.setStatus`) —
terminal widgets rendered via `rich_rust`.  There is no HTML, no webview, no
DOM injection.  The RPC protocol forwards TUI-shaped data (ANSI-stripped text
lines, status key/value pairs), not executable renderer code.

Rebuilding the custom message renderer system on top of TUI widget output would
require either upstream changes to the Rust Pi RPC protocol (adding a
`registerMessageRenderer` event type and a webview-aware extension API) or a
lossy translation layer that strips all interactivity from extension cards.
Neither is worth the effort given that the TypeScript Pi backend works and the
Rust Pi's extension ecosystem is a completely separate catalog.

**The rest of this document is retained as archival design reference.**

---

## Original Design (archived)

Pi Code Gui currently supports only the TypeScript Pi SDK (`@earendil-works/pi-coding-agent`). The Rust port (`pi_agent_rust`, [GitHub](https://github.com/dicklesworthstone/pi_agent_rust)) is a from-scratch reimplementation as a single binary (~21MB, zero unsafe code) that is faster, leaner, and where active Pi development is happening.

This document describes how to support **both backends** from a single extension with minimal code changes. The key insight: the RPC protocol in the Rust binary was explicitly designed for IDE integration, and the session format (JSONL v3) is fully compatible across backends.

---

## Path Resolution

The extension explicitly resolves all paths — it does not delegate resolution to whichever backend is active. This ensures consistent behavior regardless of backend choice.

### Agent directory

```
1. PI_CODING_AGENT_DIR  env var
2. ~/.pi/agent/          (dirs::home_dir() fallback)
```

Resolved once at startup by `resolveAgentDir()`. Used for session listing, resource discovery, auth path, and models cache.

### Session directory

```
1. pi-code-gui.sessionDir   VS Code setting (user's explicit choice)
2. PI_SESSIONS_DIR           env var (both backends check this)
3. {agentDir}/sessions/      default under agent dir
```

Resolved by `resolveSessionDir(agentDir)`. Used for:

| Consumer | How it's passed |
|----------|----------------|
| TS backend | `SessionManager.create(cwd, resolved)` — explicit path, no `undefined` |
| Rust backend | `pi --mode rpc --session-dir <resolved>` — explicit CLI flag |
| Session listing | Scans `resolved` for JSONL files — no SDK import needed |

Previously, the extension passed `undefined` to `SessionManager.create()` and relied on the SDK's internal fallback. The new approach resolves explicitly so all consumers get the same directory.

---

## Backend Architecture

### Design principle: internal branching, not external abstraction

`PiService` (~2,400 lines) does many things. Only ~15% is backend-specific. The remaining ~85% (event translation, UI bridge, pickers, widget management, usage tracking, settings, interactive dialogs, slash command discovery, session entry formatting, initial message replay) is identical for both backends.

Rather than extracting a full `PiBackend` interface (which would force two different initialization shapes into the same mold), `PiService` branches internally on a `backendKind` field. Only ~6 methods need the branch:

- `initialize()` — TS: module imports + `createAgentSession`; Rust: subprocess spawn + RPC handshake
- `sendPrompt()` — TS: `session.sendPrompt()`; Rust: JSON command on stdin
- `abort()` — TS: `session.abort()`; Rust: `{"type":"abort"}` on stdin
- `dispose()` — TS: unsubscribe + cleanup; Rust: kill subprocess + cleanup
- `cycleModel()` / `setThinkingLevel()` — TS: session methods; Rust: RPC commands
- `compact()` / `reload()` / `exportToHtml()` — TS: session methods; Rust: RPC commands

Everything else (event handling in `handleAgentEvent`, `bindExtensionUI`, `_showDialog`, `pickModel`, `pickThinkingLevel`, `reportStatus`, `emitScopedModels`, `emitSettings`, `emitSlashCommands`, `sendInitialMessages`, `getAllSlashCommands`, widget management, usage stats) stays unchanged.

```
┌──────────────────────────────────────────────────────┐
│                    PiService                          │
│  backendKind: "typescript" | "rust"                   │
│                                                       │
│  initialize()                                          │
│    if (ts) → initializeTypeScript()                    │
│    if (rust) → initializeRust()                        │
│                                                       │
│  sendPrompt() / abort() / cycleModel() / ...           │
│    → branches on backendKind                           │
│                                                       │
│  handleAgentEvent() / bindExtensionUI() / pickModel()  │
│    → identical for both backends                       │
│                                                       │
│  Static (moved to session-files.ts):                   │
│    listSessions() — backend-agnostic JSONL parsing     │
│    deleteSessionFile() — fs.unlink                     │
└──────────────────────────────────────────────────────┘
```

---

## RPC Protocol Integration

The Rust binary's `--mode rpc` communicates via line-delimited JSON on stdin/stdout. This is the same protocol the Rust TUI and other IDE integrations use.

### Commands (extension → pi process)

| Command | Purpose |
|---------|---------|
| `prompt` | Send a user message (with optional images, streamingBehavior) |
| `steer` | Queue a steering message during active streaming |
| `follow-up` | Queue a follow-up message during streaming |
| `abort` | Cancel current streaming and in-flight tools |
| `get-state` | Query session state (model, thinking, messages, etc.) |
| `set-model` | Change the active model |
| `set-thinking-level` | Change the thinking level |
| `compact` | Trigger context compaction |
| `set-auto-compaction` | Toggle auto-compaction |
| `set-auto-retry` | Toggle auto-retry |

### Events (pi process → extension)

The Rust process emits `AgentEvent` values serialized as JSON. These are translated to the existing `PiServiceEvent` types that the webview already understands. The translation is straightforward because the event models are structurally similar (both have agent_start/end, message_start/update/end, turn_start/end, tool events, etc.).

### Gap filling

Some capabilities aren't exposed via RPC. These are handled by subprocess invocations or direct filesystem access:

| Missing RPC capability | Solution |
|------------------------|----------|
| Session listing | Parse JSONL files directly from resolved session dir |
| Model listing | `pi --list-models` subprocess or parse `{agentDir}/models.json` |
| Provider listing | `pi --list-providers` subprocess or built-in metadata |
| Package install/remove | `pi install npm:...` / `pi remove ...` / `pi update` subprocess |
| Session fork | `pi --session <path>` subprocess |
| Session export | `pi --export <path>` or parse JSONL to generate HTML |

---

## Bridge Tools

The 17 VS Code bridge tools (`vscode_get_editor_state`, `vscode_get_diagnostics`, etc.) call VS Code APIs — only the extension process can execute them. The Rust process has its own tool system for standard tools (read, write, edit, bash, etc.).

**Design**: Bridge tools execute in the extension process, not in the Rust process.

1. Rust process emits `tool_start` for `vscode_*` tools (they aren't in its tool registry)
2. Extension intercepts these — executes locally, calling VS Code APIs
3. Extension injects results back as if the Rust process had executed them

Non-bridge tools (read, write, edit, bash, grep, find, ls) execute inside the Rust process normally.

This is cleaner than the current TS approach where bridge tools are mixed into the SDK's tool registry — the Rust process remains VS Code-agnostic.

---

## Install & Onboarding Flow

### Backend detection

Two fast, synchronous checks (file existence).

**Important**: the TypeScript backend uses the npm *package*, not the CLI binary.
The Rust installer may rename the TS `pi` command to `legacy-pi` — this does
not affect the extension because the TS backend resolves the npm package on
disk, not the shell command.

| Backend | Detection |
|---------|-----------|
| TypeScript | `resolvePiPackagePath()` — checks global npm, nvm, project-local `.pi/npm/` |
| Rust | `detectRustBinary()` — checks `pi-code-gui.rustBinaryPath` setting → `PI_BINARY_PATH` env → `~/.cargo/bin/pi` → `~/.local/bin/pi` → `/usr/local/bin/pi` → PATH lookup (`which pi`).  Also checks `legacy-pi` and `rust-pi` as fallback names (the curl installer may rename the binary during TS→Rust migration).  Verifies with `pi --version`. |

### Decision flow

```
1. Detect available backends → { ts: bool, rust: bool }

2. Resolve user preference:
   pi-code-gui.backend = "auto" | "typescript" | "rust"
   "auto" → prefer Rust (faster, leaner), fallback to TS

3. Match preference to availability:

   BOTH available:
     → Use preference. "auto" → Rust.

   ONE available:
     If it matches preference → use it.
     If preference is for the MISSING one:
       Dialog: "You prefer {Rust} but only {TypeScript} is installed."
       [Use TypeScript for now] [Install Rust Pi]

   NEITHER installed:
     Dialog: "Pi coding agent is not installed. Choose a backend:"
     🦀 Rust Pi (recommended) — faster, no Node.js needed
     📦 TypeScript Pi — original agent, requires Node.js + npm
     [Learn More]

4. Install (if user chose to)
   Rust: curl installer with `--yes --easy-mode` flags for non-interactive
     install.  The installer handles TS→Rust migration automatically (renames
     old `pi` to `legacy-pi`).
   TS:  npm install -g in terminal (existing behavior)

5. Re-detect and proceed with initialization
```

### Coexistence

The two backends are fully independent.  The TypeScript backend imports the
npm package; the Rust backend spawns a child process.  Neither touches the
other's files or runtime.  The Rust installer's `legacy-pi` rename has no
effect on the extension — the TS backend never invokes the `pi` shell command.

### VS Code settings additions

```json
{
  "pi-code-gui.backend": {
    "type": "string",
    "enum": ["auto", "typescript", "rust"],
    "default": "auto",
    "markdownDescription": "Which Pi agent backend to use. 'auto' prefers the Rust binary if found, falling back to the TypeScript SDK."
  },
  "pi-code-gui.rustBinaryPath": {
    "type": "string",
    "default": "",
    "markdownDescription": "Custom path to the `pi` binary for the Rust backend. Leave empty for auto-detection."
  }
}
```

---

## Implementation Plan

### New files

| File | Lines | Purpose |
|------|-------|---------|
| `src/session-files.ts` | ~150 | `resolveAgentDir()`, `resolveSessionDir()`, `listSessions()`, `deleteSessionFile()` — backend-agnostic, pure filesystem |
| `src/pi-rust-resolver.ts` | ~80 | `detectRustBinary()`, `RustInstallStatus` — find the `pi` binary on disk.  Checks `pi`, `legacy-pi`, `rust-pi` as fallback names (the curl installer may rename the binary during TS→Rust migration). |
| `src/pi-rust-process.ts` | ~300 | `RustProcess` class — spawn `pi --mode rpc`, manage stdin/stdout, translate RPC events → `PiServiceEvent`, intercept `vscode_*` bridge tools |
| `src/backend-detection.ts` | ~120 | `detectBackends()`, `resolveBackend()`, install dialogs, install helpers |

### Modified files

| File | Change | Net lines |
|------|--------|-----------|
| `src/pi-service.ts` | Add `backendKind` field; branch `initialize()`, `sendPrompt()`, `abort()`, `dispose()`, `cycleModel()`, `setThinkingLevel()`, `compact()`, `reload()`, `exportToHtml()` (~6 methods); keep everything else unchanged. Move `listSessions`/`deleteSessionFile` to `session-files.ts`. | +80 |
| `src/extension.ts` | Replace `PiService.checkInstall()` + `installPi()` with new `ensureBackendInstalled()` flow; wire up backend preference. `listSessions` import changes to `session-files.ts`. | +60, -20 |
| `package.json` | Add `pi-code-gui.backend` and `pi-code-gui.rustBinaryPath` configuration declarations | +15 |

Total: ~650 new lines, ~135 modified lines

### What does NOT change

- **Webview panel** (`src/webview-panel.ts`) — zero changes. Talks to PiService through the same public API.
- **Bridge tools** (`src/bridge-tools.ts`) — zero changes. For the Rust backend, they execute in the extension process via interception (see §Bridge Tools above). For the TS backend, they're registered with the SDK as before.
- **Event types** (`src/types.ts`, `src/shared/protocol.ts`) — zero changes. Both backends emit the same `PiServiceEvent` types.
- **Phase 3/4 commands** — zero changes. They call `PiService` public methods.
- **Tree views** — zero changes. Session listing is backend-agnostic.
- **Packages view** — minor: subprocess calls (`pi install`/`pi remove`) instead of SDK-based package manager for the Rust backend.
- **Media/frontend** — zero changes.

### Implementation order

1. **`src/session-files.ts`** — Backend-agnostic path resolution and session listing. Removes the TS SDK dependency from the tree view. Can be implemented and tested independently.
2. **`src/pi-rust-resolver.ts`** + **`src/backend-detection.ts`** — Binary detection and install flow. Can be tested without a running Rust process.
3. **`src/pi-rust-process.ts`** — RPC process management and event translation. The core integration piece.
4. **`src/pi-service.ts`** — Internal branching for backend. The ~6 method changes.
5. **`src/extension.ts`** — Wire up new install flow and backend selection.

---

## Cross-reference

- [PiService](pi-service.md) — the orchestrator that gets backend-aware
- [Session Window](session-window.md) — how sessions are managed
- [Bridge Tools](bridge-tools.md) — the 17 VS Code tools
- [Event Translation](event-translation.md) — SDK events → PiServiceEvent
- [SDK Resolution & Init](../operations/sdk-resolution.md) — current TS-only init sequence
- [Webview Panel](webview-panel.md) — unchanged by this design
- [Build Pipeline](../operations/build-pipeline.md) — unchanged by this design
