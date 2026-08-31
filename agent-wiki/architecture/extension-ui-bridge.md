# Extension UI Bridge

> **Status:** stable

The Extension UI Bridge (`src/pi-service.ts`, the `bindExtensionUI()` method)
bridges Pi extension TUI components into the VS Code webview panel. It creates
a Proxy-based UIContext that maps extension widget calls (`setWidget`, `notify`,
`setStatus`) to `PiServiceEvent` emissions, allowing TUI extensions to render
in the webview without TUI-specific APIs.

## Why it exists

Pi extensions (like `pi-tldr`, `pi-subagents`) are designed for a terminal UI.
They call methods on a UIContext interface: `setWidget(key, factory)` to render
updating widgets, `notify(message, level)` for alerts, `setStatus(key, status)`
for activity tracking, and interactive methods (`select`, `confirm`, `input`)
for user prompts.

Without a bridge, these extensions check `hasUI` at registration time and
silently skip rendering when no TUI is available. The bridge makes them
functional in the VS Code webview by translating their TUI calls into chat
events that the webview can display as live-updating cards.

## Architecture

**Base UIContext object:** Defines concrete implementations for the methods
extensions actually use:

- `setWidget(key, factory)` — calls the factory with minimal `tui`/`theme`
  stubs, renders the component, strips ANSI codes, and emits `widget-update`
  events. Unchanged output is skipped. Widgets not updated for 30 seconds are
  auto-cleared to prevent orphaned animations.
- `notify(message, level)` — emits `custom-message` events (info or error).
- `setStatus(key, status)` — emits `widget-update` events with the content
  `**key** status`. The webview renders widgets through `renderMarkdown()`
  which preserves raw HTML via marked.js, so extensions can include clickable
  links and styled spans. No escaping is applied to the status text.
- `globalThis.__piRegisterMessageRenderer` — injected before extensions load,
  forwards `(customType, sourceCode)` to the webview where it's registered
  via `<script nonce>` injection. See [Custom Message Renderer](custom-message-renderer.md).
- Interactive methods (`select`, `confirm`, `input`, `custom`) — return
  `undefined` to signal "not supported", causing the SDK to fall back to
  text-based prompting.

**Proxy wrapper:** Wraps the base object in a `Proxy`. Unknown method calls
(like TUI-specific `setToolsExpanded`, `requestRender`, `onTerminalInput`)
are intercepted, logged as warnings, and no-oped instead of crashing.

**Widget lifecycle timer:** A `setInterval` (10s) checks for widgets not
updated in 30 seconds and clears them, preventing stale status cards from
persisting indefinitely.

## Related

- [Webview Panel](webview-panel.md) — receives widget-update and custom-message events
- [Webview Frontend](webview-frontend.md) — renders live panel cards
- [PiService](pi-service.md) — binds extensions with this bridge
- [Custom Message Renderer](custom-message-renderer.md) — the `globalThis` bridge for renderers
- [Component System Proposal](component-system-proposal.md) — proposed interactive dialog support

## The `ask` card — a second blocking request (0.3.0)

`extension_ui_request` is no longer the only wire request that pauses a turn until the
client answers. rust-pi 0.3.0 enables its `ask` tool by default and BLOCKS on it:

```
{"type":"ask_request","id":"…","questions":[{id,header,question,multi,options:[{label,description}]}],"timeoutMs":300000}
{"type":"ask_response","id":"…","answers":[{questionId,selected:["…"]}]}      // or {dismissed:true}
```

The contract is undocumented upstream and was established by probing the binary — its
own validation errors define it (`answers` must be a sequence of `AskAnswer` structs
carrying `questionId` and `selected`). `{dismissed: true}` is the binary's named
alternative and is what a **cancelled** card must send: replying `{id}` alone is
rejected and leaves the turn blocked, so silence on cancel reproduces the original bug
through another door.

Unrouted, an `ask_request` is not a dropped event but a five-minute stall —
`tool_execution_start` with no end, no `turn_end`, no `agent_end`.

## Dialog rendering: three faults the `ask` card exposed

The select dialog had been unusable since the 0.1.3 HTML hardening; nothing opened one
routinely until `ask` arrived. Options were escaped **twice**, so the body rendered
`<div class="pi-dialog-option" …>` as literal text; once visible they had no click
handler, and the key handler sat on an element that could never take focus, so OK
always committed the first option; and closing the dialog left an empty full-screen
`#dialog-overlay` (fixed, inset 0, z-index 1000) over the UI, swallowing every click
and scroll for the rest of the session.

The lesson that generalises: `safe()` exists for content that has already been escaped
once, and a component that mounts into a wrapper must own that wrapper's removal.

> **Last updated:** 2026-08-31 — added the `ask_request`/`ask_response` contract and
> the dialog faults it exposed (0.1.11-0.2.0).
