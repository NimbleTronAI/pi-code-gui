// Pure, vscode-free helpers for handling raw Rust RPC events. Kept separate from
// PiService so they can be unit-tested headlessly (see src/test/unit/). No runtime
// imports — the only import is a type, which is erased at compile time.
import type { RustEvent } from "./rust-process.js";

/**
 * Coerce Rust RPC payloads to the shapes the shared protocol schema requires.
 * The Rust runtime sends `null` where the TypeScript SDK sends objects/strings
 * (e.g. a tool with no params → `args: null`, `result.details: null`); the
 * schema is strict on purpose, so we normalize on the Rust ingress only rather
 * than weaken validation for the TS path. Mutates `event` in place. Fields are
 * read exactly as PiService.handleAgentEvent reads them.
 */
export function normalizeRustEvent(event: RustEvent): void {
  const nil = (v: unknown): boolean => v === null || v === undefined;
  const fixText = (content: unknown): void => {
    if (!Array.isArray(content)) { return; }
    for (const c of content) {
      if (c && typeof c === "object" && (c as { type?: string }).type === "text" && nil((c as { text?: unknown }).text)) {
        (c as { text: string }).text = "";
      }
    }
  };
  const r = event as Record<string, unknown>;
  switch (event?.type) {
    case "tool_execution_start":
      if (nil(r.args)) { r.args = {}; }
      break;
    case "tool_execution_update":
      if (nil(r.partialResult)) { r.partialResult = {}; }
      else { fixText((r.partialResult as { content?: unknown }).content); }
      break;
    case "tool_execution_end":
      if (r.result === null) { delete r.result; }
      else if (r.result && typeof r.result === "object") {
        const res = r.result as { details?: unknown; content?: unknown };
        if (res.details === null) { delete res.details; }
        fixText(res.content);
      }
      break;
    case "message_update": {
      const d = r.assistantMessageEvent as { type?: string; delta?: unknown } | undefined;
      if (d && (d.type === "text_delta" || d.type === "thinking_delta") && nil(d.delta)) { d.delta = ""; }
      break;
    }
    case "message_end": {
      const m = r.message as { role?: string; content?: unknown; details?: unknown } | undefined;
      if (m && typeof m === "object") {
        if (m.role === "custom" && nil(m.content)) { m.content = ""; }
        if (m.details === null) { delete m.details; }
      }
      break;
    }
    case "compaction_end": {
      const res = r.result as { summary?: unknown; tokensBefore?: unknown } | undefined;
      if (res && typeof res === "object") {
        if (nil(res.summary)) { res.summary = ""; }
        if (nil(res.tokensBefore)) { res.tokensBefore = 0; }
      }
      break;
    }
  }
}

/**
 * Extract the plain-text portion of a message `content` payload. Mirrors the
 * runtime-agnostic extraction PiService uses on both the TS-SDK and Rust paths:
 * a bare string is returned as-is; an array yields the joined `text` blocks;
 * anything else (incl. null/undefined) yields "". Kept here (vscode-free) so the
 * Rust ingress router can decide queue-drops without reaching into PiService.
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

/** A declarative plan for how PiService should dispatch one raw Rust RPC event,
 *  computed without any vscode/PiService state mutation so it is unit-testable. */
export interface RustEventRouting {
  /** Candidate text to drop from the synthetic queue (a user `message_start`
   *  while the queue is non-empty); null when no drop should be attempted. The
   *  caller still confirms via dropQueuedMessage before clearing the indicator. */
  dropQueuedText: string | null;
  /** Session id to capture from an `agent_start` event, if present. */
  captureSessionId: string | null;
  /** True only for the FIRST `agent_end` of an active run — the dedupe against
   *  rust-pi emitting `agent_end` twice on the abort/error path. */
  isRealAgentEnd: boolean;
  /** How the caller should dispatch the event after the above side-effects:
   *  - "ui-request"      → handle as an extension_ui_request (no delegate)
   *  - "extension-error" → surface as an error message (no delegate)
   *  - "delegate"        → route through the shared handleAgentEvent path */
  action: "ui-request" | "extension-error" | "delegate";
}

/**
 * Decide how to dispatch a (already normalized) Rust RPC event. Pure: depends
 * only on the event and the two pieces of PiService state passed in, mutates
 * nothing, and returns a plan the caller executes. This isolates the quirky,
 * Rust-only routing — synthetic-queue clearing, ui-request/error short-circuits,
 * sessionId capture, and the double-`agent_end` dedupe — from the vscode-coupled
 * shell so it can be tested headlessly.
 */
export function routeRustEvent(event: RustEvent, queueNonEmpty: boolean, agentRunActive: boolean): RustEventRouting {
  const type = event?.type;
  const msg = (event as { message?: { role?: string; content?: unknown } }).message;
  const dropQueuedText =
    queueNonEmpty && type === "message_start" && msg?.role === "user"
      ? extractMessageText(msg?.content)
      : null;
  let action: RustEventRouting["action"] = "delegate";
  let captureSessionId: string | null = null;
  if (type === "extension_ui_request") {
    action = "ui-request";
  } else if (type === "extension_error") {
    action = "extension-error";
  } else if (type === "agent_start" && typeof event.sessionId === "string") {
    captureSessionId = event.sessionId;
  }
  return { dropQueuedText, captureSessionId, isRealAgentEnd: type === "agent_end" && agentRunActive, action };
}

/**
 * Drop the first queued steer/follow-up message matching `text`. rust-pi (0.1.18)
 * emits no queue_update, so PiService tracks the pending queue itself and clears
 * an entry when the binary folds it into a user turn (which arrives with the same
 * text). Mutates the arrays in place; returns true if an entry was removed.
 */
export function dropQueuedMessage(steering: string[], followUp: string[], text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) { return false; }
  let i = steering.findIndex((m) => m.trim() === t);
  if (i >= 0) { steering.splice(i, 1); return true; }
  i = followUp.findIndex((m) => m.trim() === t);
  if (i >= 0) { followUp.splice(i, 1); return true; }
  return false;
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
