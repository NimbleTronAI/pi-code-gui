# Component System Proposal

> **Status:** evolving

A 3-layer architectural upgrade plan for Pi Code GUI's webview frontend. Derived
from a comparative analysis of Pi's TUI RPC architecture vs. the current webview
ad-hoc DOM manipulation approach. The goal: eliminate the root causes of all
bugs hit in the v0.0.24–v0.0.27 development cycle.

## Problem: three root causes

Every bug this cycle traced to one of three architectural gaps:

1. **No protocol validation** — `PiServiceEvent` is an untyped `type` union with
   `data?: any`. Missing fields (`display`, `details`) were silently dropped.
   Unknown event types vanished with no diagnostic.

2. **HTML as strings everywhere** — Content is built via string concatenation
   (`'<div class="' + x + '">'`). RegEx highlighters on escaped text produced
   malformed nested spans. CSS classes leaked as visible text. Cross-component
   CSS rules collided (`.tool-result .code-block` creating nested scrollbars).

3. **No component lifecycle** — Tool blocks, live cards, status widgets,
   inline cards all manage their own DOM ad-hoc. No shared scroll container
   pattern, no mount/update/destroy hooks, no state ownership boundary. Each
   block type re-implements collapse/expand, height constraints, and cleanup.

## The three-layer fix

### Layer 1: Typed protocol with runtime validation ✅ (complete)

Replace the current `PiServiceEvent` + `msg.type` switch with Zod-validated
schemas. Every message is validated on receipt. Unknown fields are rejected.
Missing required fields throw immediately with a visible notification.

**Implemented** in `src/shared/protocol.ts` — 37 `ExtensionToWebview` schemas +
16 `WebviewToExtension` schemas. Three validation wrappers:
- `emit()` in `pi-service.ts`
- `postMessage()` in `webview-panel.ts`
- Webview message listener in `handlers/index.ts`

**What this fixes:** The `display`/`details` gap, unknown SDK event types,
malformed tool call args leaking into DOM, silent message drops.

**Effort:** ~1 day. ~15KB for Zod, ~30 message type schemas.
**Risk:** Low. Validation wraps existing handlers, doesn't change behavior.

### Layer 2: Safe HTML builder (~1KB) ✅ (complete)

A tagged template literal that auto-escapes interpolated values:

```typescript
const el = html`<div class="tool-block" data-status="${status}">
  ${toolHeader}
  <div class="tool-content">${codeBlock}</div>
</div>`;
```

**Implemented** in `src/webview/render/html.ts` — exports `html` tagged template
and `safe()` marker. Migrated all DOM-building functions in:
- `engine.ts`: `createToolBlock`, `createThinkingBlock`, `renderCodeBlockHTML`,
  `renderFileContent`, `renderDiffMarkup`, `diffWords`, `renderInline`,
  `renderToolResultTruncated`
- `tools/index.ts`: write/edit/read/bash tool renderers, `renderEditPreviews`
- `handlers/index.ts`: `createLiveCard`, `addStatusMessage`, `addCompactionIndicator`,
  `renderAttachments`, `handleCompactionSummaryMessage`, `showUserMessageSelector`,
  `renderSettingsPanel`, `updateSlashAutocomplete`, `renderInlineCustomMessage`,
  `handleWidgetUpdate`, `handleQueueUpdate`

Every `${...}` is auto-escaped unless explicitly marked as safe HTML. This
eliminates the entire class of HTML injection + CSS leakage bugs **for the
string-built DOM**. (The `renderInline()` token renderer's `html`/`link` cases
are a separate path that does not go through the `html` template; they are
hardened separately — see [Webview Frontend](webview-frontend.md).)

**What this fixes:** CSS token leakage, HTML breakout, markup corruption from
nested string concatenation.

**Effort:** ~1 day. ~1KB, replaces all `'<div class="' + x + '">'` patterns.
**Risk:** Low. Can be adopted incrementally — start with tool blocks.

### Layer 3: Micro component system (~3KB) ✅ (complete)

Small components that own their DOM subtrees. No virtual DOM — direct DOM
manipulation with lifecycle hooks (`mount`, `update`, `destroy`).

**Implemented** in `src/webview/components/`:
- `Component<P>` interface (types.ts)
- `CodeBlock` — syntax-highlighted code with copy button, scroll container
  (replaces `renderFileContent`, `renderCodeBlockHTML`)
- `ThinkingBlock` — collapsible thinking content with spinner, line count,
  expand/collapse toggle (replaces `createThinkingBlock`)
- `LiveCard` — notification cards with owned toggle state
  (replaces `createLiveCard`)
- `InlineCard` — custom message cards with action button delegation
  (replaces `renderInlineCustomMessage`)
- `ToolBlock` — shared chrome for write/edit/read tool blocks
  (replaces per-tool `create()` DOM builders)

Each component owns its scroll state, height constraints, and expand/collapse
state. No cross-component CSS interference because scroll containers are scoped
to their owning component.

**What this fixes:** Double scrollbars, block height inconsistency, live-card
toggle state, write block jitter, tool-block DOM cleanup races.

**Effort:** ~2 days for framework + 3 days to migrate renderers.
**Risk:** Medium. Component migration is mechanical but broad.

## Execution order (least risk → most impact)

| Step | Effort | Impact |
|------|--------|--------|
| 1. Add Zod protocol validation | 1 day | Catches all future event gaps immediately |
| 2. Implement safe `html` tagged template | 1 day | Eliminates HTML injection class of bugs |
| 3. Extract `CodeBlock` component (shared) | 1 day | Fixes double scrollbar + height inconsistency |
| 4. Extract `LiveCard`/`InlineCard` components | 1 day | Fixes toggle state + inline card layout |
| 5. Extract remaining components | 2 days | Eliminates ad-hoc DOM manipulation |
| 6. Interactive dialogs (select/confirm/input) | 2 days | TUI parity for extension interactive methods |
| 7. `invalidate()` + persistent status area | 1 day | Better extension UX |

**Total: ~9 days. Steps 1-3 alone (~3 days) eliminate the vulnerability surface
of HTML string concatenation and catch protocol drift immediately.**

## Comparison: Pi TUI vs current vs proposed

| Aspect | Pi TUI (RPC) | Pi Code GUI (current) | Proposed |
|--------|-------------|----------------------|----------|
| Rendering | Component.render() → ANSI strings | DOM strings → innerHTML | Component.update() → tagged template |
| Proto validation | RPC: JSON parse + type check | None (data?: any) | Zod schema on every message |
| HTML safety | N/A (ANSI terminal) | Manual escapeHtml in random places | Auto-escaped template literals |
| Component model | Container+children, focus management | Ad-hoc state object | Component classes with lifecycle |
| Scroll management | Not applicable (terminal scrollback) | Per-div max-height, CSS collisions | Component-owned scroll containers |
| Re-render | invalidate() + requestRender() | Direct DOM mutation | update(props) on existing component |

**Reference:** The TUI RPC architecture that inspired this proposal:
[`pi/packages/coding-agent/examples/rpc-extension-ui.ts`](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/rpc-extension-ui.ts)

## Related

- [Webview Frontend](webview-frontend.md) — current DOM rendering approach
- [Extension UI Bridge](extension-ui-bridge.md) — the extension host side
- [Custom Message Renderer](custom-message-renderer.md) — inline card component
- [Tool Block Rendering](tool-block-rendering.md) — current tool block patterns

> **Last updated:** 2026-05-19 — All 7 steps complete (full implementation)
