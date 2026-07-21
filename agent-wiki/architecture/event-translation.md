# Event Translation

> **Status:** evolving

The Event Translation Layer (`src/pi-service.ts`, the `handleAgentEvent()` method
and surrounding helpers) translates raw Pi SDK agent events into typed
`PiServiceEvent` emissions that the webview panel and extension commands consume.
It is the bridge between the SDK's internal event model and the VS Code UI layer.

## Why it exists

The Pi SDK emits low-level events (`agent_start`, `agent_end`, `agent_settled`,
`message_start`, `message_update`, `message_end`, `tool_execution_start`,
`tool_execution_update`, `tool_execution_end`,
`compaction_start`, `compaction_end`, `auto_retry_start`, `auto_retry_end`,
`session_info_changed`, `thinking_level_changed`, `queue_update`). These events
carry raw message content (arrays of content blocks with text, thinking, and
toolCall entries) that the webview cannot render directly.

The translation layer:
1. Extracts plain text from structured content blocks (`extractTextFromContent`)
2. Extracts thinking blocks for separate rendering (`extractThinkingFromContent`)
3. Extracts tool calls with their arguments (`extractToolCallsFromContent`)
4. Pre-builds lookups to avoid O(n²) scans (`getEntriesWithLookups`)
5. Routes bash/exec tools through dedicated rendering channels (`bash-start`,
   `bash-output`, `bash-end`) instead of generic tool channels
6. Maps `message_update` deltas to streaming text and thinking channels
7. Tracks the current assistant's tool calls to emit `tool-update` events
   as arguments are refined during streaming

## Event routing

| SDK Event | PiServiceEvent(s) Emitted |
|-----------|---------------------------|
| `agent_start` | `agent-start` |
| `agent_end` | `agent-end` + `status-update` |
| `agent_settled` | `status-update` (final idle confirmation; no duplicate `agent-end`) |
| `message_start` (user) | `chat-message` (from `sendInitialMessages` replay) |
| `message_start` (assistant) | `assistant-start` |
| `message_end` (user) | *(no emission — user messages are emitted via `chat-message`)* |
| `message_update` (text_delta) | `stream-delta` |
| `message_update` (thinking_delta) | `thinking-delta` |
| `message_update` (thinking_end) | `thinking-delta` (done:true) |
| `message_update` (error) | `error` |
| `turn_end` | *(consumed by tree view — triggers refresh)* |
| `message_end` (assistant) | `assistant-end` + `status-update` |
| `tool_execution_start` | `tool-start` or `bash-start` |
| `tool_execution_update` | `tool-update` or `bash-output` |
| `tool_execution_end` | `tool-end` or `bash-end` |
| `compaction_start` / `compaction_end` | `compaction-start` / `compaction-end` + `compaction-summary-message` |
| `auto_retry_start` / `auto_retry_end` | corresponding events |
| `thinking_level_changed` | `thinking-level-changed` + `status-update` |
| `queue_update` | `queue-update` |
| `message_end` (custom) | `custom-message` (with `display`, `details` fields forwarded) |
| *unknown/any other* | `custom-message` diagnostic notification (visible in webview) |

**Diagnostic default:** Unknown SDK event types emit a `custom-message` with
`customType: "pi-gui-diagnostic"` that renders as a visible notification above
the prompt. Previously they were silently dropped.

## Related

- [PiService](pi-service.md) — owns this translation layer
- [Webview Panel](webview-panel.md) — consumes the translated events
- [Types](https://github.com/NimbleTronAI/pi-code-gui/blob/main/src/types.ts) — the `PiServiceEvent` type union

> **Last updated:** 2026-07-21 — handle SDK 0.80 agent_settled as final idle confirmation
