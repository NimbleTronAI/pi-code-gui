/* eslint-disable @typescript-eslint/no-explicit-any */
// Pure, vscode-free translation of agent stream events → PiServiceEvents.
//
// Extracted from PiService.handleAgentEvent — a ~230-line state machine that
// BOTH runtimes drive (TS SDK and Rust) and that has historically shipped
// streaming bugs with no automated coverage. This module makes the DECISIONS;
// the thin shell in PiService applies the returned mutations/effects and does
// the actual emit(). Precedent: routeRustEvent (rust-events.ts).
//
// `any` is enabled file-wide because the SDK/Rust event payloads are
// dynamically shaped — the original dispatcher used per-line `any` disables
// throughout for exactly this reason. The containers in AgentTranslateState
// (userMessages, toolCalls) are mutated IN PLACE, the same idiom as
// dropQueuedMessage/promoteQueuedToSteer in rust-events.ts.

import type { PiServiceEvent, Runtime } from "./types.js";
// (These shared helpers live HERE — the runtime-agnostic translator — and are
// imported by the Rust-specific modules, never the reverse. They were moved out
// of rust-events.ts, whose name wrongly implied Rust-only ownership.)

/**
 * Extract the plain-text portion of a message `content` payload. Runtime-agnostic:
 * a bare string is returned as-is; an array yields the joined `text` blocks;
 * anything else (incl. null/undefined) yields "".
 */
export function extractMessageText(content: unknown): string {
  if (!content) { return ""; }
  if (typeof content === "string") { return content; }
  if (Array.isArray(content)) {
    return content
      .filter((c) => c && typeof c === "object" && (c as { type?: string }).type === "text")
      .map((c) => (c as { text?: unknown }).text ?? "")
      .join("\n");
  }
  return "";
}

/** Minimum gap between streaming tool-arg preview updates for one tool call.
 *  ~5 updates/s: comfortably "live" to the eye, while halving the webview render
 *  churn vs a tighter cap — each preview re-renders the full (growing) args, so
 *  the cost scales with BOTH the update rate and the args size, and a large write
 *  is exactly where both are biggest. Raise it further only if huge writes still
 *  churn; the next lever after that is capping the preview payload size. */
export const TOOL_PREVIEW_THROTTLE_MS = 200;

/**
 * Throttle the streaming `tool-update` previews emitted as a tool call's args
 * accumulate. rust-pi streams a `toolcall_delta` per token — tens of thousands
 * for a large `write` — each carrying the full growing args; re-emitting a
 * preview (with the whole re-serialized args) on every one floods the webview
 * O(n²) and freezes it until the backlog drains. Capping the rate keeps the
 * preview live without the flood; the FINAL, authoritative args still arrive via
 * tool_execution_start (fromMessage:false), so nothing is lost by skipping
 * intermediate frames. Returns true when enough time has passed to emit again.
 */
export function shouldEmitToolPreviewUpdate(lastEmit: number | undefined, now: number, intervalMs: number = TOOL_PREVIEW_THROTTLE_MS): boolean {
  return lastEmit === undefined || (now - lastEmit) >= intervalMs;
}

/**
 * Whether to emit a streaming `fromMessage` tool-start preview for a tool call
 * extracted from a (possibly partial) assistant message. Skip when:
 * - the id hasn't streamed in yet — previewing an id-less call orphans an empty
 *   "{} null" placeholder block the webview can never reconcile; and
 * - it's bash/exec — those have their own bash-start/output/end render path, and
 *   generic tool events would leak JSON args into the bash output div.
 */
export function shouldEmitToolPreview(tc: { id?: string | null; name?: string | null }): boolean {
  if (!tc.id) { return false; }
  if (tc.name === "bash" || tc.name === "exec") { return false; }
  return true;
}

/**
 * Display text for a streaming tool call's (possibly partial) arguments — the live
 * progress a `tool-update` preview shows — or null when there's nothing meaningful to
 * render yet, so the caller skips the frame.
 *
 * rust-pi with the upstream #124 fix (released in v0.1.22) grows the tool-call
 * `arguments` field as deltas stream in, instead of leaving it null until the JSON is
 * complete (verified from raw `--mode rpc` captures of both binaries). That partial
 * value can arrive as a partially-parsed OBJECT or, defensively, a raw partial-JSON
 * STRING; both are rendered as-is. null / undefined / empty-string / empty-`{}` return
 * null so a preview never flashes a literal "null" or a blank "{}" (the pre-fix binary
 * sent null the whole way through, which this also cleans up).
 */
export function toolArgsPreviewText(args: unknown): string | null {
  if (args === null || args === undefined) { return null; }
  if (typeof args === "string") { return args.length > 0 ? args : null; }
  if (typeof args === "object") {
    if (Object.keys(args).length === 0) { return null; }
    try { return JSON.stringify(args, null, 2); } catch { return null; }
  }
  return String(args); // number / boolean — render as-is
}
import { humanizeProviderError } from "./extension-errors.js";

/** Coerce a raw error value to a display string. rust-pi/DeepSeek can deliver an error
 *  as a structured object ({error, errorHints, …}); extract a nested string field when
 *  present, else stringify — so downstream string-typed schemas never receive an object. */
export function errorToText(e: unknown): string {
  if (typeof e === "string") { return e; }
  if (e && typeof e === "object") {
    const o = e as { error?: unknown; message?: unknown; summary?: unknown };
    if (typeof o.error === "string") { return o.error; }
    if (typeof o.message === "string") { return o.message; }
    if (typeof o.summary === "string") { return o.summary; }
    try { return JSON.stringify(e); } catch { return "Unknown error"; }
  }
  return "Unknown error";
}

/** Streaming tool-call preview state, tracked across message_update deltas. */
export interface ToolCallState { toolName: string; toolCallId: string; args: any; lastPreviewEmit?: number; }

/** Session entries plus the lookups used to resolve stable entryIds.
 *  Empty under Rust (no sessionManager), which the callers tolerate. */
export interface EntryLookups { entries: any[]; byMessageId: Map<string, any>; byToolCallId: Map<string, any>; }

/** Everything translateAgentEvent reads. `userMessages` and `toolCalls` are
 *  mutated in place; the shell passes the live PiService containers. */
export interface AgentTranslateState {
  backendKind: Runtime;
  /** Read by the agent_end duplicate guard BEFORE the mutation is applied. */
  agentRunActive: boolean;
  lookups: EntryLookups;
  userMessages: Array<{ id: string; text: string; timestamp?: number }>;
  toolCalls: Map<string, ToolCallState>;
  /** Single clock for this dispatch (Date.now()), injected for test determinism. */
  now: number;
  /** Apply the live SDK tool's prepareArguments hook; identity under Rust / no def. */
  prepareArgs: (toolName: string, args: any) => any;
}

/** Non-event side-effects the shell runs after applying mutations + emitting. */
export interface AgentTranslateEffects {
  reportStatus?: boolean;
  rustClearQueue?: boolean;
  /** When true, the shell calls `_rust.captureContext(captureUsage)`. */
  captureContext?: boolean;
  captureUsage?: unknown;
  /** Unknown event type — the shell warns once per type. */
  unknownType?: string;
}

/** translateAgentEvent's output: events to emit, scalar state changes to copy
 *  back onto PiService, and trailing effects. (Containers were mutated in place.) */
export interface AgentTranslateResult {
  events: PiServiceEvent[];
  setAgentRunActive?: boolean;
  setStreaming?: boolean;
  setThinkingLevel?: string;
  turnIndex?: "reset" | "increment";
  clearToolCalls?: boolean;
  effects: AgentTranslateEffects;
}

function reverseFind<T>(arr: T[], pred: (el: T) => boolean): T | undefined {
  for (let i = arr.length - 1; i >= 0; i--) { if (pred(arr[i])) { return arr[i]; } }
  return undefined;
}

/** Pure: extract toolCall content blocks from an assistant message content array. */
export function extractToolCalls(content: any): Array<{ name: string; id: string; arguments: any }> {
  if (!content) { return []; }
  return content
    .filter((c: any) => c.type === "toolCall")
    .map((c: any) => ({ name: c.name, id: c.id, arguments: c.arguments }));
}

/**
 * Coerce tool-call arguments to a plain record for the `tool-start` event's
 * `args` field (the protocol schema requires a record). Historical sessions —
 * especially replayed Rust ones — can carry `arguments: null` for a param-less
 * tool, which would otherwise fail outbound validation. Anything that isn't a
 * plain object (null, array, primitive) collapses to `{}`.
 */
export function normalizeToolArgs(args: unknown): Record<string, unknown> {
  return (args && typeof args === "object" && !Array.isArray(args))
    ? (args as Record<string, unknown>)
    : {};
}

/**
 * Translate one agent stream event into the webview events to emit plus the
 * state mutations / side-effects the shell must apply. Pure and deterministic
 * given (event, state) — the only mutations are in-place on state.userMessages
 * and state.toolCalls (both are part of the input).
 */
export function translateAgentEvent(event: any, state: AgentTranslateState): AgentTranslateResult {
  const events: PiServiceEvent[] = [];
  const effects: AgentTranslateEffects = {};
  const result: AgentTranslateResult = { events, effects };

  switch (event.type) {
    case "agent_start":
      result.setAgentRunActive = true;
      result.setStreaming = true;
      result.clearToolCalls = true;
      result.turnIndex = "reset";
      events.push({ type: "agent-start" });
      break;

    case "agent_end":
      // rust-pi can emit agent_end twice for one run (abort/error path); ignore
      // the duplicate so we don't double-emit or double-refresh.
      if (state.backendKind === "rust" && !state.agentRunActive) { break; }
      result.setAgentRunActive = false;
      result.setStreaming = false;
      result.clearToolCalls = true;
      result.turnIndex = "reset";
      // Safety net: clear any synthetic queue entries the consume-path missed.
      if (state.backendKind === "rust") { effects.rustClearQueue = true; }
      events.push({ type: "agent-end", data: { messages: event.messages } });
      effects.reportStatus = true;
      break;

    case "turn_start":
      events.push({ type: "turn-start" });
      break;

    case "turn_end":
      events.push({ type: "turn-end", data: { message: event.message, toolResults: event.toolResults } });
      result.turnIndex = "increment";
      break;

    case "message_start": {
      const { byMessageId } = state.lookups;
      if (event.message?.role === "user") {
        const text = extractMessageText(event.message.content);
        if (text) {
          state.userMessages.push({ id: event.message.id ?? `user-${state.now}`, text, timestamp: event.message.timestamp ?? state.now });
          if (state.userMessages.length > 50) { state.userMessages.shift(); }
          const entry = byMessageId.get(event.message.id);
          events.push({ type: "chat-message", data: { role: "user", content: text, entryId: entry?.id ?? event.message.id } });
        }
      } else if (event.message?.role === "assistant") {
        result.clearToolCalls = true;
        const entry = byMessageId.get(event.message.id);
        events.push({ type: "assistant-start", data: { messageId: event.message.id, entryId: entry?.id ?? event.message.id } });
      }
      break;
    }

    case "message_update": {
      const d = event.assistantMessageEvent;
      switch (d?.type) {
        case "text_delta": events.push({ type: "stream-delta", data: { delta: d.delta } }); break;
        case "thinking_delta": events.push({ type: "thinking-delta", data: { delta: d.delta } }); break;
        case "thinking_end": events.push({ type: "thinking-delta", data: { delta: "", done: true } }); break;
        // d.error can be a structured object (rust-pi/DeepSeek attach errorHints), but
        // the error event's schema requires data.message to be a STRING — passing the
        // object raw fails protocol validation ("expected string, received object").
        // Coerce to a string first (prefer a nested .error/.message field).
        case "error": events.push({ type: "error", data: { message: humanizeProviderError(errorToText(d.error)) ?? errorToText(d.error) } }); break;
      }

      if (event.message?.role === "assistant" && event.message?.content) {
        const toolCalls = extractToolCalls(event.message.content);
        for (const tc of toolCalls) {
          // Skip tool calls that shouldn't be previewed: ones still missing a
          // stable id (partial stream → an orphan "{} null" placeholder), and
          // bash/exec (own bash render path; generic events leak JSON into it).
          if (!shouldEmitToolPreview(tc)) { continue; }
          if (!state.toolCalls.has(tc.id)) {
            state.toolCalls.set(tc.id, { toolName: tc.name, toolCallId: tc.id, args: tc.arguments, lastPreviewEmit: state.now });
            events.push({ type: "tool-start", data: { toolCallId: tc.id, toolName: tc.name, args: normalizeToolArgs(tc.arguments), fromMessage: true } });
          } else {
            const existing = state.toolCalls.get(tc.id);
            if (existing) {
              existing.args = tc.arguments;
              // Throttle the streaming preview: rust-pi emits a toolcall_delta
              // per token (tens of thousands for a large write); re-emitting the
              // full re-serialized args each time floods the webview O(n²) and
              // freezes it. The final args still arrive via tool_execution_start.
              // Only emit (and advance the throttle clock) once there's real partial
              // content — skip while args are still null/empty so no "null"/"{}" flashes.
              if (shouldEmitToolPreviewUpdate(existing.lastPreviewEmit, state.now)) {
                const preview = toolArgsPreviewText(tc.arguments);
                if (preview !== null) {
                  existing.lastPreviewEmit = state.now;
                  events.push({ type: "tool-update", data: { toolCallId: tc.id, toolName: tc.name, partialResult: { content: [{ type: "text", text: preview }] } } });
                }
              }
            }
          }
        }
      }
      break;
    }

    case "message_end":
      if (event.message?.role === "user") { break; }
      if (event.message?.role === "assistant") {
        // Rust: the turn's input(+cacheRead) ≈ current context fill → context %.
        if (state.backendKind === "rust") { effects.captureContext = true; effects.captureUsage = event.message.usage; }
        const toolCalls = extractToolCalls(event.message.content);
        events.push({ type: "assistant-end", data: { stopReason: event.message.stopReason, errorMessage: event.message.errorMessage, toolCalls: toolCalls.map((tc) => tc.id) } });
        effects.reportStatus = true;
      } else if (event.message?.role === "custom") {
        const custEntry = reverseFind(state.lookups.entries, (e: any) => e.type === "message" && e.message?.role === "custom");
        events.push({ type: "custom-message", data: { customType: event.message.customType, content: event.message.content, display: event.message.display, details: event.message.details, timestamp: event.message.timestamp, entryId: custEntry?.id ?? event.message.id } });
      }
      break;

    case "tool_execution_start": {
      const tcEntry = state.lookups.byToolCallId.get(event.toolCallId);
      const tcEntryId = tcEntry?.id ?? event.toolCallId;
      // Apply the tool's prepareArguments hook so the webview receives
      // validated/transformed args (e.g. legacy oldText/newText → edits[]).
      const args = state.prepareArgs(event.toolName, event.args);
      if (event.toolName === "bash" || event.toolName === "exec") {
        events.push({ type: "bash-start", data: { toolCallId: event.toolCallId, command: args?.command ?? "", entryId: tcEntryId } });
      } else {
        events.push({ type: "tool-start", data: { toolCallId: event.toolCallId, toolName: event.toolName, args: normalizeToolArgs(args), fromMessage: false, entryId: tcEntryId } });
      }
      break;
    }

    case "tool_execution_update":
      if (event.toolName === "bash" || event.toolName === "exec") {
        const text = event.partialResult?.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
        events.push({ type: "bash-output", data: { toolCallId: event.toolCallId, output: text ?? "" } });
      } else {
        events.push({ type: "tool-update", data: { toolCallId: event.toolCallId, toolName: event.toolName, partialResult: event.partialResult } });
      }
      break;

    case "tool_execution_end": {
      const tcEntry = state.lookups.byToolCallId.get(event.toolCallId);
      const tcEntryId = tcEntry?.id ?? event.toolCallId;
      if (event.toolName === "bash" || event.toolName === "exec") {
        const text = event.result?.content?.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
        events.push({ type: "bash-end", data: { toolCallId: event.toolCallId, command: event.args?.command ?? "", exitCode: event.isError ? 1 : 0, cancelled: false, output: text ?? "", isError: event.isError, entryId: tcEntryId } });
      } else {
        events.push({ type: "tool-end", data: { toolCallId: event.toolCallId, toolName: event.toolName, result: event.result, isError: event.isError, entryId: tcEntryId } });
      }
      break;
    }

    case "session_info_changed":
      effects.reportStatus = true;
      break;

    case "thinking_level_changed":
      result.setThinkingLevel = event.level;
      events.push({ type: "thinking-level-changed", data: { level: event.level } });
      effects.reportStatus = true;
      break;

    case "queue_update":
      events.push({ type: "queue-update", data: { steering: Array.from(event.steering ?? []), followUp: Array.from(event.followUp ?? []) } });
      break;

    case "compaction_start":
      events.push({ type: "compaction-start", data: { reason: event.reason } });
      break;

    case "compaction_end":
      events.push({ type: "compaction-end", data: { reason: event.reason, aborted: event.aborted, willRetry: event.willRetry, result: event.result, errorMessage: event.errorMessage } });
      if (event.result) {
        const compactEntry = reverseFind(state.lookups.entries, (e: any) => e.type === "compaction");
        // Under Rust, lookups are empty → compactEntry is undefined and entryId
        // would be undefined, leaving the summary unaddressable. Fall back to a
        // synthetic id. (Scoped to compaction_end; message/tool ids already align.)
        const compactionEntryId = compactEntry?.id ?? `compaction-${state.now}`;
        events.push({ type: "compaction-summary-message", data: { summary: event.result.summary, tokensBefore: event.result.tokensBefore, timestamp: state.now, entryId: compactionEntryId } });
      }
      break;

    case "auto_retry_start":
      events.push({ type: "auto-retry-start", data: { attempt: event.attempt, maxAttempts: event.maxAttempts, delayMs: event.delayMs, errorMessage: event.errorMessage } });
      break;

    case "auto_retry_end":
      events.push({ type: "auto-retry-end", data: { success: event.success, attempt: event.attempt, finalError: event.finalError } });
      break;

    default:
      // Surface unknown events so they aren't silently lost — an unhandled type
      // usually means upstream protocol drift. The shell warns once per type.
      effects.unknownType = event?.type;
      events.push({
        type: "custom-message",
        data: { customType: "pi-gui-diagnostic", display: false, content: `Unhandled agent event: ${event.type}`, timestamp: state.now },
      });
      break;
  }

  return result;
}
