# Event Translation

> **Status:** stable

The Event Translation Layer translates raw Pi SDK / Rust agent events into typed
`PiServiceEvent` emissions that the webview panel and extension commands consume.
It is the bridge between the runtime's internal event model and the VS Code UI layer.

The decision logic is a **pure, vscode-free function** —
`translateAgentEvent(event, state) → { events, mutations, effects }` in
[`src/agent-events.ts`](https://github.com/NimbleTronAI/pi-code-gui/blob/main/src/agent-events.ts).
`PiService.handleAgentEvent()` is now a thin shell that builds the state snapshot,
calls `translateAgentEvent`, applies the returned scalar mutations, emits the
events, then runs the trailing effects (Rust subprocess calls before the data
emits; `reportStatus` after). BOTH runtimes flow through this one function (TS SDK
directly; Rust via `RustService.handleEvent` → `RustHost.handleAgentEvent`), so it
is the single highest-leverage hot path — which is why it was extracted into a
module with a per-event-type unit suite (`src/test/unit/agent-events.test.ts`).
Precedent: `routeRustEvent` (rust-events.ts).

## Why it exists

The Pi SDK emits low-level events (`agent_start`, `message_start`, `message_update`,
`message_end`, `tool_execution_start`, `tool_execution_update`, `tool_execution_end`,
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

**`tool-start` args are always a record.** The protocol schema requires
`data.args` to be a record, but a param-less tool persists `arguments: null` —
which historical-session replay (including Rust sessions, whose `get_messages`
entries flow through `PiService.sendInitialMessages`) would otherwise emit as
`null`, tripping outbound validation on every tool. `normalizeToolArgs(args)`
(in `agent-events.ts`) collapses `null`/`undefined`/array/primitive to `{}`; all
three `tool-start` emit sites — the two live ones and the replay loop in
`pi-service.ts` — route through it so the guard can't drift apart.

## Related

- [PiService](pi-service.md) — owns this translation layer
- [Webview Panel](webview-panel.md) — consumes the translated events
- [Types](https://github.com/NimbleTronAI/pi-code-gui/blob/main/src/types.ts) — the `PiServiceEvent` type union

> **Last updated:** 2026-06-25 — documented `normalizeToolArgs`: `tool-start` `data.args` is always coerced to a record across all three emit sites (fixes null-args validation noise on historical/Rust replay)
> **Earlier:** 2026-06-24 — extracted the decision logic into the pure `translateAgentEvent` (`src/agent-events.ts`) with a per-event-type unit suite; `handleAgentEvent` is now a thin apply-mutations/emit/effects shell
> **Earlier:** 2026-05-27 — added turn-end, message_update error, clarified user message_end
