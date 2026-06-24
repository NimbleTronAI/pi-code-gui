# Runtime Selection (TypeScript + Rust)

> **Status:** active — supersedes `archive/multi-backend.md`
> **Last updated:** 2026-06-24 — corrected event-routing path to `RustService.handleEvent` → `normalizeRustEvent`/`routeRustEvent` → `RustHost.handleAgentEvent`; added `src/rust-service.ts` + `src/rust-events.ts` to the file inventory
> **Earlier:** 2026-06-21 — added "Design decisions & trade-offs" (ADR notes); verified live against rust-pi 0.1.18 (no `queue_update`; tool-skip-on-queued-message; duplicate `agent_end`)
> **Verified:** the RPC integration was driven against a locally-built
> `pi_agent_rust` v0.1.18 — `get_state` / `get_available_models` / `get_messages`
> response shapes confirmed, and a real streaming turn (DeepSeek) round-tripped
> `text_delta` events through `handleAgentEvent` end-to-end. Two field names were
> corrected from the docs during this pass (`autoCompactionEnabled` /
> `autoRetryEnabled`; `sessionFile` captured from `get_state`).

Pi Code Gui runs each session on one of two interchangeable Pi runtimes,
selectable per session:

- **TypeScript Pi** — the `@earendil-works/pi-coding-agent` npm SDK, loaded
  **in-process** (the original, default behaviour).
- **Rust Pi** — the [`pi_agent_rust`](https://github.com/Dicklesworthstone/pi_agent_rust)
  binary, driven **out-of-process** over its `--mode rpc` JSON protocol.

The 2025 multi-backend design ([archived](../archive/multi-backend.md)) was
*rejected* because the in-process custom-card renderer
(`globalThis.__piRegisterMessageRenderer`) has no out-of-process equivalent.
That objection is now **accepted as a documented limitation** — Rust sessions
fall back to the markdown card rendering the webview already provides — so the
feature ships, with Rust positioned as an equal first-class (not "experimental")
opt-in.

## Internal branching, not an external interface

`PiService` carries a `_backendKind: "typescript" | "rust"` field and branches
internally. ~85% of the class (event translation, dialog/widget bridge, pickers,
status, slash commands, initial-message replay) is runtime-agnostic. Only the
runtime-specific methods branch: `initialize`, `sendPrompt`, `abort`, `dispose`,
`setModel`/`cycleModel`, `setThinkingLevel`, and the `/tools` picker (disabled
under Rust).

- `initialize({runtime})` → `initializeRust()` for Rust, else the existing
  TS path. `get runtime()` exposes `_backendKind`.
- Rust events are routed through `RustService.handleEvent()`
  (`src/rust-service.ts:328`), a thin shell: it `normalizeRustEvent()`s the raw
  event, then asks the **pure, unit-tested `routeRustEvent()`**
  (`src/rust-events.ts:111`) for the routing / dedupe / queue-clear decision, and
  finally **delegates everything non-UI to the existing `handleAgentEvent()`** via
  the `RustHost.handleAgentEvent` callback. The Rust event shapes (`agent_start`,
  `message_update` with `assistantMessageEvent`, `tool_execution_*`, etc.) mirror
  the TS SDK's, so no parallel translator is needed.

## New files

- `src/rust-service.ts` (~727 LOC) — `RustService`: owns the entire Rust runtime
  lifecycle, extracted from the `PiService` god class. Spawn + `get_state`
  handshake/init, the `--no-extensions` self-heal, model & slash-command queries,
  prompt/abort/steer, capability-degradation surfacing. It does **not** translate
  events itself — `handleEvent()` delegates to the shared `handleAgentEvent()`
  through a `RustHost` callback interface (see *Internal branching* above).
- `src/rust-events.ts` (~254 LOC) — the pure, vscode-free core for the Rust path,
  fully unit-tested: `normalizeRustEvent`, `routeRustEvent` (routing / dedupe /
  queue-clear decisions), the `TOOL_PREVIEW_THROTTLE_MS = 200` tool-arg-preview
  throttle (`shouldEmitToolPreviewUpdate`), degraded-capability tracking
  (`checkAndRecordDegraded`/`clearDegraded`), and the `parseRust*` response
  parsers (`parseRustModels`/`parseRustEntries`/`parseRustSlashCommands`).
- `src/rust-process.ts` — `RustProcess`: spawns `pi --mode rpc`, LF-framed JSONL
  stdin/stdout with **partial-line buffering**, request/response correlation by
  `id`, fire-and-forget `send()`, raw-event emitter, SIGTERM→SIGKILL `dispose()`.
- `src/rust-resolver.ts` — `detectRustBinary()`: resolves the binary
  (`rustBinaryPath` → `PI_BINARY_PATH` → `~/.cargo/bin` → `~/.local/bin` →
  `/usr/local/bin` → PATH; also `legacy-pi`/`rust-pi`) and **verifies it's a
  native executable** (ELF/Mach-O/PE) so the TypeScript `pi` CLI (a Node script)
  is never mistaken for it, then runs `--version`. Also home to the extension
  interop helpers: `shouldDisableRustExtensions()` / `workspaceHasTsPiExtensions()`
  / `isRustExtensionConflict()` (see the interop section below).
- `src/rust-sessions.ts` — Rust session storage (`sessions-rust`, kept separate
  from the TS pool because the JSONL formats are not cross-readable) and a
  tolerant JSONL listing for the unified Past Sessions view.
- `src/rust-install.ts` — on-demand install (managed GitHub-release download with
  checksum verification, official `curl | sh`, manual, detect-existing).
- `src/runtime-detection.ts` — `detectRuntimes()`,
  `resolveEffectiveDefaultRuntime()`, `refreshRuntimeContext()` (sets the
  `pi-code-gui.{ts,rust,both,any}Available` context keys).

## RPC flags (verified against the v0.1.18 binary)

`pi --mode rpc --session-dir <dir>` plus, as applicable: `--session <path>`
(resume), `--provider`/`--model`, `--thinking <level>`,
`--extension-policy safe|balanced|permissive`. There is **no `--approve` flag**
(project trust is the binary's own concern). Commands use underscores
(`get_state`, `follow_up`); responses are `{type:"response", id, success, data}`.

## What does NOT carry over to Rust (documented limitations)

- **VS Code bridge tools** — the RPC protocol accepts no host-provided tools, so
  the 16 `vscode_*` tools can't run under Rust. Rust uses its own
  `read/write/edit/bash/grep/find/ls` on the same files. (Pure-filesystem mode.)
- **`/tools` picker** — no RPC tool enumeration/toggle; disabled under Rust.
- **Custom interactive cards** — markdown fallback only.
- **Session history** — separate storage; the unified Past Sessions list is a
  *presentation* merge, and resume always follows a session's origin runtime.

### Interop: TypeScript-format `.pi/` extensions (handled)

If the workspace has **TypeScript-SDK Pi extensions** installed under `.pi/`
(e.g. this repo's `.pi/settings.json` → `packages: ["npm:pi-web-access"]`, which
populates `.pi/npm/node_modules`), the Rust binary aborts `--mode rpc` startup
while discovering them: `Error: JSON error: missing field 'parameters'` and an
immediate non-zero exit. Cause — Rust expects its own tool-manifest shape; the
TS-SDK manifests omit the `parameters` field. It's a `pi_agent_rust` interop
limitation, not an extension bug, and it's not repo-specific (any workspace with
a `.pi/settings.json` `packages` array or `.pi/extensions/` dir can hit it).

**Resolution — `--no-extensions`.** The binary exposes a first-class
`--no-extensions` flag ("Disable extension discovery"); passing it makes Rust
start cleanly and serve RPC (verified end-to-end: a real `get_state` returns).
This is also *correct by design* — those `.pi/` extensions target the in-process
TypeScript runtime, and the Rust runtime is pure-filesystem/built-in-tools
anyway (see limitations above). Neither `PI_EXT_COMPAT_SCAN=1` nor `doctor --fix`
resolves it (tested); `--no-extensions` is the documented lever.

The GUI controls this via the **`pi-code-gui.rustExtensions`** setting
(`auto` | `enabled` | `disabled`, default `auto`), resolved in
`shouldDisableRustExtensions()`:

- `auto` — pass `--no-extensions` only when `workspaceHasTsPiExtensions(cwd)`
  detects the npm-package signal (`.pi/settings.json` `packages`, or a `.pi/npm`
  dir). Rust-native `.pi/extensions/*.native.json` are left discoverable.
- `disabled` — always pass `--no-extensions` (most robust).
- `enabled` — never; the user vouches for a Rust-compatible workspace.

**Self-healing + actionable error.** `initializeRust` wraps the spawn: in `auto`
mode, if detection misses a conflict and startup still fails with the parse
signature (`isRustExtensionConflict()`), it retries once with `--no-extensions`
and shows a one-time "extensions disabled for this workspace" info toast. In
`enabled` mode it instead surfaces a dialog that points straight at the setting
(`Disable for Rust` / `Open Setting`). The `_rustInitializing` guard suppresses
the generic "exited unexpectedly" message during this dance.

## Tool security (congruent)

Both runtimes execute tools autonomously (auto-accept) — there is no per-tool
approval gate in either path. Rust additionally enforces a hard safety floor
(catastrophic-command blocking before spawn, zero `unsafe`, secret env
filtering) and a capability-gated extension policy (`rustExtensionPolicy`).

## Packages (shared ecosystem)

Packages are **not** per-runtime: both runtimes install the same npm-format
packages into the same `.pi/` locations (`pi install npm:…`), and upstream
documents "extension/package workflows are compatible across both
implementations." The GUI's Packages view manages this single catalog and
follows the focused session's runtime (see [Tree Views](tree-views.md)). What
differs is *execution*: a TypeScript-format extension may be **installed
(available)** yet **not load under Rust (inactive)** — governed by
`rustExtensions` and per-package QuickJS compatibility (`rust-pi doctor`).
`PiPackageService` drives the Rust binary (`rust-pi`) when the TypeScript SDK
isn't installed, so Rust-only setups can still manage packages.

## Design decisions & trade-offs

Short rationale for the non-obvious choices, so they aren't "fixed" back into a
rejected alternative. (Lightweight, in lieu of formal ADRs.)

- **Internal branching over a `PiBackend` interface.** A polymorphic backend was
  considered and rejected: ~85% of PiService is runtime-agnostic, and a shared
  interface would force the in-process-only custom-card renderer into an
  abstraction with no out-of-process equivalent. Branching keeps the shared part
  shared (see *Internal branching* above).
- **Pinned managed binary, not `latest`.** The managed download installs a fixed,
  tested release (`src/rust-pi-version.json`), never upstream `latest` —
  auto-pulling a brand-new release behind the extension would break the
  verified-binary contract. A user-supplied binary of a different version gets a
  one-time warning. Dependabot can't track GitHub releases, so the SoT JSON
  carries `datasource`/`repo`/`tag` for a future Renovate or scheduled bump.
- **Synthetic steer/follow-up queue.** rust-pi 0.1.18 emits no `queue_update`, so
  the webview's pending indicator (driven entirely by that event) would never
  appear. PiService mirrors the queue locally and clears an entry when the binary
  folds it into a user turn (matched by text). Verified: zero `queue_update`
  across idle-steer, mid-turn-steer, and live generation.
- **Tool-skip on a queued message is expected, rendered neutrally.** Steering or
  queuing mid-turn makes rust-pi abort the in-flight tool with `isError` +
  `"Skipped due to queued user message."` and retry it next turn. The GUI renders
  this as a neutral note, not a red failure, because it is not one.
- **`get_state` doubles as the init liveness check.** A crash during the handshake
  is otherwise swallowed by the `_rustInitializing` guard; failing init on a dead
  `get_state` (or `!RustProcess.isAlive()`) avoids reporting success on a dead
  subprocess. rust-pi also emits `agent_end` twice on the abort/error path, so
  `_agentRunActive` dedupes it.
- **Settings live in the binary.** `autoCompactionEnabled`/`autoRetryEnabled` are
  toggled over RPC (`set_auto_compaction`/`set_auto_retry`); there is no
  in-process session to mutate, and `get_state` re-syncs the values.
- **Context-window clamp asymmetry (built-in vs custom models).** Built-in Rust
  models keep their registry window for real auto-compaction; only custom models
  (written into `models.json`) are clamped to the context budget — lowering a
  built-in's window would require shadowing it. The displayed `%` honours the
  budget for both.
- **Relocated agent home + guarded auth seed.** Every Rust session sets
  `PI_CODING_AGENT_DIR` to an extension-owned dir so writing the bundled
  `models.json` never clobbers `~/.pi/agent`. `auth.json` is linked from there
  only when the source is non-empty, valid JSON (a 0-byte source made the binary
  write `auth.json.corrupt`).
- **No orphan watchdog needed; crash offers one-click reopen.** Verified that
  rust-pi exits cleanly (~15ms) on stdin EOF, so when the extension host dies the
  closed pipe terminates the subprocess — no orphaning, no watchdog. `dispose()`
  still SIGTERM/SIGKILLs on graceful teardown. A *real* mid-session crash
  (`handleRustExit`) is not auto-restarted (avoids crash-loops and replaying
  history into the dead tab); instead it offers a "Reopen session" notification
  that resumes from the on-disk JSONL via the existing `resumePastSession` flow.

## Cross-reference

- [Runtime Switching UX](runtime-switching-ux.md) — commands, indicators, install dialogs
- [Tree Views](tree-views.md) — the runtime-aware Packages view (available vs active)
- [PiService](pi-service.md) — the orchestrator that branches on `_backendKind`
- [Session Window](session-window.md) — per-tab PiService; mixed-runtime tabs each own a subprocess
- [archive/multi-backend.md](../archive/multi-backend.md) — the original (superseded) design
