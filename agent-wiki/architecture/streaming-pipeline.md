# Streaming Pipeline

> **Status:** stable

The Streaming Pipeline (`src/webview/handlers/index.ts` and `src/webview/render/
engine.ts`) handles real-time rendering of LLM response text, thinking deltas,
and tool call argument streaming. It uses RAF-batched rendering with morphdom
patching to avoid O(n²) full-content re-renders during streaming.

## Text streaming

`handleStreamDelta` accumulates text in a `data-raw` attribute on the assistant
message content element. `_scheduleStreamRender` is called on each delta but
only renders once per animation frame (via `requestAnimationFrame` flag).

On each RAF frame:
1. Marked's `lexer()` re-parses the accumulated raw text into tokens
2. `patchBlockList()` diffs the previous token list against the new one
3. Only the last (in-progress) block is morphdom-patched; all prior completed
   blocks are untouched

This is O(tokens) per frame instead of O(content²).

## Thinking streaming

Similar to text streaming, but uses `textContent` assignment (no HTML parse)
for efficiency. Accumulated in `data-raw` on the `.thinking-content` element.
`_scheduleThinkingRender` batches per animation frame.

Features:
- Line count display: `(N lines)` updates live
- Auto-scroll to bottom within the thinking content area
- Expand button appears when content overflows the 200px collapsed view
- Spinner removed when thinking completes (`thinking-delta` with `done: true`)
- Gradient fade overlay (the `overflowing` class + `::after` CSS) was removed
  due to browser compositing bugs — now just the scrollbar indicates overflow

## Tool call argument streaming

During assistant message streaming, `handleAgentEvent` in pi-service.ts scans
`event.message.content` for tool calls. New tool calls emit `tool-start`
(`fromMessage: true`). Updated arguments emit `tool-update` with the JSON args.
The webview renderers (write/edit) parse JSON args to display file paths and
edit previews as the model writes them.

### Tool-arg preview throttle (200ms)

A large `write`/`edit` streams its arguments as a flood of incremental
`toolcall_delta` events. Emitting a `tool-update` for every one forced the
webview to re-parse and re-render a growing JSON blob on each delta, which froze
the webview on large writes. The Rust path now throttles these previews to one
update per **`TOOL_PREVIEW_THROTTLE_MS = 200`** (`src/rust-events.ts:152`), gated
by `shouldEmitToolPreviewUpdate(lastEmit, now)` (rust-events.ts:164). This drops
only intermediate *preview* frames — the **final, complete arguments still arrive
separately via `tool_execution_start`**, so no argument data is ever lost; only
the mid-stream preview cadence is capped. Introduced in commit `8322a4d`. **Do
not remove this without restoring an equivalent cap** — it is the fix for the
large-write freeze, not an optimization.

## Batch replay

On session load, `handleBatchStart` sets `_inBatch = true` and adds `.no-animate`
to `<body>` to suppress fade-in animations during history replay.
`handleBatchEnd` removes both, then force-scrolls to bottom using a triple-rAF
+ `scrollIntoView({ block: "end" })` to ensure layout has settled before
measuring scroll position (prevents the "conversation not scrolled to bottom"
bug on session restore).

**Progressive replay:** `sendInitialMessages` now replays entries top-down, one at
a time, yielding to the event loop with `setTimeout(0)` between each entry.
This keeps the most recent messages at the bottom and prevents the synchronous
DOM flood that would crash the extension host on large sessions (1000+ entries).
Batch-start/end still wrap the entire replay for animation control.

## RAF throttling caveat

`requestAnimationFrame` is throttled to ~1 FPS when the webview tab is hidden
(VS Code's `retainContextWhenHidden: true` keeps the webview alive but the
browser throttles inactive tabs). This can make streaming content appear
"halted" if the user switches tabs and returns — content IS arriving, just
rendering at 1 FPS. This is a platform limitation, not a bug.

## Related

- [Webview Frontend](webview-frontend.md) — the DOM context
- [Event Translation](event-translation.md) — the SDK events that drive
  streaming deltas
- [Tool Block Rendering](tool-block-rendering.md) — tool call arguments
  rendered during streaming

> **Last updated:** 2026-06-24 — documented the 200ms tool-arg preview throttle (`TOOL_PREVIEW_THROTTLE_MS`, commit 8322a4d) that fixes the large-write webview freeze
> **Earlier:** 2026-05-27 — added progressive replay section
