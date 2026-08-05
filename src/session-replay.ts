// Session-history → PiServiceEvent replay — the pure core of PiService.sendInitialMessages
// (the ~110-line block that re-emits a stored session on reload/resume). Same shape as
// agent-events.ts translateAgentEvent: this decides WHICH events reproduce the session; the
// PiService shell owns the side effects (emitting + yielding to the event loop so the webview
// paints incrementally, appending to its capped user-message history).
//
// Extracted from the god class and unit-tested against fixture entries — previously the whole
// replay path (user/assistant/tool/bash/custom/compaction ordering) had no coverage.
/* eslint-disable @typescript-eslint/no-explicit-any -- SDK/Rust session entries are dynamically typed */
import type { PiServiceEvent } from "./types.js";
import { extractMessageText, extractToolCalls, normalizeToolArgs, type EntryLookups } from "./agent-events.js";

export interface ReplayUserMessage { id: string; text: string; timestamp?: number; }

export interface ReplayResult {
  /** One event group per source entry, in original (oldest-first) order. The shell emits each
   *  group then yields, so a large session paints top-down without flooding the host. */
  groups: PiServiceEvent[][];
  /** User messages discovered during replay, in order — the shell appends them to its capped
   *  resend/reuse history. */
  userMessages: ReplayUserMessage[];
}

/** SDK entries store timestamps as ISO strings; the protocol expects numbers. Pure — the
 *  `now` fallback is injected so replay is deterministic under test. */
export function toTimestamp(ts: unknown, now: number): number {
  if (typeof ts === "number") { return ts; }
  if (ts) { return Date.parse(String(ts)); }
  return now;
}

/** Extract thinking-block text from an assistant message content array. Pure. */
export function extractThinking(content: any): string {
  if (!content) { return ""; }
  if (Array.isArray(content)) {
    return content
      .filter((c: any) => c.type === "thinking")
      .map((c: any) => c.thinking)
      .join("\n");
  }
  return "";
}

/** Index entries once: by message id and by tool-call id (the toolResult lookup). Pure —
 *  replaces PiService.getEntriesWithLookups' inline O(n) scan, shared with the live path. */
export function indexEntries(entries: any[]): EntryLookups {
  const byMessageId = new Map<string, any>();
  const byToolCallId = new Map<string, any>();
  for (const e of entries) {
    if (e.type === "message") {
      if (e.message?.id) { byMessageId.set(e.message.id, e); }
      if (e.message?.role === "toolResult" && e.message?.toolCallId) {
        byToolCallId.set(e.message.toolCallId, e);
      }
    }
  }
  return { entries, byMessageId, byToolCallId };
}

/** Replay stored session entries into the ordered PiServiceEvent groups that reproduce them
 *  on the webview. Pure: no emitting, no state — a function of (entries, now). Mirrors the
 *  original sendInitialMessages emit sequence verbatim (assistant messages always emit, even
 *  tool-only ones; bash/exec tool calls render as bash cards; missing tool results fall back
 *  to a "(completed)" stub). */
export function replaySessionEntries(entries: any[], opts: { now: number }): ReplayResult {
  const { now } = opts;
  const groups: PiServiceEvent[][] = [];
  const userMessages: ReplayUserMessage[] = [];
  if (!entries || entries.length === 0) { return { groups, userMessages }; }

  const toolResultsById = indexEntries(entries).byToolCallId;

  for (const entry of entries) {
    const ev: PiServiceEvent[] = [];
    if (entry.type === "message" && entry.message) {
      const msg = entry.message;
      if (msg.role === "user") {
        const text = extractMessageText(msg.content);
        if (text) {
          userMessages.push({ id: msg.id ?? `user-${now}`, text, timestamp: msg.timestamp });
          ev.push({ type: "chat-message", data: { role: "user", content: text, entryId: entry.id } });
        }
      } else if (msg.role === "assistant") {
        const text = extractMessageText(msg.content);
        const thinking = extractThinking(msg.content);
        const toolCalls = extractToolCalls(msg.content);

        // Always emit assistant messages — even tool-only ones with no text. Skipping them
        // makes tool executions invisible on reload/resume.
        ev.push({ type: "assistant-start", data: { messageId: msg.id, entryId: entry.id } });
        if (thinking) {
          ev.push({ type: "thinking-delta", data: { delta: thinking } });
          ev.push({ type: "thinking-delta", data: { delta: "", done: true } });
        }
        if (text) {
          ev.push({ type: "stream-delta", data: { delta: text } });
        }
        ev.push({
          type: "assistant-end",
          data: { stopReason: msg.stopReason, errorMessage: msg.errorMessage, toolCalls: toolCalls.map((tc) => tc.id) },
        });

        for (const tc of toolCalls) {
          const toolResultEntry = toolResultsById.get(tc.id);
          if (tc.name === "bash" || tc.name === "exec") {
            ev.push({ type: "bash-start", data: { toolCallId: tc.id, command: tc.arguments?.command ?? "", entryId: toolResultEntry?.id } });
            const outputText = toolResultEntry?.message ? extractMessageText(toolResultEntry.message.content) : "";
            ev.push({
              type: "bash-end",
              data: { toolCallId: tc.id, command: tc.arguments?.command ?? "", exitCode: 0, cancelled: false, output: outputText, isError: false, entryId: toolResultEntry?.id },
            });
          } else {
            ev.push({ type: "tool-start", data: { toolCallId: tc.id, toolName: tc.name, args: normalizeToolArgs(tc.arguments), fromMessage: true, entryId: toolResultEntry?.id } });
            if (toolResultEntry?.message) {
              ev.push({ type: "tool-end", data: { toolCallId: tc.id, toolName: tc.name, result: toolResultEntry.message, isError: false, entryId: toolResultEntry?.id } });
            } else {
              ev.push({ type: "tool-end", data: { toolCallId: tc.id, toolName: tc.name, result: { content: [{ type: "text", text: "(completed)" }] }, isError: false, entryId: toolResultEntry?.id } });
            }
          }
        }
      } else if (msg.role === "custom") {
        ev.push({ type: "custom-message", data: { customType: msg.customType, content: msg.content, display: msg.display, details: msg.details, timestamp: msg.timestamp, entryId: entry.id } });
      } else if (msg.role === "bashExecution") {
        const bashEntryId = entry.id ?? `bash-${now}`;
        ev.push({ type: "bash-start", data: { toolCallId: bashEntryId, command: msg.command ?? "", entryId: entry.id } });
        ev.push({ type: "bash-end", data: { toolCallId: bashEntryId, command: msg.command ?? "", exitCode: msg.exitCode, cancelled: msg.cancelled, output: msg.output ?? "", isError: msg.exitCode !== 0 && msg.exitCode !== null, entryId: entry.id } });
      }
    } else if (entry.type === "compaction") {
      ev.push({
        type: "compaction-summary-message",
        data: { summary: entry.summary ?? "", tokensBefore: entry.tokensBefore ?? 0, timestamp: toTimestamp(entry.timestamp, now), entryId: entry.id },
      });
    }
    groups.push(ev);
  }

  return { groups, userMessages };
}
