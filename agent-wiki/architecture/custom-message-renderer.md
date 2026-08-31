# Custom Message Renderer

> **Status:** stable

The Custom Message Renderer (`src/webview/handlers/index.ts`,
`renderInlineCustomMessage` and `handleRegisterMessageRenderer` functions, plus
`src/pi-service.ts` `globalThis` injection) enables Pi extensions to render
interactive inline cards in the webview conversation stream. This is the webview
equivalent of Pi's TUI `CustomMessageComponent` and `MessageRenderer`.

## Why it exists

Pi extensions (e.g., `nimble-observe`) need to display structured, interactive
content in the conversation — work-item lists with status indicators, action
buttons, and live polling updates. Notifications (live-cards above the prompt)
are transient and lack interactivity. Inline cards persist in the conversation
history and support `[data-command]` buttons.

## Architecture

### Extension host → webview bridge

In `pi-service.ts` `initialize()`, BEFORE `createAgentSession`:

```typescript
(globalThis as any).__piRegisterMessageRenderer = (
  customType: string, sourceCode: string
) => {
  this.emit({ type: "registerMessageRenderer",
    data: { customType, sourceCode } });
};
```

Extensions call this to send JavaScript source code to the webview, where it
runs in the DOM. The source code receives `(data, containerEl, escapeHtml)`.

### Webview: script nonce injection

CSP blocks `eval()`. The webview reads the nonce from the existing `<script
nonce>` tag and creates a new `<script>` element with the same nonce:

```typescript
var nonce = document.querySelector("script[nonce]")?.getAttribute("nonce");
var script = document.createElement("script");
script.setAttribute("nonce", nonce);
script.textContent = "window['__piRenderer_' + name] = function(...) { ... }";
document.head.appendChild(script);
```

The renderer is stored in `state.messageRenderers[customType]`.

### Display: `display: true` gating

When a custom message arrives, `handleCustomMessage` checks `data.display`:

- `display: true` → `renderInlineCustomMessage(data)` — renders in the chat
  container. If a renderer is registered, it runs. Otherwise, `content` renders
  as markdown in a `.custom-message-inline` bordered card.
- `display: false` or undefined → existing live-card notification behavior
  (unchanged).

### In-place updates

When `pi.sendMessage()` is called again with the **same `customType`**, the
webview finds the existing card via `[data-custom-type]` and re-runs the
renderer in-place. This enables polling-based live updates.

### Action buttons

Elements with `data-command` inside inline cards automatically execute the
slash command when clicked:

```html
<button data-command="my_attach abc123">Attach</button>
```

The framework listens for `click` events on `[data-command]` and posts
`{ type: "slashCommand", command }` to the extension host.

## PiService forwarding

`pi-service.ts` forwards `display` and `details` fields in `custom-message`
events (3 emit sites: `sendInitialMessages`, `handleAgentEvent` message_end,
and session replay). Previously these fields were silently dropped.

## Related

- [Extension UI Bridge](extension-ui-bridge.md) — the `globalThis` bridge
  for registering renderers
- [Webview Frontend](webview-frontend.md) — renders the cards
- [Event Translation](event-translation.md) — the `custom-message` event type
  with `display` and `details` fields

> **Last updated:** 2026-05-19 — initial documentation of custom message renderer
