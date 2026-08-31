// Headless tests for the extracted model picker core (src/model-picker.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { FALLBACK_MODELS, formatModelDetail, toModelChoices, buildModelPickerItems, buildDefaultChoiceItems } from "../../model-picker.js";

const STAR = "★";
const CHECK = "$(check)";

test("formatModelDetail: pricing + context, either alone, or empty", () => {
  assert.equal(formatModelDetail({ input: 3, output: 15 }, 200_000), "$3/$15 per M tokens · 200K context");
  assert.equal(formatModelDetail({ input: 1, output: 2 }, undefined), "$1/$2 per M tokens");
  assert.equal(formatModelDetail(undefined, 128_000), "128K context");
  assert.equal(formatModelDetail(undefined, undefined), "");
});

test("toModelChoices: name falls back to id, carries cost + context", () => {
  const out = toModelChoices([
    { provider: "anthropic", id: "claude-x", name: "Claude X", cost: { input: 3, output: 15 }, contextWindow: 200_000 },
    { provider: "openai", id: "gpt-x" }, // no name → id
  ]);
  assert.deepEqual(out[0], { label: "Claude X", provider: "anthropic", modelId: "claude-x", cost: { input: 3, output: 15 }, contextWindow: 200_000 });
  assert.equal(out[1].label, "gpt-x");
});

test("buildModelPickerItems: marks active with a check and the saved default with a star", () => {
  const models = toModelChoices([
    { provider: "anthropic", id: "a", name: "Model A" },
    { provider: "openai", id: "b", name: "Model B" },
  ]);
  const items = buildModelPickerItems(models, "a", { provider: "openai", id: "b" });
  assert.ok(items[0].label.includes(CHECK)); // a is active
  assert.ok(!items[0].label.includes(STAR));
  assert.equal(items[0].isDefault, false);
  assert.ok(items[1].label.includes(STAR)); // b is default
  assert.ok(!items[1].label.includes(CHECK));
  assert.equal(items[1].isDefault, true);
  assert.equal(items[0].description, "anthropic"); // provider in description
});

test("buildModelPickerItems: active AND default gets both marks", () => {
  const models = toModelChoices([{ provider: "p", id: "x", name: "X" }]);
  const item = buildModelPickerItems(models, "x", { provider: "p", id: "x" })[0];
  assert.ok(item.label.includes(CHECK) && item.label.includes(STAR));
  assert.equal(item.isDefault, true);
});

test("buildModelPickerItems: no default (null) → no stars, nothing isDefault", () => {
  const models = toModelChoices([{ provider: "p", id: "x", name: "X" }]);
  const item = buildModelPickerItems(models, undefined, null)[0];
  assert.ok(!item.label.includes(STAR) && !item.label.includes(CHECK));
  assert.equal(item.isDefault, false);
});

test("FALLBACK_MODELS is a non-empty static list with no pricing", () => {
  assert.ok(FALLBACK_MODELS.length >= 4);
  assert.ok(FALLBACK_MODELS.every((m) => m.provider && m.modelId && m.cost === undefined));
});


test("formatModelDetail: all-zero rates omit the pricing clause (no '$0/$0 per M tokens')", () => {
  // Same call the status chip makes: 0/0 is the catalog declining to state a price, so asserting
  // "free" in the picker would mislead subscription-provider users the same way $0.00 would.
  assert.equal(formatModelDetail({ input: 0, output: 0 }, 128_000), "128K context");
  assert.equal(formatModelDetail({ input: 0, output: 0 }, undefined), "");
  // A real rate on either side is still worth showing.
  assert.equal(formatModelDetail({ input: 0, output: 2 }, undefined), "$0/$2 per M tokens");
});

// ── the "save as default?" step ─────────────────────────────────────
// This used to be a ONE-item QuickPick, so declining meant dismissing it — an invisible
// affordance. Both answers are rows now, and each names its consequence.

test("buildDefaultChoiceItems: declining is a visible row, not a dismissal", () => {
  const items = buildDefaultChoiceItems("deepseek-v4-pro", "deepseek-v4-flash");
  assert.equal(items.length, 2);
  assert.equal(items[0].save, true);
  assert.equal(items[1].save, false, "the second row is the explicit no");
});

test("buildDefaultChoiceItems: both rows name what they would do", () => {
  const [save, keep] = buildDefaultChoiceItems("yolo", "always-ask");
  assert.match(save.label, /yolo/, "says what would become the default");
  assert.match(keep.label, /always-ask/, "says what would be kept — not just \"No\"");
  assert.match(keep.description, /this session/i);
});

test("buildDefaultChoiceItems: with no default set, the decline row says so", () => {
  const [, keep] = buildDefaultChoiceItems("deepseek-v4-pro", null);
  assert.match(keep.label, /Don't set a default/);
  assert.equal(keep.save, false);
});
