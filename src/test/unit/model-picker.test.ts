// Headless tests for the extracted model picker core (src/model-picker.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { FALLBACK_MODELS, formatModelDetail, toModelChoices, buildModelPickerItems, mapScopedModels } from "../../model-picker.js";

type Any = ReturnType<typeof JSON.parse>;
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

test("mapScopedModels: drops null-model entries, defaults thinkingLevel to off", () => {
  const out = mapScopedModels([
    { model: { provider: "anthropic", id: "a" }, thinkingLevel: "high" },
    { model: null, thinkingLevel: "low" },      // dropped
    { model: { provider: "openai", id: "b" } },  // no level → "off"
  ] as Any);
  assert.deepEqual(out, [
    { provider: "anthropic", id: "a", thinkingLevel: "high" },
    { provider: "openai", id: "b", thinkingLevel: "off" },
  ]);
  assert.deepEqual(mapScopedModels(undefined as Any), []);
});
