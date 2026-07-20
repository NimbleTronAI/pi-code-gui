// Headless tests for the extracted session replay (src/session-replay.ts) — the reload/resume
// path that re-emits a stored session. Previously this whole ~110-line block lived untested
// inside PiService.sendInitialMessages.
import { test } from "node:test";
import assert from "node:assert/strict";
import { replaySessionEntries, indexEntries, extractThinking, toTimestamp } from "../../session-replay.js";

type Any = ReturnType<typeof JSON.parse>;
const NOW = 1_700_000_000_000;
const flat = (r: { groups: Any[][] }): Any[] => r.groups.flat();
const types = (r: { groups: Any[][] }): string[] => flat(r).map((e) => e.type);

test("empty / missing entries → no groups, no user messages", () => {
  assert.deepEqual(replaySessionEntries([], { now: NOW }), { groups: [], userMessages: [] });
  assert.deepEqual(replaySessionEntries(undefined as Any, { now: NOW }), { groups: [], userMessages: [] });
});

test("user message → chat-message + tracked in userMessages", () => {
  const r = replaySessionEntries(
    [{ id: "e1", type: "message", message: { id: "m1", role: "user", content: "hello", timestamp: 5 } }],
    { now: NOW },
  );
  assert.deepEqual(types(r), ["chat-message"]);
  assert.deepEqual(flat(r)[0].data, { role: "user", content: "hello", entryId: "e1" });
  assert.deepEqual(r.userMessages, [{ id: "m1", text: "hello", timestamp: 5 }]);
});

test("empty user text → no event and not tracked", () => {
  const r = replaySessionEntries([{ id: "e1", type: "message", message: { role: "user", content: "" } }], { now: NOW });
  assert.deepEqual(r.groups, [[]]); // a group per entry, but empty
  assert.deepEqual(r.userMessages, []);
});

test("user message without id → falls back to user-<now>", () => {
  const r = replaySessionEntries([{ id: "e1", type: "message", message: { role: "user", content: "hi" } }], { now: NOW });
  assert.equal(r.userMessages[0].id, `user-${NOW}`);
});

test("assistant with thinking + text → start, thinking (delta + done), stream-delta, end", () => {
  const r = replaySessionEntries(
    [{ id: "e1", type: "message", message: { id: "a1", role: "assistant", stopReason: "end_turn",
       content: [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "answer" }] } }],
    { now: NOW },
  );
  assert.deepEqual(types(r), ["assistant-start", "thinking-delta", "thinking-delta", "stream-delta", "assistant-end"]);
  const ev = flat(r);
  assert.deepEqual(ev[1].data, { delta: "hmm" });
  assert.deepEqual(ev[2].data, { delta: "", done: true });
  assert.equal(ev[3].data.delta, "answer");
  assert.equal(ev[4].data.stopReason, "end_turn");
  assert.deepEqual(ev[4].data.toolCalls, []);
});

test("assistant tool-only message still emits (start + end, no stream-delta)", () => {
  const r = replaySessionEntries(
    [{ id: "e1", type: "message", message: { id: "a1", role: "assistant",
       content: [{ type: "toolCall", id: "tc1", name: "read", arguments: { path: "x" } }] } }],
    { now: NOW },
  );
  assert.deepEqual(types(r), ["assistant-start", "assistant-end", "tool-start", "tool-end"]);
  assert.equal(flat(r)[1].data.toolCalls[0], "tc1");
});

test("tool call with a matching toolResult entry → tool-end carries the real result", () => {
  const r = replaySessionEntries(
    [
      { id: "e1", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "read", arguments: {} }] } },
      { id: "e2", type: "message", message: { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "file body" }] } },
    ],
    { now: NOW },
  );
  const end = flat(r).find((e) => e.type === "tool-end");
  assert.equal(end.data.result.content[0].text, "file body");
  assert.equal(end.data.entryId, "e2");
});

test("tool call with no result → tool-end falls back to a (completed) stub", () => {
  const r = replaySessionEntries(
    [{ id: "e1", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "read", arguments: {} }] } }],
    { now: NOW },
  );
  const end = flat(r).find((e) => e.type === "tool-end");
  assert.equal(end.data.result.content[0].text, "(completed)");
});

test("bash/exec tool call → bash-start + bash-end (not tool cards), output from the result", () => {
  const r = replaySessionEntries(
    [
      { id: "e1", type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "tc1", name: "bash", arguments: { command: "ls" } }] } },
      { id: "e2", type: "message", message: { role: "toolResult", toolCallId: "tc1", content: [{ type: "text", text: "a\nb" }] } },
    ],
    { now: NOW },
  );
  const t = types(r);
  assert.ok(t.includes("bash-start") && t.includes("bash-end"));
  assert.ok(!t.includes("tool-start"));
  const end = flat(r).find((e) => e.type === "bash-end");
  assert.equal(end.data.command, "ls");
  assert.equal(end.data.output, "a\nb");
});

test("bashExecution message → bash-start + bash-end with exit code / error flag", () => {
  const r = replaySessionEntries(
    [{ id: "e1", type: "message", message: { role: "bashExecution", command: "false", exitCode: 1, cancelled: false, output: "" } }],
    { now: NOW },
  );
  assert.deepEqual(types(r), ["bash-start", "bash-end"]);
  assert.equal(flat(r).find((e) => e.type === "bash-end").data.isError, true);
});

test("custom message + compaction entry map through", () => {
  const r = replaySessionEntries(
    [
      { id: "e1", type: "message", message: { role: "custom", customType: "note", content: "c", display: "d", details: {}, timestamp: 9 } },
      { id: "e2", type: "compaction", summary: "s", tokensBefore: 42, timestamp: 7 },
    ],
    { now: NOW },
  );
  assert.deepEqual(types(r), ["custom-message", "compaction-summary-message"]);
  const comp = flat(r).find((e) => e.type === "compaction-summary-message");
  assert.deepEqual({ summary: comp.data.summary, tokensBefore: comp.data.tokensBefore, timestamp: comp.data.timestamp }, { summary: "s", tokensBefore: 42, timestamp: 7 });
});

test("one group per entry, preserving order (paint boundaries)", () => {
  const r = replaySessionEntries(
    [
      { id: "e1", type: "message", message: { role: "user", content: "q" } },
      { id: "e2", type: "message", message: { role: "assistant", content: [{ type: "text", text: "a" }] } },
    ],
    { now: NOW },
  );
  assert.equal(r.groups.length, 2);
  assert.deepEqual(r.groups[0].map((e) => e.type), ["chat-message"]);
  assert.deepEqual(r.groups[1].map((e) => e.type), ["assistant-start", "stream-delta", "assistant-end"]);
});

test("user history cap is the shell's job — replay returns every user message in order", () => {
  const entries = Array.from({ length: 60 }, (_, i) => ({ id: `e${i}`, type: "message", message: { id: `m${i}`, role: "user", content: `msg${i}` } }));
  const r = replaySessionEntries(entries, { now: NOW });
  assert.equal(r.userMessages.length, 60);
  assert.equal(r.userMessages[0].text, "msg0");
  assert.equal(r.userMessages[59].text, "msg59");
});

test("indexEntries: by message id and by tool-call id", () => {
  const entries = [
    { id: "e1", type: "message", message: { id: "m1", role: "assistant", content: [] } },
    { id: "e2", type: "message", message: { role: "toolResult", toolCallId: "tc1", content: [] } },
    { id: "e3", type: "compaction" },
  ];
  const idx = indexEntries(entries);
  assert.equal(idx.entries.length, 3);
  assert.equal(idx.byMessageId.get("m1").id, "e1");
  assert.equal(idx.byToolCallId.get("tc1").id, "e2");
});

test("extractThinking: joins thinking blocks; ignores non-arrays", () => {
  assert.equal(extractThinking([{ type: "thinking", thinking: "a" }, { type: "text", text: "x" }, { type: "thinking", thinking: "b" }]), "a\nb");
  assert.equal(extractThinking("plain"), "");
  assert.equal(extractThinking(null), "");
});

test("toTimestamp: number passthrough, ISO parse, now fallback", () => {
  assert.equal(toTimestamp(1234, NOW), 1234);
  assert.equal(toTimestamp("2023-01-01T00:00:00Z", NOW), Date.parse("2023-01-01T00:00:00Z"));
  assert.equal(toTimestamp(undefined, NOW), NOW);
});
