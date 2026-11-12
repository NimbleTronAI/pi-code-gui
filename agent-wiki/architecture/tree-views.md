# Tree Views

> **Status:** stable

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
- Actions: Uninstall, Update (if available)

**Marketplace** — search results from npm registry filtered for Pi packages
(`pi-` prefix, pi-related keywords). Each item expandable with the same
overview format plus an Install action with scope picker.

### Available vs active

Each installed package is marked **active** (loaded by a session) or **available, not
loaded** (dimmed `circle-slash`). `PiPackageService.computeActiveSources()` treats every
configured, non-filtered package as active. The Installed header shows the active count
(for example `1/2 active`).

`PiPackageService` wraps the SDK's `DefaultPackageManager` for list, install, remove and
update. Search stays on the npm registry.

Key design decisions:
- Marketplace search is debounced (2s minimum) with result caching
- Banner image URLs are resolved from GitHub READMEs in the background, but **do
  not currently render** in the tree: the tooltip `MarkdownString` is not marked
  `isTrusted`, so VS Code strips the `![]()` images. Treat banners as
  non-functional until a trusted MarkdownString is wired.
- Update availability is checked via `checkForUpdates()` on refresh, which asks the SDK's
  package manager (`checkForAvailableUpdates`) and returns `[]` when it is unavailable or throws.
- Installed packages enriched with marketplace metadata for richer display

## Related

- [Session Window](session-window.md) — the data source for open sessions
- [SDK Resolution](../operations/sdk-resolution.md) — where the package manager's SDK comes from
- [PiPackageService](https://github.com/NimbleTronAI/pi-code-gui/blob/main/src/pi-package-service.ts) — the data source for installed and marketplace packages

> **Last updated:** 2026-11-12 — Second runtime removed (0.2.8): the Packages view labels no runtime, has no safety row and no second package backend; sessions carry no badge.
> **Earlier:** 2026-06-24 — noted banner images are non-functional (no `isTrusted` MarkdownString)
> **Earlier:** 2026-06-05 — available vs active Packages view
