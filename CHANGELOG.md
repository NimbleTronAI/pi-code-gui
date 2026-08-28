# Change Log

## [0.1.13]

### Changed
- **Rust Pi is now pinned to v0.3.0** (was v0.1.23) — the version the managed install downloads and the extension is tested against. 0.3.0 enables ten more tools by default (`web_search`, `lsp`, `debug`, `ast_grep`/`ast_edit`, `todo`, `jobs` and others) and adds the `ask` question card, which 0.1.11 taught the extension to answer. An existing binary keeps working and is not replaced; you'll get a one-time notice that it differs from the tested version.

### Fixed
- **Rust sessions wouldn't start on rust-pi 0.3.0: `auth.json must be a regular non-link file`.** The extension symlinked `auth.json` into the Rust agent home so a later `/login` tracked automatically; 0.3.0 hardened against linked credentials and exits immediately (code 1) when it finds one. Every session created before 0.3.0 left a symlink there, so this broke every existing user on upgrade. It's now a regular file, and an existing symlink is migrated on the next session start. A `/login` still reaches Rust — the copy is refreshed when the source is newer, so reopen the session after logging in.
- **Option dialogs couldn't be answered, and left the chat frozen.** Three separate faults, all reachable the moment rust-pi's `ask` tool started opening these routinely: options rendered as raw HTML instead of clickable rows (escaped twice); once visible they had no click handler and the key handler sat on an element that could never take focus, so OK always committed the first option; and closing the dialog left an empty full-screen layer over the UI that swallowed every click and scroll for the rest of the session. Clicking now selects, double-click commits, arrows/Enter/Escape work, and the dialog cleans up after itself.

### Added
- **`pi-code-gui.panelLocation`** — open a chat as a tab in the current editor group (`active`) instead of splitting off a second one (`beside`, the default and previous behaviour). Useful on a single screen. Restored chats return to wherever they were. (#83)

## [0.1.12]

### Fixed
- **Windows: the SDK went undetected when the npm prefix is itself on `PATH`.** Candidates were only ever derived from the PATH entry's *parent*, so a layout like `D:\nodejs` (packages in `D:\nodejs\node_modules`) had none — the extension reported "SDK is not installed" while `pi --version` worked in a shell. Also affects nvm-windows. The PATH entry itself is now probed, on every platform. (#81)

## [0.1.11]

### Changed
- **DeepSeek V4 sessions show `$??` instead of a cost.** DeepSeek bills by time of day (peak is 2x off-peak) and doesn't report the billed amount, so any figure from the flat-rate catalog is wrong — currently understating by 2.3x-4.6x. Hover the status chip for why. DeepSeek via a gateway (OpenRouter, Vercel AI Gateway) is unaffected.

### Fixed
- **A project extension that hangs startup no longer kills the session.** rust-pi can start, fail to load a `.pi/settings.json` package, then never answer `get_state` — failing the session after 15s with an error naming the RPC, not the package. It now retries once without project extensions and names the culprit. Set `pi-code-gui.rustExtensions` to `disabled` to skip the retry.
- **An `ask` question from the agent no longer hangs the session.** rust-pi 0.3.0 enables its `ask` tool by default and blocks the turn until a client answers; the extension had no route for the event, so the session sat for five minutes with no way to reply. Questions now appear as a picker, and cancelling dismisses the card.
- **Project-local `.pi/` config loads again on rust-pi 0.3.0.** That release gates packages and extensions behind workspace trust and skips them silently for non-interactive launches. The extension now passes `--trust` when VS Code itself trusts the workspace; untrusted workspaces still get nothing.
- `$??` now explains itself on hover in every case, including models with no published per-token rate.

## [0.1.9] — [0.1.10]

No functional changes — dependency bumps the release automation versioned automatically.

## [0.1.8]

No user-facing change — a release-pipeline fix.

### Security
- **The supply-chain scan now runs before publishing, not only in CI.** `check-currency.mjs`
  rejects known-compromised dependency versions, indicators of compromise, and install hooks
  outside the allowlist. It ran only in ci.yml, which cannot gate a release: CI and the release
  workflow trigger on the same push and run concurrently, so the publish is dispatched — and can
  finish — before CI reports. In 0.1.7 the publish completed 15 seconds after CI, having never
  waited for it. Every other CI check was already re-run at publish time via `vscode:prepublish`;
  this scan was the only one that was not, so a compromised package could be installed and
  bundled into the `.vsix` unscanned. Both publish jobs now run it themselves.

## [0.1.7]

Carries the Windows fix below, which 0.1.6 tagged but never shipped.

### Fixed
- **Automated releases were rejected before they could publish.** The `marketplace` environment
  admits only tag refs matching `v0.*`, and release.yml dispatched the publish with `--ref main`,
  so both jobs failed in about two seconds with no runner assigned and no steps run — which reads
  as a build failure and is not one. That stranded v0.1.6. The dispatch now targets the tag it
  just created.

  Corrects the surrounding comments as well: they described the publish as gated behind the
  environment's required reviewers and said a release "won't ship anything on its own". That
  gate does not exist — the environment has no required reviewers and no wait timer, so a
  merge to main now goes live unattended.

## [0.1.6]

Tagged and released, but never reached either marketplace — see 0.1.7. Nothing to install here.

### Fixed
- **The TypeScript runtime could not start on Windows.** SDK modules are loaded by absolute path, and Node's ESM loader reads a Windows path's drive letter as a URL scheme (`Received protocol 'c:'`), so every session failed at startup. Paths are now converted with `pathToFileURL`. (#71)

## [0.1.5]

No functional changes — a dependency bump to the development container (Node 22 → 24)
that the release automation versioned automatically. Nothing users install differs from 0.1.4.

## [0.1.4]

### Changed
- Refreshed the bundled model catalog from pi-ai 0.84.1 — 2 new providers, 88 models added, and **36 corrected prices**. Most notably `gpt-5.6-luna`, which was being costed at 5x its real input rate. Models withdrawn upstream (including `claude-opus-4-1`) now show `$??` rather than a stale figure.

## [0.1.3]

### Security
- Escaped raw inline HTML and sanitized link schemes in chat rendering. Model output containing raw HTML (e.g. `<img onerror=...>`) or `javascript:`/`data:`/`file:`/`ftp:` markdown links is now rendered as literal text or a non-clickable span instead of being injected into the DOM. The link-href guard (`safeInlineLinkHref`) shares its scheme allowlist with the `openUrl` handler's `safeExternalUrlString`, so the two paths never drift on which schemes are allowed.

## [0.1.2]

Republish of 0.1.1 with no functional changes. 0.1.1 reached the VS Code Marketplace,
but its Open VSX publish failed before packaging, leaving the two registries on
different versions. This release exists so both carry the same build — if you are
already on 0.1.1 there is nothing new here.

### Fixed
- The Open VSX publish job failed to package the extension. (Release tooling only; no change to the extension.)

## [0.1.1]

The first release with the **Rust runtime**. Sessions now run on either the
in-process TypeScript Pi SDK or the out-of-process Rust Pi binary, chosen per session.

### Added
- **Rust runtime.** Each session runs on the TypeScript SDK or the Rust binary (`pi --mode rpc`). New sessions default to TypeScript; the choice is per-session and a resumed session always reopens on its origin runtime.
- Runtime commands: **Add TypeScript/Rust Pi Session**, **Add Pi Session (Choose Runtime)**, **Set Default Runtime**, **Switch Runtime (New Session)**. A runtime chip in the status bar and a `TS`/`Rust` badge in the Sessions tree.
- **On-demand Rust install** — managed binary download (checksum-verified), the official `curl | sh` installer, manual guidance, or detect an existing binary. Each option states plainly whether it touches your `PATH` or an existing `pi` command.
- Rust Pi's `find`/`grep` tools need `fd` and `ripgrep` on `PATH`; the extension now detects their absence and links their install guides.
- Unified Past Sessions across both runtimes, badged by origin.
- **Runtime-aware Packages view** — one shared catalog, marking each package *active* (loaded by the focused session's runtime) or *available*, with provenance from the Rust catalog.
- **`max` thinking level.** Some models put their top tier behind `max` rather than `xhigh` (Kimi K3 has no `xhigh`; DeepSeek V4 Pro likewise), making those tiers unreachable before. Offered only for models that map it, and only on backends that accept it — Rust needs v0.1.23+.
- `autoOpenOnStart` — disable auto-opening a Pi tab on window start. (Thanks @oleg-deezus, #63)
- New settings: `defaultRuntime`, `sessionHistoryScope`, `rustBinaryPath`, `rustInstallMethod`, `rustExtensionPolicy`, `rustExtensions`, `rustAgentDir`.

### Changed
- **Minimum VS Code is now 1.125** (was 1.118).
- **API keys moved to VS Code SecretStorage.** The `anthropicApiKey`/`openaiApiKey` settings are **removed** — settings are plaintext, sync across machines, and are readable by any other installed extension. Use `/login` (shares `~/.pi/agent/auth.json` with the pi CLI) or `ANTHROPIC_API_KEY`/`OPENAI_API_KEY`. Existing keys migrate automatically on first reload; nothing needs re-entering.
- Secrets are redacted from the output channel and from error text shown in chat.
- Extension-supplied custom message renderers (arbitrary JS in the webview) now require explicit per-type consent.
- `sessionDir` is `machine-overridable`, and settings that execute code or redirect writes are disabled in untrusted workspaces.
- Unknown model pricing shows `$??` rather than `$0.00`, so a missing rate can't read as free.
- Provider auth failures surface as actionable messages instead of raw SDK errors.
- All logging goes to the **Pi Code Gui** output channel; nothing is written to the shared developer console.
- Migrated to the pi-coding-agent 0.80+ `ModelRuntime` API, with a prompt to update an SDK older than this build targets.

### Fixed
- **Closing a window with more than one session open lost conversation data** — teardown skipped every other session, so their unflushed history was never written.
- Closing a session from the Sessions tree left its tab open and unusable.
- The **Auto-retry** toggle did nothing on the TypeScript runtime — it flipped the UI but never reached the session, so retries continued after being switched off.
- Startup could block for seconds, or indefinitely, before any command worked; commands are now registered immediately.
- Several commands (including *Install Pi*) were never registered and failed with "command not found".
- The chat lost its pinned-to-bottom position whenever tool blocks resized on completion.
- Large writes froze the webview while streaming tool arguments.
- Quotes were not escaped in five webview render paths.
- Links and file paths from tool output are validated before opening.
- Images that fail to load degrade to alt text instead of retrying and logging errors.
- Duplicate sessions could be created for the same session file.
- The Open Sessions sweep re-read the entire session history on every refresh.
- The packaged extension no longer ships internal development files.

### Known limitations
- Under the Rust runtime: the VS Code editor-bridge tools and the `/tools` picker are unavailable, custom-card extensions fall back to markdown, session history is stored separately, and a workspace's TypeScript-format `.pi/` extensions don't load (see `rustExtensions`).

## [0.0.55]

### Fixed
- SDK resolution now scans `$PATH` instead of relying on hardcoded candidate paths. Fixes SDK-not-found on systems with custom npm prefix locations.

## [0.0.54]

### Added
- Workspace folder guard at startup — waits for VS Code to deliver workspace folders after host restart instead of falling back to `process.cwd()`.

### Fixed
- Previously open sessions now restore exactly on reload — no redundant `continueRecent` primary session created alongside restored sessions.
- `saveOpenSessionPaths` now persists after every session initializes, not just at panel close. Sessions added mid-session survive crashes.
- `vscode_apply_workspace_edit` auto-saves edited files so they don't remain dirty in the editor.
- Added yaml, sql, and diff to highlight.js languages.

## [0.0.53]

### Fixed
- `vscode_apply_workspace_edit` now auto-saves after applying edits so files don't remain dirty and open.
- Added yaml, sql, and diff to highlight.js languages (was missing yaml causing console error flood).

## [0.0.52] — Progressive session load

### Fixed
- Efficient loading of large sessions (many entries)

## [0.0.51] — Stability

### Added
- Unhandled rejection and uncaught exception handlers log crash causes to the Pi Code Gui output channel, making extension host restarts diagnosable.

### Fixed
- Tree view no longer refreshes on every PiService event (hundreds per second during streaming). Now only refreshes on visible state changes: streaming start/stop, message arrival, compaction. Eliminated a likely trigger of extension host restarts that orphaned webviews and duplicated sessions.

## [0.0.50] — Tool fixes

### Fixed
- Read tool header now shows offset/limit range (e.g. `file.ts:10-14`) even when args stream in after the initial `tool-start`. Previously `readToolRenderer.update` was a no-op and streaming-delayed args were silently dropped.
- System prompt and virtual context files no longer hard-code specific bridge tool names. Previously the LLM saw instructions like "use vscode_get_editor_state" regardless of which tools were active via `/tools`, causing hallucinated calls to disabled tools.

### Removed
- `pi-code-gui.tools` VS Code settings allowlist. Replaced by the runtime `/tools` picker with per-session persistence.

## [0.0.49] — Runtime tool selection

### Added
- `/tools` slash command — opens a grouped checkbox QuickPick (Built-in, VS Code Bridge, Extension) to select which tools are active for the current session. Pre-populated from the SDK's active tool set. Changes take effect on the next agent turn.
- Tool selection persists to the session file (`tools_active_change` entries) and restores on session resume, matching the model/thinking persistence pattern.
- `PiService.getAllTools()`, `getActiveToolNames()`, `setActiveTools()` — public API for tool inspection and control, delegating to the SDK's `setActiveToolsByName`.

## [0.0.48] — Tree stuck on "initializing" fix

### Fixed
- Session always expandable before init — shows loading spinner.
- Past Sessions header shows "loading…" / "none" states.
- Past sessions load in parallel with SDK init.

## [0.0.47] — Tree item in-place mutation fix

### Fixed
- Session tree items fail to initialize on slow loads.

## [0.0.46] — Strict linting, type hardening, tree UX fixes

### Changed
- ESLint: 14 error-level rules (was 5 warns).  `no-explicit-any`, `no-empty`
  (catches forbidden), `no-unused-vars` (catches included),
  `no-floating-promises`, `explicit-function-return-type`.
- tsconfig: `noUncheckedIndexedAccess: true`.

### Fixed
- 26 silent catch blocks now log via `piWarn()`.
- 191 `any` usages documented with eslint-disable comments.
- 78 functions given explicit return types.
- 27 floating promises `void`-prefixed or chained.
- Tree: session expandable before init (shows spinner, not locked).
- Tree: Past Sessions shows "loading…" while fetching, "none" when empty.
- Tree: past sessions load in parallel with SDK init.
- Tree: double-refresh (0ms + 50ms) works around VS Code dropping tree events
  during async setup.

### Added
- `agent-wiki/architecture/multi-backend.md` — Rust + TypeScript backend design.

### Fixed
- **Past sessions empty on cold start.**  `refreshPastOnly()` created
  a new `SessionTreeItem` on every call — VS Code matches targeted
  refreshes by reference equality, not `id`.  Now caches
  `_pastHeaderItem` from `getChildren()` and reuses the same object.

## [0.0.44] — Past sessions tree render fix

### Fixed
- **Past sessions empty on cold start.**  Header was emitted with
  `collapsibleState: None` then transitioned to `Collapsed` — VS Code
  tree diff ignores this.  Header now hidden until data is ready.

## [0.0.43] — Slash autocomplete refresh after extension load

### Fixed
- **Autocomplete stale after extension load.**  `emitSlashCommands()`
  called before `bindExtensions()` registered commands.  Now re-emits
  after `bindExtensions()`, `session.reload()`, and `reloadContext`.

## [0.0.42] — Keybinding command-not-found fix

### Fixed
- **Cmd+/ and Cmd+@ fail during slow init.**  `pickCommand` and
  `pickFile` moved to `registerEarlyCommands()` in `activate()`,
  registered synchronously before async SDK init.
- **`safeRegister` swallowed all errors** — now only catches
  "already registered".

### Added
- **`PiService.initialized` getter** — guards SDK-dependent commands.

## [0.0.41] — Dynamic slash command picker

### Added
- **`PiService.getAllSlashCommands()`** — extension + builtin + prompt
  template commands with `source` field.
- **Grouped quick-pick** in `pickCommand` — separator labels by source.

### Changed
- **`emitSlashCommands()`** pushes complete list to webview via
  `slash-commands-update`.  Autocomplete uses dynamic list when
  available, hardcoded builtins as fallback.

## [0.0.40] — Past sessions load fix

### Fixed
- **Past sessions empty on first load.**  `listSessions` retries now
  match `initialize()` (5×500ms).  Added targeted `refreshPastOnly()`
  after full refresh.

## [0.0.39] — Tool block anchors, edit formats, prompt cursor

### Added
- **`insertToolBlock()`** and **`state.lastToolInsertionEl`** — tool
  blocks now insert after the assistant message, not at chat bottom.
- **`normalizeEditArgs()`** — handles legacy `oldText`/`newText` format.

### Changed
- **`tool_execution_start` applies `prepareArguments`** from SDK tool
  definitions before emitting `tool-start`.

### Fixed
- **Edit diff dedup** — result area only shows `.details.diff` when
  previews weren't already rendered.
- **Prompt cursor garbled** — `input` handler now saves/restores
  `selectionStart`/`selectionEnd` around height recalculation.

## [0.0.38] — Tool rendering audit

### Changed
- **Tool blocks now insert after the assistant message** instead of
  appending at the bottom of the chat. 

### Fixed
- **Edit result diff no longer duplicates previews.**  

## [0.0.37] — Edit tool diff rendering fix

### Fixed
- **Edit tool** Fixed to always render red/green diff blocks in the result area.  

## [0.0.36] — Tool rendering fixes

### Fixed
- **Extension tools** now render during live streaming — `handleToolStart`
  crashed on `null.create()` for unregistered tools (anything beyond
  `bash`/`write`/`edit`/`read`). Now falls back to `defaultToolRenderer`.
- **Tool-only assistant messages** now replay correctly on reload/resume.
  Previously the `if (text || thinking)` guard in `sendInitialMessages` and
  `replayBranchEntries` skipped assistant turns that had only tool calls
  with no text, making tool executions disappear from the conversation
  history after restart.

## [0.0.35] — Session restore fix

### Fixed
- **Session restore** race condition — `saveOpenSessionPaths` inside
  `initSessionInBackground` overwrote the saved session list with only the
  primary session before `restoreAdditionalSessions` could read it, causing
  additional tabs to be lost on reload. Now snapshots saved paths before
  init and restores from the snapshot.
- **Active session** now correctly restored after reload by persisting the
  focused tab path in `workspaceState`.

## [0.0.34] — Session restore, activation fix

### Fixed
- **Session restore** now picks the correct tab after reload by persisting
  the active session path in `workspaceState`.
- **`onCommand` activation events** prevent "command not found" errors when
  editor toolbar buttons are invoked before `onStartupFinished` fires.
- **Slash commands** reverted to TUI behaviour — execute silently without
  echoing into the conversation transcript.

## [0.0.33] — Strict TypeScript, UX polish, zombie bash fix

### Added
- **Strict TypeScript** across the full codebase — `noFallthroughCasesInSwitch`,
  `noImplicitReturns`, `forceConsistentCasingInFileNames`, `isolatedModules`.
  Webview now has its own `tsconfig.webview.json` with DOM lib + same strict
  flags. `check-types` enforces both in CI.

## [0.0.32] — Live panel stacking, slash command fixes, startup resilience

### Fixed
- **Live panel notifications** now stack as separate dismissible cards instead
  of silently overwriting each other. Applies to `notify()`, `sendCustomMessage`,
  and protocol validation errors.
- **Extension slash commands** (`/tldr` etc.) now execute immediately during
  streaming via `session.prompt()` instead of being routed through
  `steer()`/`followUp()` which the SDK rejects ("extension commands cannot be
  queued"). Commands also appear in the conversation transcript.
- **Steer/queue errors** are now surfaced as live-panel notifications instead
  of becoming unhandled promise rejections.
- **SDK/TypeBox imports** retry up to 5 times on startup, handling the race
  where `npm install` populates `node_modules` concurrently with extension
  activation.
- **Dev container** no longer reinstalls `pi-coding-agent` on every start —
  only updates when a newer version exists.

## [0.0.31] — Read block polish, truncation affordance

### Changed
- **Read result** now uses native scroll instead of expand/collapse button.
  Single scrollbar (inner `.code-block` scroll disabled via CSS + JS).
- **Truncated reads** show a clickable "▼ Continue reading (N lines remaining)"
  link that inserts the follow-up command into the input bar. Handles both SDK
  hard truncation (50KB/2000 lines) and user-specified limits with remaining content.
- SDK truncation footer noise (`[Showing lines X-Y…]`, `[Truncated…]`,
  `[N more lines in file…]`) stripped from display text.

## [0.0.30] — Tool block spacing, scroll, and zombie bash fix

### Fixed
- **Read/edit tool blocks** no longer waste vertical space.
- **Bash orphan processes** — `abort()`, `dispose()`, `newSession()`, and
  `resumeSession()` now call `session.abortBash()` to signal `killProcessTree`,
  preventing long-running commands from surviving session teardown as zombies.

### Changed
- **Read result** always uses native scroll (`max-height: 20rem`) — no expand/collapse
  button.


## [0.0.29] — Protocol validation, safe HTML, component system

> Architectural upgrade inspired by the Pi TUI's RPC component model
> ([rpc-extension-ui.ts](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/rpc-extension-ui.ts)):
> typed protocol → safe rendering → component lifecycle. 3 layers, 7 steps.

### Added
- **Zod protocol validation** on every postMessage boundary — 37 extension→webview
  + 16 webview→extension schemas catch missing fields, unknown types, and malformed
  data at runtime with visible diagnostic notifications.
- **`html` tagged template** (`src/webview/render/html.ts`) auto-escapes all
  interpolated values via `textContent`; only `safe()`-wrapped content renders as HTML.
- **Micro component system** (`src/webview/components/`) — `CodeBlock`, `ToolBlock`,
  `ThinkingBlock`, `LiveCard`, `InlineCard`, `Dialog` — each owns its DOM subtree
  with mount/update/destroy lifecycle.
- **Interactive dialogs** for extension `select()`/`confirm()`/`input()` — overlay
  with keyboard navigation returning Promises via `extension_ui_response` messages.
- **Persistent status bar** — `setStatus` widgets render as inline badges in the
  footer instead of collapsible live-cards.
- **Copy All** button on `/debug` output.

### Fixed
- **Streaming jitter** caused by TextNode/Element indexing mismatch in
  `patchBlockList` — space tokens now return empty `<span>` elements.
- **Double scrollbar** on write tool — CSS override disables inner `.code-block`
  overflow when inside `.tool-scroll-view`.
- **Read block** no longer shows empty result — tool renderer now uses `ToolBlock`
  component and `CodeBlock.mount()`.
- **Bash output** auto-scrolls to bottom during streaming.

## [0.0.27] — Fix renderer CSP violation

### Fixed
- **Custom message renderer** switched from `eval()` to `<script nonce>` injection,
  fixing CSP violation when extensions register renderers.

## [0.0.26] — Fix custom message renderer timing and production builds

### Fixed
- **`globalThis.__piRegisterMessageRenderer`** now injected before
  `createAgentSession()` so extensions find it during load, not after.
- **`escapeHtml`** now passed as a renderer parameter instead of relying
  on closure scope, fixing breakage in production builds where esbuild
  renames identifiers.

## [0.0.25] — Inline custom messages, user message selector, UX fixes

### Added
- **`globalThis.__piRegisterMessageRenderer`** bridge: extensions running in the
  extension host (Node.js) can now register renderers that execute in the webview
  DOM. Accepts `(customType, sourceCode)` as a string.
- **User message selector** keyboard navigation: up/down arrows scroll the list,
  Enter picks the highlighted item, Escape dismisses.

### Fixed
- **Live-card notifications** no longer show content expanded with a collapsed
  toggle icon.
- **Slash command picker** now spans the full webview width and truncates long
  descriptions with ellipsis.
- **Write tool block** consistent height during streaming (max-height scroll-view,
  no jitter at size boundary).

## [0.0.24] — highlight.js, custom message renderer, and UX polish

### Added
- **Custom message renderer**: `display: true` messages now render inline in the
  conversation stream with support for registered `MessageRenderer` functions,
  interactive `[data-command]` action buttons, and polling-based in-place updates.
  See [README § Custom Message Renderers](./README.md#custom-message-renderers-extension-api)
  for the extension developer API.

### Changed

### Changed
- **Syntax highlighting** replaced hand-rolled regex highlighter with **highlight.js**, in all code paths.
- **Bash tool** shows a spinning indicator during execution.

### Fixed
- **Slash command picker**: Enter now inserts the selected command instead of submitting
  just the `/` prefix.
- **F5 development**: `preLaunchTask` now watches the webview bundle alongside the
  extension bundle, eliminating stale-webview confusion.
- **Read/write/edit blocks** consistent height, single scrollbar, no collapse/expand
  toggles.

## [0.0.23] — Thinking fade, write resize, and HTML breakout fixes

### Fixed
- **Thinking block fade** removed - scrollbars indicated "more" available.
- **Write tool block** height is now capped to the same 10-line collapsed view
  during streaming, eliminating the jarring resize on the active→done transition.
- **HTML breakout guard**: `renderMarkdown` now escapes raw `&`, `<`, `>` in
  read-tool results, tool-result short text, and truncation show-more toggles,
  preventing file content like `</div>` from breaking the chat layout.

## [0.0.22] — Webview rewrite: TypeScript modules, typed protocol, modern CSS

### Changed
- **Webview rewritten** from 3 monolithic vanilla-JS files into 6 TypeScript ES modules
- **CSS extracted** from inline `<style>` block to `media/style.css`, organized in
  `@layer tokens, base, components` with native CSS nesting.
- **Build pipeline** now bundles the webview via esbuild alongside the extension,
  with source maps in dev and minification in production.

### Removed
- `media/app.js`, `media/core.js`, `media/tools.js` — replaced by `src/webview/` modules.

## [0.0.21] — Model picker pricing & picker de-duplication

### Added
- **Model picker** shows SDK-reported pricing and context window in the detail line (e.g. `$3/$15 per M tokens · 200K context`). No pricing shown when the SDK isn't available.


## [0.0.20] — Slash commands, fork/clone, and UX hardening

### Changed
- **Fork** creates a new session window from any message entry or past session — original session untouched.
- **Clone** creates an independent copy of the current session in a new tab.
- **Edit blocks** show full text (no 300-char truncation) with scrollable 200px max-height.

### Fixed
- **Slash commands**: `/compact`, `/name`, `/tree`, `/export`, `/reload`, and `/clone` now route to the SDK directly instead of being sent as raw text to the LLM.
- **Queue/steer indicator** visible again — added `flex-shrink: 0`.
- **Context menus** added for compact, clone, export, and reload on open sessions.

## [0.0.19] — Status bar, stable names & restore polish

### Changed
- **In-webview status bar** Reverted to v0.0.16 statusbar.
- **Stable Session names** They stay the same between active and historical sessions.
- **Streaming indicator** unified across tab, Open Sessions tree, and webview bar as `●`/`○` bullets, using theme-aligned colors.
- **Diff readability** improved.

### Fixed
- **Session restore** Reduce flashing while rendering.

## [0.0.18] — Steer/Queue & thinking block polish

### Changed
- **Steer/Queue split button** replaces single submit when streaming, with ▾ toggle to switch modes — Enter key follows selection.
- **Thinking blocks** show 10-line scrollable preview with gradient fade, expand button only when overflowing.
- **Queue indicator** shows labeled Steer/Queue items with per-item promote button and bulk clear.
- **Read/edit/write tool headers** show clickable filenames that open in the VS Code editor.

### Fixed
- **Session Panel** can now navigate to specific entries in current conversations.

## [0.0.17] — Marked rendering & webview modularization

### Changed
- **Markdown rendering** uses marked parser for correct GFM handling.
- **Text streaming** renders via token-diff — only the last block morphs each frame instead of full re-render.
- **Webview split** into 5 files (core, tools, app, morphdom, marked) with shared `__pi` namespace.
- **Duplicate tool renderers** removed — old copy discarded, v2 retained with rAF-batched streaming and edit count display.

### Fixed
- **Double `acquireVsCodeApi` call** prevented extension initialization.
- **Session event handlers** restored after extraction loss.
- **Edit/receive/queue buttons** rationalized for stop/steer/queue tri-action.

## [0.0.16] — Session UX polish

### Fixed
- **Model and thinking level** persist across close and reopen.

### Changed
- **Status bar** shows model, thinking, and budget — clickable for quick settings.

### Added
- **`/model`, `/thinking`, `/sessions`** slash commands open native pickers.

## [0.0.15] — Debug & bash

### Fixed
- **Bash blocks** not displaying output.

### Added
- **`/debug` slash command** dumps webview state inline.

## [0.0.14] — Renderer registry

### Changes
- Improved internal tool rendering event handlers.

## [0.0.13] — Namespace migration

### Changes
- SDK dependency switched to `@earendil-works/pi-coding-agent`.
- Extension widget live panel cards persist until dismissed.
- Widget bridge catches missing TUI methods gracefully.

## [0.0.12] — Widget bridge

### Changes
- Live panel renders extension widgets as updating cards.
- Unknown slash commands forwarded to pi session.
- Open sessions persist across VS Code reloads.

## [0.0.11] — Package manager

### Changes
- Packages view for install, uninstall, search, update.
- Scroll catches up on tab return after background streaming.
- Session resume restores model/thinking on restart.

## [0.0.10] — Defaults & context budget

### Changes
- Default model and thinking level saveable from picker.
- Context budget setting controls auto-compaction trigger.
- Budget shown in status bar.

## [0.0.9] — UX polish

### Changes
- Auto-scroll pauses on manual scroll up, resumes near bottom.
- Streaming cursor changed to subtle vertical bar.

## [0.0.8] — Login & logout

### Changes
- `/login` opens auth flow with provider selection.
- `/logout` removes stored credentials.
- Startup check verifies dependency files exist.

## [0.0.7] — Initial Release

First public release — native VS Code chat for the Pi coding agent.

### Features
- **Chat panel** with streaming text, thinking blocks, tool rendering, syntax-highlighted code.
- **17 VS Code bridge tools** for editor state, diagnostics, symbols, hover, definitions, references, and edits.
- **Multi-session** — independent panels with per-session model and thinking level.
- **Session tree** — browse, fork, reveal, copy entries.
- **Past sessions** — resume, delete, filter.
- **Tab indicator** with streaming/idle/init states.
- **Bash blocks** with command output and exit codes.
- **Code blocks** syntax-highlighted for JS/TS, Python, Rust, HTML, CSS, Shell, JSON, Java, Go.
- **Truncation** with show-more for long results.
- **User message history** with up-arrow recall.
- **Settings overlay** for auto-compaction, auto-retry, image display.
- **Auto-install** prompt for pi-coding-agent.
- **Quickstart guide** when no API key configured.
- **Keybindings** and **custom slash commands**.
