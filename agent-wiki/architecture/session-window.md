# Session Window

> **Status:** stable

The Session Window pattern (`src/extension.ts`, the `SessionWindow` interface and
surrounding management code) is the top-level abstraction for multi-session
chat tabs. Each open chat tab is a `SessionWindow`: a paired `PiService` +
`PiWebviewPanel` with a unique ID, initialization flag, streaming state, a
cached display label.

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

4. **Restore** — VS Code owns open-panel persistence. A
   `WebviewPanelSerializer` registered for `pi-code-gui.session` revives each panel
   across a reload (position, order, active tab) and hands back whatever the webview
   last persisted via `setState` — `{sessionFilePath}`, written on every
   status-update. `planPanelRestore()` (`src/panel-restore.ts`, pure and unit-tested)
   turns that untrusted state into one of three actions:

   | action | when | result |
   | --- | --- | --- |
   | `open` | the persisted session file exists | re-attach the on-disk session |
   | `fresh` | nothing was ever persisted | an equivalent fresh session |
   | `dispose` | the file is gone, or the state is a legacy one an older version saved for a retired runtime | close the revived shell rather than resurrect an empty one |

   A legacy state that carries the retired runtime's `runtime` value (saved by 0.2.7 or earlier) only causes that
   restored tab to be closed; its session file is left untouched.

   The revived panel is adopted by a new `SessionWindow` (`adoptPanel`), and a panel
   VS Code marks `active` becomes the active session.

   This **replaced** an earlier `workspaceState`-based restore that read saved
   `{path, runtime}` refs and replayed them in a loop in `activate()`. That approach
   duplicated what VS Code already does and raced it, producing double-restored
   windows.

   Note: VS Code defers deserialising a BACKGROUND restored tab until it is first
   focused, so those sessions attach lazily rather than all at activation.

## Related

- [PiService](pi-service.md) — the SDK lifecycle manager inside each SessionWindow
- [Webview Panel](webview-panel.md) — the UI panel paired with PiService
- [Tree Views](tree-views.md) — how sessions appear in the sidebar

> **Last updated:** 2026-11-12 — Second runtime removed (0.2.8): no per-window runtime, runtime index or badges; a legacy saved state of the retired runtime closes its restored tab.
> **Earlier:** 2026-08-05 — the Restore step now describes the WebviewPanelSerializer
> + `planPanelRestore()` path. The previous text (2026-06-24) documented the
> workspaceState loop that had already been replaced for racing VS Code's own
> panel persistence.
> **Earlier:** 2026-06-21 — documented the `runtime` field, mixed-runtime tabs, and resume-follows-origin runtime resolution (`lookupSessionRuntime`)
