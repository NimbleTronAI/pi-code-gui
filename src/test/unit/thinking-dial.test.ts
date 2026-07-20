// Headless tests for the extracted Thinking/Reasoning dial (src/thinking-dial.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { composeThinkingStatus, pickDefaultReasoningLevel, toggleThinkingTarget, buildThinkingPickerRows, REASONING_DESCR } from "../../thinking-dial.js";

type Any = ReturnType<typeof JSON.parse>;
const STAR = "★";
const CHECK = "$(check)";

test("composeThinkingStatus: not live → read-only reasoning badge", () => {
  assert.deepEqual(composeThinkingStatus({ live: false, reasoningOn: true, level: "high" }), { text: "reasoning: on", clickable: false });
  assert.deepEqual(composeThinkingStatus({ live: false, reasoningOn: false, level: "off" }), { text: "reasoning: off", clickable: false });
});

test("composeThinkingStatus: live + off → clickable 'thinking: off'", () => {
  assert.deepEqual(composeThinkingStatus({ live: true, reasoningOn: false, level: "off" }), { text: "thinking: off", clickable: true });
});

test("composeThinkingStatus: live + a level → 'thinking: on · reasoning: <level>', clickable", () => {
  assert.deepEqual(composeThinkingStatus({ live: true, reasoningOn: true, level: "xhigh" }), { text: "thinking: on · reasoning: xhigh", clickable: true });
});

test("pickDefaultReasoningLevel: restores the last level when still supported", () => {
  assert.equal(pickDefaultReasoningLevel(["off", "low", "medium", "high"], "medium"), "medium");
});

test("pickDefaultReasoningLevel: last unsupported → highest supported on-level", () => {
  assert.equal(pickDefaultReasoningLevel(["off", "high", "xhigh"], "low"), "xhigh"); // DeepSeek-style collapse
  assert.equal(pickDefaultReasoningLevel(["off", "high", "xhigh"], undefined), "xhigh");
});

test("pickDefaultReasoningLevel: no on-levels → 'high' fallback", () => {
  assert.equal(pickDefaultReasoningLevel(["off"], undefined), "high");
});

test("toggleThinkingTarget: off → restore level; anything on → off", () => {
  assert.equal(toggleThinkingTarget("off", "high"), "high");
  assert.equal(toggleThinkingTarget("medium", "high"), "off");
});

test("buildThinkingPickerRows: Off + separator + on-levels, active check + default star", () => {
  const rows = buildThinkingPickerRows(["low", "high"], "low", "high");
  // [Off, sep, low, high]
  assert.equal(rows.length, 4);
  assert.equal((rows[0] as Any).level, "off");
  assert.equal(rows[1].separator, true);
  assert.equal((rows[1] as Any).label, "Reasoning level");
  const low = rows.find((r) => !r.separator && (r as Any).level === "low") as Any;
  const high = rows.find((r) => !r.separator && (r as Any).level === "high") as Any;
  assert.ok(low.label.includes(CHECK));   // low is current
  assert.ok(!low.label.includes(STAR));
  assert.ok(high.label.includes(STAR));   // high is default
  assert.equal(high.isDefault, true);
  assert.equal(low.description, REASONING_DESCR.low);
});

test("buildThinkingPickerRows: Off marked default when defLevel is off", () => {
  const rows = buildThinkingPickerRows(["high"], "off", "off");
  const off = rows[0] as Any;
  assert.equal(off.isDefault, true);
  assert.ok(off.label.includes(CHECK) && off.label.includes(STAR));
});

test("buildThinkingPickerRows: unknown level gets the generic 'reasoning' description", () => {
  const rows = buildThinkingPickerRows(["exotic"], "off", "off");
  const exotic = rows.find((r) => !r.separator && (r as Any).level === "exotic") as Any;
  assert.equal(exotic.description, "reasoning");
});
