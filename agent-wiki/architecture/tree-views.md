# Tree Views

> **Status:** evolving

Tree Views (`src/extension.ts` — `MultiSessionTreeProvider` inner class, and
`src/pi-packages-tree-provider.ts` — `PiPackagesTreeProvider`) are the two
sidebar tree views in the Pi Code Gui activity bar: **Sessions** and **Packages**.
They provide VS Code-native UI for browsing, managing, and interacting with chat
sessions and Pi packages.

## Why they exist

The tree views are the primary navigation surface beyond the chat panel itself.
Without them, users would need to manage sessions via file system or command
palette, and package management would require terminal commands. The tree views
make session browsing, forking, deletion, and package install/update/uninstall
accessible through VS Code's standard sidebar UX.

## Sessions tree (`MultiSessionTreeProvider`)

A two-section tree:

**Open Sessions** — each open `SessionWindow` appears as a tree item showing:
- Session label with `●`/`○` streaming indicator
- Model and thinking level as a description
- Expandable to show: Model picker, Thinking picker, Entries header
- Entries header expands to show individual messages (user, assistant, custom)
  with context menu actions: Reveal in Chat, Copy Text, Fork from Message

**Past Sessions** — persisted `.jsonl` files on disk, loaded via
`PiService.listSessions()`. Filterable by text content. Context menu: Resume,
Fork, Delete. Bulk delete-all available.

Key design decisions:
- Expand/collapse state is tracked and preserved across refreshes
- Past sessions are loaded asynchronously with a refresh-only mode
- Tree items carry `command.arguments` for context menu action routing
- The active session is tracked independently for command targeting
- Entry children are cached by entry count — rebuilt only when the count changes,
  avoiding redundant tree item construction on every refresh
- Tree refresh is state-change-aware: only fires on visible changes
  (streaming start/stop, message arrival, compaction, turn/assistant end)
  rather than on every PiService event, preventing VS Code tree renderer overflow
- Session entries replay progressively on resume (top-down, yielding between
  each entry) — large sessions no longer crash the extension host

## Packages tree (`PiPackagesTreeProvider`)

A two-section tree:

**Installed** — packages from `.pi/` config, each expandable to show:
- Description, badges (version, license, downloads, publisher), keywords, links
  (npm, repo, homepage)
- **Safety/provenance row** (risk · capabilities · source) from `rust-pi info`,
  fetched in the background and cached per source
- Actions: Uninstall, Update (if available)

**Marketplace** — search results from npm registry filtered for Pi packages
(`pi-` prefix, pi-related keywords). Each item expandable with the same
overview format plus an Install action with scope picker.

### Runtime-aware: shared catalog, available vs active

Packages are **one shared ecosystem** across both runtimes (same npm-format
packages, same `.pi/` locations) — see [Runtime Selection](runtime-selection.md).
The view follows the **focused session's runtime** (`setFocusedRuntime()`, driven
from `setActiveSession`):

- The Installed header shows the runtime + active count (`Rust · 0/1 active`).
- Each package is marked **active** (loaded by that runtime) or **available, not
  loaded** (dimmed `circle-slash`). `PiPackageService.computeActiveSources()`:
  TypeScript → every non-filtered package; Rust → none when `rustExtensions`
  disables discovery, else the `rust-pi doctor`-compatible ones.
- Installing under a focused Rust session warns (and points at `rustExtensions`)
  when the package won't load — `checkRustLoadability()`.

`PiPackageService` is backend-pluggable: the TypeScript SDK's
`DefaultPackageManager` when present, else the **Rust binary**
(`rust-pi list/install/remove/update`, see `src/rust-packages.ts`) so Rust-only
installs still manage the same store. Search stays on the npm registry
(runtime-independent).

Key design decisions:
- Marketplace search is debounced (2s minimum) with result caching
- Banner images fetched from GitHub READMEs in background
- Update availability checked via `checkForUpdates()` on refresh (SDK backend only)
- Installed packages enriched with marketplace metadata for richer display

## Related

- [Session Window](session-window.md) — the data source for open sessions
- [Runtime Selection](runtime-selection.md) — shared package ecosystem; per-runtime active state
- [PiPackageService](https://github.com/NimbleTronAI/pi-code-gui/blob/main/src/pi-package-service.ts) — the data source for installed and marketplace packages

> **Last updated:** 2026-06-05 — runtime-aware Packages view: shared catalog, available vs active, Rust binary backend, safety signals
