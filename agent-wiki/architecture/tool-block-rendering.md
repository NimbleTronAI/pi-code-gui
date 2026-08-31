# Tool Block Rendering

> **Status:** stable

Tool block rendering lives in `src/webview/tools/index.ts`. Four tool renderers
(write, edit, read, bash) handle the create→update→finalize lifecycle for tool
execution blocks in the chat. A `defaultToolRenderer` handles all other tools.

## Common pattern: tool-scroll-view

All file-display blocks use a `.tool-scroll-view` wrapper with consistent
`max-height: 15rem` (font-relative, ~10 lines at default size). This replaces
the earlier approach of per-tool `max-height` values (500px, 420px, 220px) that
cross-polluted via CSS and produced double scrollbars.

| Tool | Container | Scroll target | Height |
|------|-----------|---------------|--------|
| Write | `.tool-content` → `.tool-scroll-view` | scroll-view | 15rem |
| Edit | `.tool-content` → `.tool-scroll-view` | scroll-view | 15rem |
| Read | `.tool-result` (inline override) | `.tool-result` (500px→now 15rem) | 15rem |
| Bash | `.bash-output` | output div | 300px |

## Write tool

`renderWriteContentBlock(el)` uses a persistent `.tool-scroll-view` wrapper.
During active streaming, it auto-scrolls (`scrollTop = scrollHeight`). Content
is rendered at full natural height inside the scroll-view — no line trimming.
When finalized, `finalize()` scrolls the scroll-view to top.

## Edit tool

`renderEditPreviews(el, edits)` renders per-edit mini-diffs in a
`.tool-scroll-view`. During streaming, all edits are shown with auto-scroll.
When done, visible edits are capped at 3 with a "… N more" indicator. Edit
previews now use `highlightCode` for syntax-highlighted old/new text.

## Read tool

Uses `renderFileContent(text, lang)` for syntax-highlighted code display. The
`.tool-result` container handles scrolling (inline `max-height: 15rem`). The
inner `.code-block`'s `max-height` and `overflow-y` are overridden to `none` /
`visible` to prevent the CSS rule from `.tool-block .tool-result .code-block`
creating a nested scrollbar.

The collapse/expand toggle was removed — the read tool now always shows full
content with a single scrollbar, matching write/edit behavior.

## Bash tool

`bashToolRenderer` creates a `.bash-execution` block with header, output area,
and footer. Output streams via `handleBashOutput` which appends text and
morphdom-patches the output div. A `.bash-spinner` (CSS animation) shows during
execution.

## Tool lifecycle

All tools follow the same `handleToolStart` → `handleToolUpdate` →
`handleToolEnd` dispatch in `handlers/index.ts`. The `defaultToolRenderer`
handles any unrecognized tool name by wrapping results in `renderToolResult`
(which detects diffs, JSON, and code fences).

## Related

- [Syntax Highlighting](syntax-highlighting.md) — provides the highlighting
  for write/read/edit content
- [Streaming Pipeline](streaming-pipeline.md) — RAF-batched rendering during
  active tool streaming
- [Webview Frontend](webview-frontend.md) — the DOM context these blocks render into

> **Last updated:** 2026-08-31 — audited, no changes needed: the four renderers still
> exist, `.tool-scroll-view` is still capped at 15rem (set inline in
> `src/webview/tools/index.ts`) and `.bash-output` at 300px.
