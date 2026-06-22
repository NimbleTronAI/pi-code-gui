// Headless unit tests for the pure Rust-event helpers (no vscode dependency).
// Run with `pnpm run test:unit`. Shapes mirror real rust-pi 0.1.18 RPC output.
import { test } from "node:test";
import assert from "node:assert/strict";
import { normalizeRustEvent, dropQueuedMessage, shouldEmitToolPreview, shouldEmitToolPreviewUpdate, TOOL_PREVIEW_THROTTLE_MS, shouldWarnDegraded, clearDegraded } from "../../rust-events.js";

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

// ── shouldWarnDegraded / clearDegraded (capability-warning dedupe) ─────
test("shouldWarnDegraded: warns on the first failure, stays silent after", () => {
  const warned = new Set<string>();
  assert.equal(shouldWarnDegraded(warned, "models"), true);
  assert.equal(shouldWarnDegraded(warned, "models"), false);
  assert.equal(shouldWarnDegraded(warned, "models"), false);
});

test("shouldWarnDegraded: tracks each capability independently", () => {
  const warned = new Set<string>();
  assert.equal(shouldWarnDegraded(warned, "models"), true);
  assert.equal(shouldWarnDegraded(warned, "history"), true);
  assert.equal(shouldWarnDegraded(warned, "models"), false);
});

test("clearDegraded: recovery re-arms the warning for that capability only", () => {
  const warned = new Set<string>();
  shouldWarnDegraded(warned, "usage");
  shouldWarnDegraded(warned, "history");
  clearDegraded(warned, "usage");
  assert.equal(shouldWarnDegraded(warned, "usage"), true, "usage re-armed after recovery");
  assert.equal(shouldWarnDegraded(warned, "history"), false, "history still suppressed");
});
