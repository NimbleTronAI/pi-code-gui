# Webview Frontend

> **Status:** stable

The Webview Frontend is the chat UI running inside each VS Code webview panel.
It renders streaming responses, thinking blocks, tool execution results, bash
output, code blocks, and extension widgets in real time.

## Architecture

The frontend was rewritten from 3 monolithic vanilla-JS IIFE files into 6
TypeScript ES modules in `src/webview/`, bundled via esbuild to a single
`media/bundle.js`. CSS is in `media/style.css`, organized in `@layer tokens,
base, components` with native CSS nesting.

| File | Purpose |
|------|---------|
| `state.ts` | Single source of truth for all mutable state (DOM refs, boolean flags, tool tracking, overlays, slash commands). Auto-initializes DOM refs on import. |
| `debug.ts` | Debug logging infrastructure: event log, DOM mutation observer, `/debug` command. Exposes `window.__piDebug` for DevTools inspection. |
| `render/engine.ts` | All rendering functions: markdown parsing (marked), diff viewing, code block wrappers with line numbers and copy buttons, block-level streaming, tool result expandable display, DOM helpers (escapeHtml, createMessageEl, createThinkingBlock, createToolBlock, morphRender). Syntax highlighting delegates to `highlight.ts`. |
| `tools/index.ts` | Tool renderers for write/edit/read/bash operations. Each renderer handles the create→update→finalize lifecycle. Registers itself with the tool renderer registry on import. |
| `highlight.ts` | highlight.js setup: language registration, aliases, `highlightCode()` function. Exports a single safe highlighting entry point used by `renderFileContent` and `renderCodeBlockHTML`. |
| `handlers/index.ts` | Message router (window.addEventListener) dispatching 30+ event types: agent lifecycle, stream deltas, thinking deltas, tool execution, status updates, batch replay, compaction, auto-retry, slash commands, widget bridge, errors, user commands. Also contains all UI wiring (input area, status bar, settings overlay, slash autocomplete). |
| `main.ts` | Entry point. Acquires VS Code API, initializes debug observer, sets up code block handlers, scroll tracking. |

## Build pipeline

```
src/webview/*.ts  ──esbuild──►  media/bundle.js  ──<script>──►  webview HTML
     ↑                              ↑
     └── imports from state.ts,     └── loaded by webview-panel.ts
         debug.ts, engine.ts            via getWebviewContent()
```

`media/entry.js` is a 3-line shim that imports `morphdom.js`, `marked.min.js`,
and `main.ts` in order. esbuild bundles everything into a single IIFE.

## External dependencies

- **morphdom** (`media/lib/morphdom.js`) — efficient DOM diffing/patching.
- **marked** (`media/marked.min.js`) — GFM-compliant Markdown parser.
- **highlight.js** (bundled via esbuild from npm) — syntax highlighting for ~12 languages.
  morphdom and marked are loaded as globals; highlight.js is tree-shaken from the app bundle.

## Type safety

Message types are defined in `src/shared/protocol.ts` as Zod-validated schemas
with derived TypeScript types:
- `ExtensionToWebview` — 38 event types from extension to webview
- `WebviewToExtension` — 17 command types from webview to extension
- `PiServiceEvent` — alias for `ExtensionToWebview` (all events through `emit()`)

Runtime validation via Zod is wired on the **extension→webview** direction only,
at all three of its hops (`validateExtensionToWebview`):
- **`emit()`** in `pi-service.ts`: validates outgoing events; logs + notifies on
  schema violations without blocking dispatch
- **`postMessage()`** in `webview-panel.ts`: validates extension→webview messages
  before calling `panel.webview.postMessage()`
- **Webview message listener** in `handlers/index.ts`: validates incoming messages
  against the schema; unknown fields are stripped (Zod v4 default)

This catches protocol drift on the outbound path with visible diagnostic
notifications. **The inbound webview→extension boundary is NOT yet validated:**
`validateWebviewToExtension` is defined and exported in `protocol.ts` but is
**never called** at `onDidReceiveMessage` (webview-panel.ts) — wiring it
(warn-only) is tracked as a later hardening step. Don't describe the inbound
direction as Zod-checked until that lands.

## Key rendering patterns

- **Token-diff streaming:** During streaming, only the last assistant message
  block is morphdom-updated — the rest is static. This avoids full re-renders
  on every token delta.
- **Batch replay:** On initial load, the chat container gets a `.no-animate`
  class so history messages render instantly without fade-in animations.
- **Thinking collapse:** Thinking blocks show a scrollable preview with a
  gradient fade. A "Show more" button expands them.
- **Tool result collapse:** Long tool results get a `max-height` with a
  gradient overlay. "Show more" expands them; "Show less" collapses back.
- **Code syntax highlighting:** Code blocks use highlight.js with CSS classes
  (`.hljs-keyword`, `.hljs-string`, `.hljs-number`, etc.) mapped to VS Code
  `--vscode-symbolIcon-*` variables. See [Syntax Highlighting](syntax-highlighting.md).

## Interactive dialogs

`src/webview/components/dialog.ts` provides a `Dialog` component that overlays the
prompt area for interactive extension UI methods (`select`, `confirm`, `input`).
Wire up via `bindExtensionUI` in `pi-service.ts`:
- Methods return Promises that resolve when the user dismisses the dialog
- Dialog response posted back as `extension_ui_response` message
- Keyboard shortcuts: Enter (confirm), Esc (cancel), Up/Down (navigate)

## Persistent status

`setStatus` widgets render as inline badge indicators in `#pi-extension-status`
(within the `#pi-status-bar` footer) instead of collapsible live-cards.
Status keys prefixed `status-` are routed by `handleWidgetUpdate` to the
status bar. Regular `setWidget` calls still render as live-cards unchanged.

## Component system

`src/webview/components/` contains micro-components that own their DOM subtrees
with lifecycle hooks (`mount`, `update`, `destroy`). Each component creates its
DOM in the constructor and exposes a `.el` property.

| Component | File | Replaces |
|-----------|------|----------|
| `Component<P>` | `types.ts` | Interface (no prior) |
| `CodeBlock` | `code-block.ts` | `renderFileContent`, `renderCodeBlockHTML` |
| `ThinkingBlock` | `thinking-block.ts` | `createThinkingBlock` + ad-hoc toggle |
| `LiveCard` | `live-card.ts` | `createLiveCard` + DOM manipulation |
| `InlineCard` | `inline-card.ts` | `renderInlineCustomMessage` |
| `ToolBlock` | `tool-block.ts` | Per-tool `create()` DOM builders |

Components own their state — e.g., `LiveCard` owns collapse/expand toggle,
`ThinkingBlock` owns spinner visibility and line count. No cross-component
CSS interference because scroll containers are scoped to their owning component.

## Safe HTML builder

`src/webview/render/html.ts` provides a tagged template literal `html` that
auto-escapes all `${...}` interpolated values via `textContent` assignment.
Trusted HTML (from `renderMarkdown()`, `highlightCode()`, etc.) bypasses
escaping when wrapped in a `safe()` marker.

All DOM-building functions in `engine.ts`, `tools/index.ts`, and
`handlers/index.ts` have been migrated from string concatenation
(`'<div class="' + x + '">'`) to the `html` tagged template. This eliminates
the entire class of HTML injection and CSS token leakage bugs.

## Related

- [Webview Panel](webview-panel.md) — the extension-host side that loads the bundle
- [Bridge Tools](bridge-tools.md) — tools whose results render here
- [Extension UI Bridge](extension-ui-bridge.md) — widgets that render as live cards
- [Syntax Highlighting](syntax-highlighting.md) — highlight.js integration
- [Streaming Pipeline](streaming-pipeline.md) — RAF-batched rendering
- [Component System Proposal](component-system-proposal.md) — proposed architectural upgrade

> **Last updated:** 2026-06-24 — corrected schema counts (38 events / 17 commands) and removed the false "webview→extension is Zod-validated" claim (inbound `validateWebviewToExtension` is unwired)
> **Earlier:** 2026-05-19 — All 7 steps complete (Zod, safe HTML, components, dialogs, status bar)
