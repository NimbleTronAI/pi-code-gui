# Webview Panel

> **Status:** stable

PiWebviewPanel (`src/webview-panel.ts`) manages a single VS Code webview chat
panel — the visual UI that the user interacts with. Each `SessionWindow` owns
one PiWebviewPanel, which renders streaming responses, thinking blocks, tool
execution results, bash output, and custom messages.

## Why it exists

The webview panel is the entire user-facing chat experience. It handles HTML/CSS/JS
rendering, bidirectional messaging with the extension host, tab title indicators
(streaming/idle/init), and user interactions (send prompt, abort, settings toggles,
model/thinking pickers). Separating panel logic from PiService keeps rendering
concerns out of the SDK bridge.

## Architecture

**Content delivery:** `getWebviewContent()` builds a complete HTML document with
a `<link>` to `media/style.css` and a single script reference to `media/bundle.js`. The bundle is
built by esbuild from the TypeScript modules in `src/webview/` (state, debug,
render engine, tools, handlers, and main entry).

**Message protocol:** Two typed channels:

1. **Webview → Extension** (via `onDidReceiveMessage`): prompt submission,
   abort, settings toggles, model/thinking pickers, slash commands, URL/file
   open requests, user message history requests, and queue operations.
   Typed as `WebviewToExtension` from `src/shared/protocol.ts`.

2. **Extension → Webview** (via `postMessage`): streaming deltas
   (`stream-delta`, `thinking-delta`), tool lifecycle events, bash output,
   status updates, settings state, user message lists, slash command lists,
   and errors.
   Typed as `ExtensionToWebview` from `src/shared/protocol.ts`.

**Tab indicators:** `updateTabIndicator()` sets the webview panel title with
`●` (streaming) or `○` (idle) prefix, plus the session name (AI-generated
summary, stored session name, or fallback label).

**Slash commands:** `handleSlashCommand()` intercepts builtin commands (`/login`,
`/logout`, `/model`, `/thinking`, `/sessions`, `/settings`) and forwards unknown
commands to the Pi session for extension handling.

## Related

- [PiService](pi-service.md) — the SDK bridge that feeds events to the panel
- [Webview Frontend](webview-frontend.md) — the TypeScript modules that run inside the webview
- [Session Window](session-window.md) — the pairing that owns this panel

## Where a chat opens (#83)

The column was hardcoded to `vscode.ViewColumn.Two`, which is not "beside the active
editor" but literally column two: a user working in a single group got a split forced
open on every session, and a user in column three got the chat somewhere unrelated.

The default is now `ViewColumn.Beside` — what the original value was trying to express,
and correct from any column — with `pi-code-gui.panelLocation: "active"` opening the
chat as a tab in the current group instead. Parsing lives in the vscode-free
`panel-restore.ts` so it is headlessly testable, and an unrecognised value falls back
to `beside`: a hand-edited setting must not stop a chat from opening.

Restored panels are unaffected — VS Code returns them to their remembered column,
which is the wanted behaviour.

## The mode strip

`#pi-mode-strip` sits between the transcript and `#input-area`, above the composer
rather than in the status bar below it: it declares what the **next** prompt will do,
where the status bar reports what already is. It is Rust-only and hidden otherwise.
See [Session Modes](session-modes.md).

> **Last updated:** 2026-08-31 — added the panel-column fix (#83) and the mode strip.
