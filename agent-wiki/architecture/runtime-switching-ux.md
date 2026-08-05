# Runtime Switching UX

> **Status:** active
> **Last updated:** 2026-07-21 — added the `sessionHistoryScope` (unified vs perRuntime) past-session filter, the `server-process`/`archive` runtime icons, and a pointer to `rustExtensionPolicy` + the `--no-extensions` self-heal.

How users discover, choose, and switch between the TypeScript and Rust runtimes.
See [Runtime Selection](runtime-selection.md) for the engine side.

## Commands

| Command | Title | Behaviour |
|---------|-------|-----------|
| `addSession` | PiGui: Add Pi Session | `+` button; creates a session on the **remembered default** (no prompt) |
| `addSessionWithRuntime` | PiGui: Add Pi Session (Choose Runtime) | One-off runtime quick-pick |
| `addSessionTypescript` / `addSessionRust` | PiGui: Add TypeScript/Rust Pi Session | One-off session on a specific runtime |
| `setDefaultRuntime` | PiGui: Set Default Runtime | **Persists** `defaultRuntime` to Global config — remembered until changed |
| `switchRuntime` | PiGui: Switch Runtime (New Session) | Opens a NEW session on the *other* runtime (live sessions can't hot-swap) |
| `installRust` | PiGui: Install Rust Pi | On-demand install dialog |

The persisted default lives in `pi-code-gui.defaultRuntime` (ships
`"typescript"`). `resolveEffectiveDefaultRuntime()` returns it when both runtimes
are installed; if only one is installed that one is used **without** overwriting
the setting. One-off commands never mutate the default.

## Indicators

- **Sessions tree** — `makeSessionItem` / `makePastSessionItem` prefix the
  description with a `TS` / `Rust` badge and add a `Runtime:` tooltip line; past
  Rust sessions use the `server-process` ThemeIcon, TS sessions `archive`
  (`extension.ts`).
- **Past-session scope** — `pi-code-gui.sessionHistoryScope` (`"unified"` default,
  or `"perRuntime"`) controls whether the past-sessions list merges both runtimes'
  session pools or shows only the active runtime's (`refreshPastSessionsList`).
- **Status-bar chip** — `pi-sb-runtime` shows `π TS` / `π Rust`; clicking it runs
  `switchRuntime`. Fed by the `runtime` field added to the `status` /
  `status-update` protocol messages (`reportStatus`, the ready post, and the
  webview poll all include it).

## Menu gating (setContext keys)

`refreshRuntimeContext()` sets `pi-code-gui.tsAvailable`, `rustAvailable`,
`bothAvailable`, `anyAvailable`. When `bothAvailable`, the Sessions view title
adds `addSessionRust` / `addSessionTypescript` / `setDefaultRuntime`, and the
session context menu adds `switchRuntime`.

## Lazy discovery & install

Detection runs once in `activate()` (before session restore). If neither runtime
is installed, the user picks one (`offerInitialRuntimeChoice`). A session that
targets a missing runtime triggers the install gate in
`initSessionInBackground`, which routes to `installPi()` (TS) or the
`installRust` dialog (managed download / curl / manual / detect). Nothing is
installed without an explicit choice.

## Rust extensions & self-heal

Rust sessions spawn with an extension policy from `pi-code-gui.rustExtensionPolicy`
(default `"balanced"`) and a `rustExtensions` mode (`"auto" | "enabled" | "disabled"`).
On `"auto"`, if startup fails with the extension-conflict signature,
`RustService.initialize` retries once with `--no-extensions` and surfaces a one-time
info toast — so a broken extension can't block the session (see
[Runtime Selection](runtime-selection.md) for the engine side).

## Resume-follows-origin & restore

`openSessionPaths` is persisted as `OpenSessionRef[]` (`{path, runtime}`), with a
legacy `string[]` fallback. A workspaceState index (`sessionRuntimeIndex`) maps
path → runtime; `lookupSessionRuntime()` falls back to the storage location (the
Rust pool has its own directory) then to the default. Resume from the tree, fork,
and reload all reopen a session on the runtime that created it.

## Concurrent mixed-runtime sessions

Each tab is its own `PiService`; PiService holds no module-level singletons, so a
TypeScript tab and one or more Rust tabs (each a dedicated `pi --mode rpc`
subprocess) coexist. Closing a tab disposes only that tab's runtime.

## Cross-reference

- [Runtime Selection](runtime-selection.md)
- [Session Window](session-window.md)
- [Tree Views](tree-views.md)
