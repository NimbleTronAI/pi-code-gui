// Tests for scripts/registry-diff.mjs — the pricing review that goes into an automated pi-ai PR.
// Run by `pnpm run test:unit` (node:test, alongside the compiled out/test/unit suite).
import { test } from "node:test";
import assert from "node:assert/strict";
import { diffRegistries, renderRegistryDiff } from "../registry-diff.mjs";

const cost = (input, output, cacheRead = 0, cacheWrite = 0) => ({ input, output, cacheRead, cacheWrite });
const reg = (version, providers) => ({ generatedFrom: "@earendil-works/pi-ai", piAiVersion: version, modelDataGeneratedAt: "2026-11-10T00:00:00.000Z", providers });
const prov = (models, baseUrl = "https://x", api = "openai-completions") => ({ baseUrl, api, models });
const model = (id, c, extra = {}) => ({ id, name: id, reasoning: false, contextWindow: 1000, maxTokens: 100, input: ["text"], cost: c, ...extra });

test("an identical registry reports no change at all", () => {
  const r = reg("1.0.0", { p: prov([model("a", cost(1, 2))]) });
  const d = diffRegistries(r, structuredClone(r));
  assert.deepEqual([d.models.added, d.models.removed, d.repriced, d.providers.added, d.providers.removed, d.providers.connectionChanged], [[], [], [], [], [], []]);
  assert.deepEqual(d.otherChanges, {});
});

test("added and removed models are keyed provider/id, so the same id under two providers stays distinct", () => {
  const a = reg("1.0.0", { p: prov([model("a", cost(1, 2))]), q: prov([model("a", cost(1, 2))]) });
  const b = reg("1.1.0", { p: prov([model("a", cost(1, 2)), model("b", cost(1, 2))]) });
  const d = diffRegistries(a, b);
  assert.deepEqual(d.models.added, ["p/b"]);
  assert.deepEqual(d.models.removed, ["q/a"]);
  assert.deepEqual(d.providers.removed, ["q"]);
  assert.equal(d.from.version, "1.0.0");
  assert.equal(d.to.version, "1.1.0");
});

test("a provider whose endpoint moved is reported, since requests now go somewhere else", () => {
  const a = reg("1", { p: prov([model("a", cost(1, 2))], "https://old") });
  const b = reg("2", { p: prov([model("a", cost(1, 2))], "https://new") });
  assert.deepEqual(diffRegistries(a, b).providers.connectionChanged, [{ provider: "p", from: "https://old openai-completions", to: "https://new openai-completions" }]);
});

test("a price move is reported with its largest factor, and a 5x move is flagged", () => {
  const a = reg("1", { p: prov([model("cheap", cost(1, 2)), model("big", cost(1, 2))]) });
  const b = reg("2", { p: prov([model("cheap", cost(1.1, 2)), model("big", cost(5, 2))]) });
  const d = diffRegistries(a, b);
  assert.equal(d.repriced.length, 2);
  assert.equal(d.repriced[0].key, "p/big", "largest move sorts first");
  assert.equal(d.repriced[0].factor, 5);
  assert.equal(d.repriced[0].flag, true);
  assert.equal(d.repriced[1].flag, false, "a 10% move is listed but not flagged");
});

test("a price cut is measured the same way as a rise (halving is a 2x move)", () => {
  const a = reg("1", { p: prov([model("m", cost(4, 8))]) });
  const b = reg("2", { p: prov([model("m", cost(2, 8))]) });
  const [r] = diffRegistries(a, b).repriced;
  assert.equal(r.factor, 2);
  assert.equal(r.flag, true);
});

test("a model going from free to priced, or priced to free, is flagged even though no ratio exists", () => {
  const a = reg("1", { p: prov([model("was-free", cost(0, 0)), model("now-free", cost(1, 1))]) });
  const b = reg("2", { p: prov([model("was-free", cost(1, 1)), model("now-free", cost(0, 0))]) });
  const d = diffRegistries(a, b);
  assert.equal(d.repriced.length, 2);
  for (const r of d.repriced) { assert.equal(r.factor, Infinity); assert.equal(r.flag, true); }
});

test("a cache price appearing for the first time is listed but NOT flagged (it is not a headline rate)", () => {
  // Seen for real in the pi-ai 1.3.0 → 1.5.2 refresh: dozens of models gained a cacheRead price,
  // and flagging each one buried the moves that actually change what a turn costs.
  const a = reg("1", { p: prov([model("m", cost(1, 2, 0, 0))]) });
  const b = reg("2", { p: prov([model("m", cost(1, 2, 0.1, 0))]) });
  const [r] = diffRegistries(a, b).repriced;
  assert.equal(r.flag, false);
  assert.equal(r.factor, 1);
});

test("a cache price that moves between two non-zero values still counts toward the factor", () => {
  const a = reg("1", { p: prov([model("m", cost(1, 2, 0.1, 0))]) });
  const b = reg("2", { p: prov([model("m", cost(1, 2, 0.5, 0))]) });
  const [r] = diffRegistries(a, b).repriced;
  assert.equal(r.factor, 5);
  assert.equal(r.flag, true);
});

test("non-price field changes are counted by field, not listed", () => {
  const a = reg("1", { p: prov([model("m", cost(1, 1), { contextWindow: 1000 })]) });
  const b = reg("2", { p: prov([model("m", cost(1, 1), { contextWindow: 2000 })]) });
  assert.deepEqual(diffRegistries(a, b).otherChanges, { contextWindow: 1 });
});

test("the markdown names both versions, leads with the flagged count, and caps long lists", () => {
  const many = Array.from({ length: 30 }, (_, i) => model(`m${i}`, cost(1, 1)));
  const a = reg("1.5.2", { p: prov([model("x", cost(1, 1))]) });
  const b = reg("1.6.0", { p: prov([model("x", cost(10, 1)), ...many]) });
  const md = renderRegistryDiff(diffRegistries(a, b), { listLimit: 10 });
  assert.match(md, /1\.5\.2.*1\.6\.0/);
  assert.match(md, /1 price move of 2x or more/);
  assert.match(md, /and 20 more/);
  assert.match(md, /\| p\/x \|/);
});

test("the markdown says so plainly when no price moved", () => {
  const r = reg("1", { p: prov([model("a", cost(1, 2))]) });
  assert.match(renderRegistryDiff(diffRegistries(r, structuredClone(r))), /No price changed/);
});
