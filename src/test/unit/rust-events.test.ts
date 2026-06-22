// Headless unit tests for the pure Rust-event helpers (no vscode dependency).
// Run with `pnpm run test:unit`. Shapes mirror real rust-pi 0.1.18 RPC output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeRustEvent, dropQueuedMessage, shouldEmitToolPreview, shouldEmitToolPreviewUpdate, TOOL_PREVIEW_THROTTLE_MS, checkAndRecordDegraded, clearDegraded, parseRustModels, parseRustEntries, parseRustSlashCommands } from "../../rust-events.js";

// ── normalizeRustEvent ────────────────────────────────────────────────
test("tool_execution_start: null args coerced to {}", () => {
  const e: any = { type: "tool_execution_start", toolName: "write", args: null };
  normalizeRustEvent(e);
  assert.deepEqual(e.args, {});
});

test("tool_execution_start: real args preserved", () => {
  const e: any = { type: "tool_execution_start", toolName: "write", args: { path: "/a", content: "hi" } };
  normalizeRustEvent(e);
  assert.deepEqual(e.args, { path: "/a", content: "hi" });
});

test("tool_execution_update: null partialResult coerced to {}", () => {
  const e: any = { type: "tool_execution_update", partialResult: null };
  normalizeRustEvent(e);
  assert.deepEqual(e.partialResult, {});
});

test("tool_execution_update: null text inside partialResult content fixed to ''", () => {
  const e: any = { type: "tool_execution_update", partialResult: { content: [{ type: "text", text: null }] } };
  normalizeRustEvent(e);
  assert.equal(e.partialResult.content[0].text, "");
});

test("tool_execution_end: null result is deleted", () => {
  const e: any = { type: "tool_execution_end", toolName: "write", result: null };
  normalizeRustEvent(e);
  assert.equal("result" in e, false);
});

test("tool_execution_end: null details deleted and null text fixed", () => {
  const e: any = { type: "tool_execution_end", result: { details: null, content: [{ type: "text", text: null }] } };
  normalizeRustEvent(e);
  assert.equal("details" in e.result, false);
  assert.equal(e.result.content[0].text, "");
});

test("tool_execution_end: real 'skipped' result (Bug A shape) survives normalization", () => {
  const e: any = {
    type: "tool_execution_end", toolName: "write", isError: true,
    result: { content: [{ type: "text", text: "Skipped due to queued user message." }], details: null },
  };
  normalizeRustEvent(e);
  assert.equal(e.result.content[0].text, "Skipped due to queued user message.");
  assert.equal("details" in e.result, false);
  assert.equal(e.isError, true);
});

test("message_update: null text_delta coerced to ''", () => {
  const e: any = { type: "message_update", assistantMessageEvent: { type: "text_delta", delta: null } };
  normalizeRustEvent(e);
  assert.equal(e.assistantMessageEvent.delta, "");
});

test("message_update: null thinking_delta coerced to ''", () => {
  const e: any = { type: "message_update", assistantMessageEvent: { type: "thinking_delta", delta: null } };
  normalizeRustEvent(e);
  assert.equal(e.assistantMessageEvent.delta, "");
});

test("message_end: custom role null content -> '' and null details deleted", () => {
  const e: any = { type: "message_end", message: { role: "custom", content: null, details: null } };
  normalizeRustEvent(e);
  assert.equal(e.message.content, "");
  assert.equal("details" in e.message, false);
});

test("compaction_end: null summary/tokensBefore defaulted", () => {
  const e: any = { type: "compaction_end", result: { summary: null, tokensBefore: null } };
  normalizeRustEvent(e);
  assert.equal(e.result.summary, "");
  assert.equal(e.result.tokensBefore, 0);
});

test("unknown/normal event passes through untouched", () => {
  const e: any = { type: "agent_start", sessionId: "abc" };
  normalizeRustEvent(e);
  assert.deepEqual(e, { type: "agent_start", sessionId: "abc" });
});

// ── dropQueuedMessage (the Rust synthetic-queue reducer) ──────────────
test("dropQueuedMessage: removes from steering and returns true", () => {
  const s = ["hello", "world"]; const f: string[] = [];
  assert.equal(dropQueuedMessage(s, f, "hello"), true);
  assert.deepEqual(s, ["world"]);
});

test("dropQueuedMessage: removes from followUp when not in steering", () => {
  const s: string[] = []; const f = ["later"];
  assert.equal(dropQueuedMessage(s, f, "later"), true);
  assert.deepEqual(f, []);
});

test("dropQueuedMessage: trims whitespace on both sides before matching", () => {
  const s = ["  steer me  "]; const f: string[] = [];
  assert.equal(dropQueuedMessage(s, f, "steer me"), true);
  assert.deepEqual(s, []);
});

test("dropQueuedMessage: no match or empty text returns false and mutates nothing", () => {
  const s = ["a"]; const f = ["b"];
  assert.equal(dropQueuedMessage(s, f, "c"), false);
  assert.equal(dropQueuedMessage(s, f, "   "), false);
  assert.deepEqual(s, ["a"]);
  assert.deepEqual(f, ["b"]);
});

test("dropQueuedMessage: removes only the first matching entry", () => {
  const s = ["dup", "dup"]; const f: string[] = [];
  assert.equal(dropQueuedMessage(s, f, "dup"), true);
  assert.deepEqual(s, ["dup"]);
});

// ── shouldEmitToolPreview (the "{} null" orphan-placeholder guard) ─────
test("shouldEmitToolPreview: requires a non-empty id (partial stream)", () => {
  assert.equal(shouldEmitToolPreview({ id: "call_1", name: "read" }), true);
  assert.equal(shouldEmitToolPreview({ id: "", name: "read" }), false);
  assert.equal(shouldEmitToolPreview({ id: undefined, name: "read" }), false);
  assert.equal(shouldEmitToolPreview({ id: null, name: "read" }), false);
});

test("shouldEmitToolPreview: id-less call with no name yet is skipped (the exact '{} null' case)", () => {
  assert.equal(shouldEmitToolPreview({ id: "", name: "" }), false);
  assert.equal(shouldEmitToolPreview({}), false);
});

test("shouldEmitToolPreview: bash/exec skipped even with an id (own render path)", () => {
  assert.equal(shouldEmitToolPreview({ id: "call_1", name: "bash" }), false);
  assert.equal(shouldEmitToolPreview({ id: "call_1", name: "exec" }), false);
});

// ── shouldEmitToolPreviewUpdate (streaming tool-arg preview throttle) ──
test("shouldEmitToolPreviewUpdate: always emits the first update (no prior emit)", () => {
  assert.equal(shouldEmitToolPreviewUpdate(undefined, 1000), true);
});

test("shouldEmitToolPreviewUpdate: suppresses updates within the throttle window", () => {
  const t0 = 100000;
  assert.equal(shouldEmitToolPreviewUpdate(t0, t0 + TOOL_PREVIEW_THROTTLE_MS - 1), false);
  assert.equal(shouldEmitToolPreviewUpdate(t0, t0 + 5), false);
});

test("shouldEmitToolPreviewUpdate: emits again once the interval has elapsed", () => {
  const t0 = 100000;
  assert.equal(shouldEmitToolPreviewUpdate(t0, t0 + TOOL_PREVIEW_THROTTLE_MS), true);
  assert.equal(shouldEmitToolPreviewUpdate(t0, t0 + 1000), true);
});

test("shouldEmitToolPreviewUpdate: respects a custom interval", () => {
  assert.equal(shouldEmitToolPreviewUpdate(0, 50, 100), false);
  assert.equal(shouldEmitToolPreviewUpdate(0, 100, 100), true);
});

// ── checkAndRecordDegraded / clearDegraded (capability-warning dedupe) ─
test("checkAndRecordDegraded: warns on the first failure, stays silent after", () => {
  const warned = new Set<string>();
  assert.equal(checkAndRecordDegraded(warned, "models"), true);
  assert.equal(checkAndRecordDegraded(warned, "models"), false);
  assert.equal(checkAndRecordDegraded(warned, "models"), false);
});

test("checkAndRecordDegraded: tracks each capability independently", () => {
  const warned = new Set<string>();
  assert.equal(checkAndRecordDegraded(warned, "models"), true);
  assert.equal(checkAndRecordDegraded(warned, "history"), true);
  assert.equal(checkAndRecordDegraded(warned, "models"), false);
});

test("clearDegraded: recovery re-arms the warning for that capability only", () => {
  const warned = new Set<string>();
  checkAndRecordDegraded(warned, "usage");
  checkAndRecordDegraded(warned, "history");
  clearDegraded(warned, "usage");
  assert.equal(checkAndRecordDegraded(warned, "usage"), true, "usage re-armed after recovery");
  assert.equal(checkAndRecordDegraded(warned, "history"), false, "history still suppressed");
});

// ── parseRustModels / parseRustEntries / parseRustSlashCommands ────────
// Pure deserializers for the handshake replies. Shapes mirror real rust-pi output.
test("parseRustModels: reads {models:[…]} and {provider,id} pairs", () => {
  const out = parseRustModels({ models: [
    { provider: "deepseek", id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", contextWindow: 1000000, cost: { input: 1, output: 2 } },
    { provider: "anthropic", id: "claude" },
  ] });
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], { provider: "deepseek", id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", contextWindow: 1000000, cost: { input: 1, output: 2 } });
  assert.deepEqual(out[1], { provider: "anthropic", id: "claude", name: undefined, contextWindow: undefined, cost: undefined });
});

test("parseRustModels: accepts a bare array and drops malformed entries", () => {
  const out = parseRustModels([{ provider: "x", id: "y" }, null, { provider: "z" }, { id: "w" }]);
  assert.deepEqual(out.map((m) => m.id), ["y"]);
});

test("parseRustModels: null/garbage → []", () => {
  assert.deepEqual(parseRustModels(null), []);
  assert.deepEqual(parseRustModels({}), []);
  assert.deepEqual(parseRustModels(42), []);
});

test("parseRustEntries: wraps messages and synthesizes ids when missing", () => {
  const out = parseRustEntries({ messages: [{ id: "m1", role: "user" }, { role: "assistant" }] });
  assert.deepEqual(out[0], { type: "message", message: { id: "m1", role: "user" }, id: "m1" });
  assert.equal(out[1].id, "rust-1");
});

test("parseRustEntries: bare array and null/garbage", () => {
  assert.equal(parseRustEntries([{ id: "a" }]).length, 1);
  assert.deepEqual(parseRustEntries(null), []);
  assert.deepEqual(parseRustEntries({}), []);
});

test("parseRustSlashCommands: maps names, strips leading slashes, tags source", () => {
  const out = parseRustSlashCommands({ commands: [
    { name: "tldr", description: "summarize", source: "extension" },
    { invocationName: "/foo" },
    { command: "bar", desc: "d" },
  ] });
  assert.deepEqual(out[0], { cmd: "/tldr", desc: "summarize", source: "rust (extension)" });
  assert.deepEqual(out[1], { cmd: "/foo", desc: "", source: "rust" });
  assert.equal(out[2].cmd, "/bar");
});

test("parseRustSlashCommands: skips nameless entries; null/garbage → []", () => {
  assert.deepEqual(parseRustSlashCommands({ commands: [{ description: "no name" }] }), []);
  assert.deepEqual(parseRustSlashCommands(null), []);
  assert.deepEqual(parseRustSlashCommands({ commands: "nope" }), []);
});
