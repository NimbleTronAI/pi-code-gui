// Pure, vscode-free helpers for handling raw Rust RPC events. Kept separate from
// PiService so they can be unit-tested headlessly (see src/test/unit/). Imports
// only a type (erased) and the shared text extractor from agent-events — the
// dependency points rust-specific → shared, never the other way around.
import type { RustEvent } from "./rust-process.js";
import { extractMessageText } from "./agent-events.js";

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

// NOTE: isTransientProviderError used to live here, driving an extension-side
// reprompt-retry. Both were removed: re-sending the prompt after a mid-tool-call
// drop corrupts the conversation (dangling assistant tool_calls → provider 400),
// and pi_agent_rust ≥ ad719ad3 classifies transient connection errors from the
// typed error (gh #118) and re-drives the request in place — the correct layer.

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

/** Promote a queued message to steering in the synthetic queue (Rust path):
 *  remove it from follow-up if present, then ensure it's in steering exactly
 *  once. Mutates both arrays in place. Returns false for empty/blank text (no
 *  change). The caller is responsible for sending the actual steer RPC. */
export function promoteQueuedToSteer(steering: string[], followUp: string[], text: string): boolean {
  const t = (text ?? "").trim();
  if (!t) { return false; }
  const fi = followUp.findIndex((m) => m.trim() === t);
  if (fi >= 0) { followUp.splice(fi, 1); }
  if (!steering.some((m) => m.trim() === t)) { steering.push(text); }
  return true;
}

/**
 * Claim the one-time "capability degraded" warning slot for `cap`. A Rust
 * capability RPC (model list, history, usage, …) failing must not be silent, but
 * it also must not spam after every turn — so warn only the FIRST time a given
 * capability fails (recorded in `warned`) until it recovers and clearDegraded()
 * resets it. NOTE: this both decides AND records — it MUTATES `warned` and
 * returns true only on the first failure, so the caller should emit then.
 */
export function checkAndRecordDegraded(warned: Set<string>, cap: string): boolean {
  if (warned.has(cap)) { return false; }
  warned.add(cap);
  return true;
}

/** Mark capability `cap` healthy again so a future failure warns once more. */
export function clearDegraded(warned: Set<string>, cap: string): void {
  warned.delete(cap);
}

// ── Rust RPC response parsers ─────────────────────────────────────────
// Pure, shape-tolerant deserializers for the handshake/refresh replies. The Rust
// binary's JSON has no shared schema with the extension, so these tolerate the
// known shape variants and degenerate inputs (null/missing/array-vs-{list}); they
// live here (vscode-free) so the parsing — the part most likely to break when
// rust-pi changes its payloads — is unit-tested rather than locked in RustService.

/** A model entry for the model-cycle list (mirrors PiService.cycleModels). */
export interface RustModelEntry {
  provider: string;
  id: string;
  name?: string;
  cost?: { input: number; output: number };
  contextWindow?: number;
}

/** Normalize a Rust `get_available_models` reply to {provider, id, …} pairs. */
export function parseRustModels(data: unknown): RustModelEntry[] {
  const d = data as { models?: unknown } | undefined;
  const raw = Array.isArray(d?.models) ? d.models : (Array.isArray(data) ? data : []);
  return raw
    .filter((m) => m && typeof m.provider === "string" && typeof m.id === "string")
    .map((m) => ({
      provider: m.provider,
      id: m.id,
      name: typeof m.name === "string" ? m.name : undefined,
      contextWindow: typeof m.contextWindow === "number" ? m.contextWindow : undefined,
      cost: m.cost && typeof m.cost.input === "number" ? { input: m.cost.input, output: m.cost.output } : undefined,
    }));
}

/** Wrap a Rust `get_messages` reply as session-entry shapes for sendInitialMessages. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function parseRustEntries(data: unknown): any[] {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const d = data as { messages?: any[] } | undefined;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const messages: any[] = Array.isArray(d?.messages) ? d.messages : (Array.isArray(data) ? (data) : []);
  return messages.map((m, i) => {
    // Pass through items that are already session-ENTRY-shaped (an entry `type`
    // and no message `role`) — e.g. a compaction summary, should rust-pi ever
    // emit one via get_messages. Wrapping such an item as {type:"message"} would
    // bury it: the replay loop dispatches on entry.type and would render nothing.
    if (m && typeof m === "object" && typeof m.type === "string" && m.role === undefined) {
      return { id: m.id ?? `rust-${i}`, ...m };
    }
    return { type: "message", message: m, id: m?.id ?? `rust-${i}` };
  });
}

/** Map a Rust `get_commands` reply to slash-command entries. */
export function parseRustSlashCommands(data: unknown): Array<{ cmd: string; desc: string; source: string }> {
  const list = (data as { commands?: unknown })?.commands;
  if (!Array.isArray(list)) { return []; }
  const out: Array<{ cmd: string; desc: string; source: string }> = [];
  for (const c of list as Array<Record<string, unknown>>) {
    const name = String(c.invocationName ?? c.name ?? c.command ?? c.id ?? "").replace(/^\/+/, "");
    if (!name) { continue; }
    const src = c.source ?? (c.sourceInfo as { source?: unknown } | undefined)?.source;
    out.push({ cmd: `/${name}`, desc: String(c.description ?? c.desc ?? ""), source: src ? `rust (${String(src)})` : "rust" });
  }
  return out;
}
