// Unit tests for translateAgentEvent — the pure core extracted from
// PiService.handleAgentEvent (the dual-runtime streaming dispatcher). One group
// per event type; asserts the emitted events, the scalar state mutations, the
// in-place container mutations, and the trailing effects.

import { test } from "node:test";
import assert from "node:assert/strict";
import { translateAgentEvent, extractToolCalls, normalizeToolArgs, toolArgsPreviewText, type AgentTranslateState } from "../../agent-events.js";

function makeState(over: Partial<AgentTranslateState> = {}): AgentTranslateState {
  return {
    backendKind: "typescript",
    agentRunActive: false,
    lookups: { entries: [], byMessageId: new Map(), byToolCallId: new Map() },
    userMessages: [],
    toolCalls: new Map(),
    now: 1000,
    prepareArgs: (_n, a) => a,
    ...over,
  };
}

const types = (r: { events: Array<{ type: string }> }): string[] => r.events.map((e) => e.type);

// ── agent_start / agent_end ──────────────────────────────────────────
test("agent_start: emits agent-start and sets streaming/active, resets turn, clears tools", () => {
  const r = translateAgentEvent({ type: "agent_start" }, makeState());
  assert.deepEqual(types(r), ["agent-start"]);
  assert.equal(r.setAgentRunActive, true);
  assert.equal(r.setStreaming, true);
  assert.equal(r.clearToolCalls, true);
  assert.equal(r.turnIndex, "reset");
});

test("agent_end (rust, run not active): treated as the duplicate — no-op", () => {
  const r = translateAgentEvent({ type: "agent_end", messages: [] }, makeState({ backendKind: "rust", agentRunActive: false }));
  assert.deepEqual(r.events, []);
  assert.equal(r.setAgentRunActive, undefined);
  assert.equal(r.effects.reportStatus, undefined);
  assert.equal(r.effects.rustClearQueue, undefined);
});

test("agent_end (rust, active): emits agent-end, clears rust queue, reports status", () => {
  const r = translateAgentEvent({ type: "agent_end", messages: ["m"] }, makeState({ backendKind: "rust", agentRunActive: true }));
  assert.deepEqual(types(r), ["agent-end"]);
  assert.equal(r.setAgentRunActive, false);
  assert.equal(r.setStreaming, false);
  assert.equal(r.effects.rustClearQueue, true);
  assert.equal(r.effects.reportStatus, true);
});

test("agent_end (typescript): reports status but does NOT touch a rust queue", () => {
  const r = translateAgentEvent({ type: "agent_end", messages: [] }, makeState({ backendKind: "typescript" }));
  assert.deepEqual(types(r), ["agent-end"]);
  assert.equal(r.effects.rustClearQueue, undefined);
  assert.equal(r.effects.reportStatus, true);
});

// ── turn_start / turn_end ────────────────────────────────────────────
test("turn_start: emits turn-start", () => {
  const r = translateAgentEvent({ type: "turn_start" }, makeState());
  assert.deepEqual(types(r), ["turn-start"]);
});

test("turn_end: emits turn-end and increments the turn index", () => {
  const r = translateAgentEvent({ type: "turn_end", message: { id: "x" }, toolResults: [] }, makeState());
  assert.deepEqual(types(r), ["turn-end"]);
  assert.equal(r.turnIndex, "increment");
});

// ── message_start ────────────────────────────────────────────────────
test("message_start user: records the user message and emits chat-message", () => {
  const st = makeState();
  const r = translateAgentEvent({ type: "message_start", message: { role: "user", id: "u1", content: "hello" } }, st);
  assert.deepEqual(types(r), ["chat-message"]);
  assert.equal(st.userMessages.length, 1);
  assert.equal(st.userMessages[0].text, "hello");
  assert.equal((r.events[0] as any).data.entryId, "u1");
});

test("message_start user: entryId resolves through the lookup when present", () => {
  const byMessageId = new Map([["u1", { id: "entry-7" }]]);
  const st = makeState({ lookups: { entries: [], byMessageId, byToolCallId: new Map() } });
  const r = translateAgentEvent({ type: "message_start", message: { role: "user", id: "u1", content: "hi" } }, st);
  assert.equal((r.events[0] as any).data.entryId, "entry-7");
});

test("message_start user with empty content: no record, no event", () => {
  const st = makeState();
  const r = translateAgentEvent({ type: "message_start", message: { role: "user", id: "u1", content: "" } }, st);
  assert.deepEqual(r.events, []);
  assert.equal(st.userMessages.length, 0);
});

test("message_start user: the recent-message ring caps at 50", () => {
  const st = makeState();
  for (let i = 0; i < 60; i++) {
    translateAgentEvent({ type: "message_start", message: { role: "user", id: `u${i}`, content: `m${i}` } }, st);
  }
  assert.equal(st.userMessages.length, 50);
  assert.equal(st.userMessages[0].text, "m10");
});

test("message_start assistant: clears tool calls and emits assistant-start", () => {
  const r = translateAgentEvent({ type: "message_start", message: { role: "assistant", id: "a1" } }, makeState());
  assert.deepEqual(types(r), ["assistant-start"]);
  assert.equal(r.clearToolCalls, true);
});

// ── message_update (deltas + streaming tool previews) ─────────────────
test("message_update text_delta → stream-delta", () => {
  const r = translateAgentEvent({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "abc" } }, makeState());
  assert.deepEqual(types(r), ["stream-delta"]);
  assert.equal((r.events[0] as any).data.delta, "abc");
});

test("message_update thinking_delta / thinking_end / error", () => {
  assert.deepEqual(types(translateAgentEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: "t" } }, makeState())), ["thinking-delta"]);
  const end = translateAgentEvent({ type: "message_update", assistantMessageEvent: { type: "thinking_end" } }, makeState());
  assert.equal((end.events[0] as any).data.done, true);
  const err = translateAgentEvent({ type: "message_update", assistantMessageEvent: { type: "error", error: "boom" } }, makeState());
  assert.equal((err.events[0] as any).data.message, "boom");
});

test("message_update error: a provider-key failure is humanized in place", () => {
  const raw = 'Failed to resolve API key for provider "deepseek" from environment variable: ENV';
  const r = translateAgentEvent({ type: "message_update", assistantMessageEvent: { type: "error", error: raw } }, makeState());
  const message = (r.events[0] as any).data.message as string;
  assert.match(message, /deepseek: API key could not be resolved/);
  assert.match(message, /\$\{DEEPSEEK_API_KEY\}/);  // actionable remediation, not the raw SDK string
});

test("message_update: a new tool call records state and emits tool-start (fromMessage)", () => {
  const st = makeState();
  const content = [{ type: "toolCall", id: "t1", name: "write", arguments: { path: "a" } }];
  const r = translateAgentEvent({ type: "message_update", message: { role: "assistant", content } }, st);
  assert.deepEqual(types(r), ["tool-start"]);
  assert.equal((r.events[0] as any).data.fromMessage, true);
  assert.ok(st.toolCalls.has("t1"));
  assert.equal(st.toolCalls.get("t1")!.lastPreviewEmit, 1000);
});

test("message_update: an existing tool call within the throttle window updates args but emits nothing", () => {
  const st = makeState({ now: 1100 });
  st.toolCalls.set("t1", { toolName: "write", toolCallId: "t1", args: { path: "a" }, lastPreviewEmit: 1000 });
  const content = [{ type: "toolCall", id: "t1", name: "write", arguments: { path: "ab" } }];
  const r = translateAgentEvent({ type: "message_update", message: { role: "assistant", content } }, st);
  assert.deepEqual(r.events, []); // 1100 - 1000 = 100ms < 200ms throttle
  assert.deepEqual(st.toolCalls.get("t1")!.args, { path: "ab" });
});

test("message_update: an existing tool call past the throttle window emits tool-update and advances lastPreviewEmit", () => {
  const st = makeState({ now: 1300 });
  st.toolCalls.set("t1", { toolName: "write", toolCallId: "t1", args: { path: "a" }, lastPreviewEmit: 1000 });
  const content = [{ type: "toolCall", id: "t1", name: "write", arguments: { path: "abc" } }];
  const r = translateAgentEvent({ type: "message_update", message: { role: "assistant", content } }, st);
  assert.deepEqual(types(r), ["tool-update"]);
  assert.equal(st.toolCalls.get("t1")!.lastPreviewEmit, 1300);
});

test("message_update: past throttle but still-null partial args → no tool-update, clock not advanced (#124)", () => {
  const st = makeState({ now: 1300 });
  st.toolCalls.set("t1", { toolName: "write", toolCallId: "t1", args: null, lastPreviewEmit: 1000 });
  const content = [{ type: "toolCall", id: "t1", name: "write", arguments: null }];
  const r = translateAgentEvent({ type: "message_update", message: { role: "assistant", content } }, st);
  assert.deepEqual(r.events, []); // nothing meaningful to preview yet — don't flash "null"
  assert.equal(st.toolCalls.get("t1")!.lastPreviewEmit, 1000); // unchanged, so the next real delta emits promptly
});

test("message_update: growing partial-JSON STRING args → tool-update shows the raw string (not double-encoded)", () => {
  const st = makeState({ now: 1300 });
  st.toolCalls.set("t1", { toolName: "write", toolCallId: "t1", args: "{\"path\":\"sr", lastPreviewEmit: 1000 });
  const content = [{ type: "toolCall", id: "t1", name: "write", arguments: "{\"path\":\"src/fo" }];
  const r = translateAgentEvent({ type: "message_update", message: { role: "assistant", content } }, st);
  assert.deepEqual(types(r), ["tool-update"]);
  assert.equal((r.events[0] as { data: { partialResult: { content: Array<{ text: string }> } } }).data.partialResult.content[0].text, "{\"path\":\"src/fo");
});

test("message_update: bash/exec and id-less tool calls are not previewed", () => {
  const st = makeState();
  const content = [
    { type: "toolCall", id: "b1", name: "bash", arguments: { command: "ls" } },
    { type: "toolCall", id: "", name: "write", arguments: {} },
  ];
  const r = translateAgentEvent({ type: "message_update", message: { role: "assistant", content } }, st);
  assert.deepEqual(r.events, []);
  assert.equal(st.toolCalls.size, 0);
});

// ── toolArgsPreviewText (streaming partial-args display, #124) ────────
test("toolArgsPreviewText: object → pretty JSON; string → as-is; primitives → String()", () => {
  assert.equal(toolArgsPreviewText({ path: "a" }), "{\n  \"path\": \"a\"\n}");
  assert.equal(toolArgsPreviewText("{\"path\":\"src/fo"), "{\"path\":\"src/fo");
  assert.equal(toolArgsPreviewText(42), "42");
});

test("toolArgsPreviewText: null / undefined / empty-string / empty-object → null (skip the frame)", () => {
  assert.equal(toolArgsPreviewText(null), null);
  assert.equal(toolArgsPreviewText(undefined), null);
  assert.equal(toolArgsPreviewText(""), null);
  assert.equal(toolArgsPreviewText({}), null);
});

// ── message_end ──────────────────────────────────────────────────────
test("message_end user: nothing", () => {
  const r = translateAgentEvent({ type: "message_end", message: { role: "user" } }, makeState());
  assert.deepEqual(r.events, []);
  assert.equal(r.effects.reportStatus, undefined);
});

test("message_end assistant (typescript): emits assistant-end, reports status, no context capture", () => {
  const content = [{ type: "toolCall", id: "t1", name: "write", arguments: {} }];
  const r = translateAgentEvent({ type: "message_end", message: { role: "assistant", content, stopReason: "end", usage: { input: 5 } } }, makeState());
  assert.deepEqual(types(r), ["assistant-end"]);
  assert.deepEqual((r.events[0] as any).data.toolCalls, ["t1"]);
  assert.equal(r.effects.reportStatus, true);
  assert.equal(r.effects.captureContext, undefined);
});

test("message_end assistant (rust): captures context usage before reporting status", () => {
  const usage = { input: 42 };
  const r = translateAgentEvent({ type: "message_end", message: { role: "assistant", content: [], usage } }, makeState({ backendKind: "rust" }));
  assert.equal(r.effects.captureContext, true);
  assert.deepEqual(r.effects.captureUsage, usage);
  assert.equal(r.effects.reportStatus, true);
});

test("message_end custom: emits custom-message with entryId from the last custom entry", () => {
  const entries = [
    { id: "e1", type: "message", message: { role: "assistant" } },
    { id: "e2", type: "message", message: { role: "custom" } },
  ];
  const st = makeState({ lookups: { entries, byMessageId: new Map(), byToolCallId: new Map() } });
  const r = translateAgentEvent({ type: "message_end", message: { role: "custom", id: "c9", customType: "card", content: "x" } }, st);
  assert.deepEqual(types(r), ["custom-message"]);
  assert.equal((r.events[0] as any).data.entryId, "e2");
});

// ── tool_execution_* ─────────────────────────────────────────────────
test("tool_execution_start: applies prepareArgs and emits tool-start (fromMessage false)", () => {
  const byToolCallId = new Map([["t1", { id: "entry-3" }]]);
  const st = makeState({ lookups: { entries: [], byMessageId: new Map(), byToolCallId }, prepareArgs: (_n, a) => ({ ...a, prepared: true }) });
  const r = translateAgentEvent({ type: "tool_execution_start", toolCallId: "t1", toolName: "edit", args: { raw: 1 } }, st);
  assert.deepEqual(types(r), ["tool-start"]);
  assert.equal((r.events[0] as any).data.fromMessage, false);
  assert.equal((r.events[0] as any).data.entryId, "entry-3");
  assert.deepEqual((r.events[0] as any).data.args, { raw: 1, prepared: true });
});

test("tool_execution_start bash: emits bash-start with the prepared command", () => {
  const r = translateAgentEvent({ type: "tool_execution_start", toolCallId: "b1", toolName: "bash", args: { command: "ls -la" } }, makeState());
  assert.deepEqual(types(r), ["bash-start"]);
  assert.equal((r.events[0] as any).data.command, "ls -la");
});

test("tool_execution_update: bash → bash-output, other → tool-update", () => {
  const bash = translateAgentEvent({ type: "tool_execution_update", toolCallId: "b1", toolName: "bash", partialResult: { content: [{ type: "text", text: "line" }] } }, makeState());
  assert.deepEqual(types(bash), ["bash-output"]);
  assert.equal((bash.events[0] as any).data.output, "line");
  const other = translateAgentEvent({ type: "tool_execution_update", toolCallId: "t1", toolName: "write", partialResult: { x: 1 } }, makeState());
  assert.deepEqual(types(other), ["tool-update"]);
});

test("tool_execution_end: bash → bash-end (exitCode from isError), other → tool-end", () => {
  const bash = translateAgentEvent({ type: "tool_execution_end", toolCallId: "b1", toolName: "bash", isError: true, args: { command: "x" }, result: { content: [{ type: "text", text: "out" }] } }, makeState());
  assert.deepEqual(types(bash), ["bash-end"]);
  assert.equal((bash.events[0] as any).data.exitCode, 1);
  assert.equal((bash.events[0] as any).data.output, "out");
  const other = translateAgentEvent({ type: "tool_execution_end", toolCallId: "t1", toolName: "write", isError: false, result: { ok: 1 } }, makeState());
  assert.deepEqual(types(other), ["tool-end"]);
  assert.equal((other.events[0] as any).data.isError, false);
});

// ── status / thinking / queue ────────────────────────────────────────
test("session_info_changed: reports status, no events", () => {
  const r = translateAgentEvent({ type: "session_info_changed" }, makeState());
  assert.deepEqual(r.events, []);
  assert.equal(r.effects.reportStatus, true);
});

test("thinking_level_changed: sets level, emits, reports status", () => {
  const r = translateAgentEvent({ type: "thinking_level_changed", level: "high" }, makeState());
  assert.deepEqual(types(r), ["thinking-level-changed"]);
  assert.equal(r.setThinkingLevel, "high");
  assert.equal(r.effects.reportStatus, true);
});

test("queue_update: emits queue-update, coercing Sets to arrays", () => {
  const r = translateAgentEvent({ type: "queue_update", steering: new Set(["s1"]), followUp: ["f1"] }, makeState());
  assert.deepEqual(types(r), ["queue-update"]);
  assert.deepEqual((r.events[0] as any).data.steering, ["s1"]);
  assert.deepEqual((r.events[0] as any).data.followUp, ["f1"]);
});

// ── compaction ───────────────────────────────────────────────────────
test("compaction_start: emits compaction-start", () => {
  const r = translateAgentEvent({ type: "compaction_start", reason: "auto" }, makeState());
  assert.deepEqual(types(r), ["compaction-start"]);
});

test("compaction_end with result, no entry (Rust): falls back to a synthetic compaction entryId", () => {
  const r = translateAgentEvent({ type: "compaction_end", result: { summary: "s", tokensBefore: 10 } }, makeState({ now: 5000 }));
  assert.deepEqual(types(r), ["compaction-end", "compaction-summary-message"]);
  assert.equal((r.events[1] as any).data.entryId, "compaction-5000");
});

test("compaction_end with result + a compaction entry: uses the entry id", () => {
  const entries = [{ id: "c-entry", type: "compaction" }];
  const st = makeState({ lookups: { entries, byMessageId: new Map(), byToolCallId: new Map() } });
  const r = translateAgentEvent({ type: "compaction_end", result: { summary: "s", tokensBefore: 10 } }, st);
  assert.equal((r.events[1] as any).data.entryId, "c-entry");
});

test("compaction_end without a result: only the compaction-end event", () => {
  const r = translateAgentEvent({ type: "compaction_end", reason: "abort" }, makeState());
  assert.deepEqual(types(r), ["compaction-end"]);
});

// ── auto-retry ───────────────────────────────────────────────────────
test("auto_retry_start / auto_retry_end", () => {
  assert.deepEqual(types(translateAgentEvent({ type: "auto_retry_start", attempt: 1, maxAttempts: 3 }, makeState())), ["auto-retry-start"]);
  assert.deepEqual(types(translateAgentEvent({ type: "auto_retry_end", success: true, attempt: 1 }, makeState())), ["auto-retry-end"]);
});

// ── unknown ──────────────────────────────────────────────────────────
test("unknown event: flags unknownType and emits a hidden diagnostic custom-message", () => {
  const r = translateAgentEvent({ type: "totally_new_event" }, makeState());
  assert.equal(r.effects.unknownType, "totally_new_event");
  assert.deepEqual(types(r), ["custom-message"]);
  assert.equal((r.events[0] as any).data.display, false);
});

// ── extractToolCalls (the shared pure helper) ────────────────────────
test("extractToolCalls: filters toolCall blocks, maps to {name,id,arguments}", () => {
  const out = extractToolCalls([
    { type: "text", text: "hi" },
    { type: "toolCall", id: "t1", name: "write", arguments: { p: 1 } },
  ]);
  assert.deepEqual(out, [{ name: "write", id: "t1", arguments: { p: 1 } }]);
});

test("extractToolCalls: null/empty content → []", () => {
  assert.deepEqual(extractToolCalls(null), []);
  assert.deepEqual(extractToolCalls([]), []);
});

test("normalizeToolArgs: passes a plain record through unchanged", () => {
  const args = { path: "a.ts", n: 1 };
  assert.equal(normalizeToolArgs(args), args); // same reference, not a copy
});

test("normalizeToolArgs: null/undefined → {} (the historical-replay bug)", () => {
  assert.deepEqual(normalizeToolArgs(null), {});
  assert.deepEqual(normalizeToolArgs(undefined), {});
});

test("normalizeToolArgs: non-record junk (array, primitive) → {}", () => {
  assert.deepEqual(normalizeToolArgs([1, 2]), {});
  assert.deepEqual(normalizeToolArgs("nope"), {});
  assert.deepEqual(normalizeToolArgs(42), {});
  assert.deepEqual(normalizeToolArgs(true), {});
});
