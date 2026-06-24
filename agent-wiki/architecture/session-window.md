# Session Window

> **Status:** evolving

The Session Window pattern (`src/extension.ts`, the `SessionWindow` interface and
surrounding management code) is the top-level abstraction for multi-session
chat tabs. Each open chat tab is a `SessionWindow`: a paired `PiService` +
`PiWebviewPanel` with a unique ID, initialization flag, streaming state, a
cached display label, and a `runtime: Runtime` field recording whether the tab
runs on the TypeScript SDK or the Rust binary.

Tabs are **mixed-runtime**: a TypeScript session and a Rust session can be open
side by side, each badged (`π TS` / `π Rust`) in the status bar and the tree.

## Why it exists

Pi Code Gui supports multiple concurrent chat sessions, each with an independent
model and thinking level. Without a structured container that pairs the SDK
lifecycle manager (`PiService`) with the UI panel (`PiWebviewPanel`), managing
lifecycle, focus, disposal, and restore would be spread across global state.

The pattern centralizes: a `sessions: SessionWindow[]` array in `extension.ts`
tracks all open sessions; `activeSessionWindow` tracks the currently focused one;
`sessionCounter` ensures unique IDs even across VS Code reloads.

## Lifecycle

1. **Creation** — `createSessionWindow()` instantiates both `PiService` and
   `PiWebviewPanel`, wires up `onActivate` (sets `activeSessionWindow`) and
   `onDispose` (saves session, removes from open sessions, refreshes past list).
   The session is pushed onto the `sessions` array.

2. **Initialization** — `initSessionInBackground()` runs asynchronously: checks
   SDK install, calls `piService.initialize()`, sets `initialized = true`,
   registers tree provider, loads past sessions, and wires up event-based
   tree refreshes.

3. **Disposal** — When the webview panel closes, `handlePanelDispose()` calls
   `piService.dispose()`, removes the session from the array, refreshes the
   past sessions list, and persists remaining open sessions to workspace state.

4. **Restore** — on activation, `activate()` (extension.ts) reads the saved
   open-session refs (`{path, runtime}`) from `workspaceState` and replays them
   in a **single loop**, re-creating one `SessionWindow` per ref on its origin
   runtime via `createSessionWindow()` + `initSessionInBackground({openPath})`.
   The first restored window is set active, then `restoreActiveSession()`
   re-selects the saved active tab. With no saved sessions, the `else` branch
   instead opens one fresh session on the effective default runtime. (There is no
   `restoreAdditionalSessions()` and no `continueRecent` — those were earlier
   designs.)

## Runtime tracking

A session's runtime is **resume-follows-origin**: a session created on Rust
reopens on Rust, and likewise for TypeScript — the runtime is not re-chosen on
resume. It is resolved by `lookupSessionRuntime(path)` (`extension.ts`), which
checks a `workspaceState` runtime index keyed by session path first
(`recordSessionRuntime` writes it on create), then falls back to whether the path
lives under the Rust session storage dir (`isRustSessionPath`), defaulting to
TypeScript. New sessions pick a runtime via `resolveEffectiveDefaultRuntime`
(the `defaultRuntime` setting when both are installed; otherwise the one that is).

See [Runtime Selection](runtime-selection.md) and
[Runtime Switching UX](runtime-switching-ux.md) for the surrounding model.

## Related

- [PiService](pi-service.md) — the runtime lifecycle manager inside each SessionWindow
- [Runtime Selection](runtime-selection.md) — the TypeScript-vs-Rust split
- [Webview Panel](webview-panel.md) — the UI panel paired with PiService
- [Tree Views](tree-views.md) — how sessions appear in the sidebar

> **Last updated:** 2026-06-24 — corrected the Restore step: single loop in `activate()` (no `restoreAdditionalSessions()`/`continueRecent`)
> **Earlier:** 2026-06-21 — documented the `runtime` field, mixed-runtime tabs, and resume-follows-origin runtime resolution (`lookupSessionRuntime`)
