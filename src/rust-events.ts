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
