// Headless tests for model-catalog.ts: thinking-capability reconcile/clamp against the bundled
// catalog, the catalog lookups, and the DeepSeek unexpressible-rates rule.
import { test } from "node:test";
import assert from "node:assert/strict";
import { getSupportedThinkingLevels, clampThinkingLevel, findCatalogThinkingModel, reconcileThinkingCapability, THINKING_LEVELS, catalogRatesAreUnexpressible, costWithheldReason } from "../../model-catalog.js";
import registry from "../../model-registry.generated.json";

// reconcileThinkingCapability: a custom models.json that omits `reasoning` must not be
// allowed to downgrade a known-reasoning model (the ~/.pi/agent/models.json deepseek-v4-pro
// bug — clamped the default level to "off" and collapsed the picker).
const DS_PROVIDERS = {
  deepseek: { models: [{ id: "deepseek-v4-pro", reasoning: true, thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: "max" } }] },
};

test("reconcile UPGRADES a registry model that omits reasoning, from the catalog (the models.json bug)", () => {
  const base = { id: "deepseek-v4-pro", provider: "deepseek", reasoning: false, baseUrl: "x" };
  const out = reconcileThinkingCapability(DS_PROVIDERS, "deepseek", "deepseek-v4-pro", base);
  assert.equal(out.reasoning, true);
  assert.deepEqual((out as { thinkingLevelMap?: unknown }).thinkingLevelMap, { minimal: null, low: null, medium: null, high: "high", xhigh: "max" });
  assert.equal((out as { baseUrl?: string }).baseUrl, "x"); // other fields preserved
  // and the default level no longer collapses to off
  assert.equal(clampThinkingLevel(out, "xhigh"), "xhigh");
});

test("reconcile leaves an already-reasoning model untouched (preserves a custom thinkingLevelMap)", () => {
  const base = { reasoning: true, thinkingLevelMap: { high: "high" } };
  const out = reconcileThinkingCapability(DS_PROVIDERS, "deepseek", "deepseek-v4-pro", base);
  assert.equal(out, base); // same reference — no clobber
});

test("reconcile respects a deliberately non-reasoning model that is ABSENT from the catalog", () => {
  const base = { id: "my-custom", reasoning: false };
  const out = reconcileThinkingCapability(DS_PROVIDERS, "acme", "my-custom", base);
  assert.equal(out.reasoning, false); // unknown model — not upgraded
});

// First-class `max`: a live `max`-keyed top tier is now surfaced AS `max`,
// not folded into `xhigh` (aliasMaxToXhigh is retired). The reconcile pass passes it through
// untouched — and returns the SAME object, since it already reasons (no clobber).
test("reconcile surfaces a live `max`-keyed top tier as first-class max, unchanged", () => {
  const live = { reasoning: true, thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" } };
  const out = reconcileThinkingCapability(DS_PROVIDERS, "deepseek", "deepseek-v4-pro", live);
  assert.equal(out, live, "an already-reasoning model is returned by identity (same-object contract)");
  assert.equal((out as any).thinkingLevelMap.xhigh, undefined, "no phantom xhigh is aliased in");
  assert.deepEqual(getSupportedThinkingLevels(out), ["off", "high", "max"], "max is offered as its own rung");
});

// ── getSupportedThinkingLevels (per-model levels from pi-ai metadata) ──
// Mirrors @earendil-works/pi-ai. DeepSeek's thinkingLevelMap collapses
// minimal/low/medium to null, so it supports off/high/xhigh only — which matches
// the wire capture (minimal/low/medium send identical {type:enabled} bodies).
test("getSupportedThinkingLevels: a non-reasoning model supports only off", () => {
  assert.deepEqual(getSupportedThinkingLevels({ reasoning: false }), ["off"]);
  assert.deepEqual(getSupportedThinkingLevels({}), ["off"]);
});

test("getSupportedThinkingLevels: a reasoning model with no map gets the full range except xhigh AND max", () => {
  // Both top rungs require an explicit mapping, so an unmapped model surfaces neither.
  assert.deepEqual(getSupportedThinkingLevels({ reasoning: true }),
    ["off", "minimal", "low", "medium", "high"]);
});

test("getSupportedThinkingLevels: max is offered only when explicitly mapped (first-class)", () => {
  const withMax = { reasoning: true, thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", max: "max" } };
  assert.deepEqual(getSupportedThinkingLevels(withMax), ["off", "high", "max"]);
  // An older catalog keys the top tier `xhigh:"max"` (no max KEY) → xhigh, never max.
  const preFix = { reasoning: true, thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: "max" } };
  assert.deepEqual(getSupportedThinkingLevels(preFix), ["off", "high", "xhigh"]);
  // A model exposing BOTH distinct rungs (e.g. Anthropic effort:"max" above xhigh) offers both.
  const both = { reasoning: true, thinkingLevelMap: { high: "high", xhigh: "xhigh", max: "max" } };
  assert.deepEqual(getSupportedThinkingLevels(both), ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
});

test("THINKING_LEVELS is the 7-rung ladder topping at max", () => {
  assert.deepEqual([...THINKING_LEVELS], ["off", "minimal", "low", "medium", "high", "xhigh", "max"]);
});

test("clampThinkingLevel: max is the top rung — a max request snaps down when unsupported", () => {
  // Model tops out at high (no xhigh/max mapping): a max request degrades to high, not off.
  const highOnly = { reasoning: true, thinkingLevelMap: { minimal: "x", low: "x", medium: "x", high: "x" } };
  assert.equal(clampThinkingLevel(highOnly, "max"), "high");
  // Model that genuinely supports max keeps it.
  const withMax = { reasoning: true, thinkingLevelMap: { high: "high", max: "max" } };
  assert.equal(clampThinkingLevel(withMax, "max"), "max");
});

test("getSupportedThinkingLevels: DeepSeek (minimal/low/medium → null) collapses to off/high/xhigh", () => {
  const deepseek = { reasoning: true, thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: "max" } };
  assert.deepEqual(getSupportedThinkingLevels(deepseek), ["off", "high", "xhigh"]);
});

test("getSupportedThinkingLevels: xhigh is offered only when explicitly mapped", () => {
  const noXhigh = { reasoning: true, thinkingLevelMap: { minimal: "x", low: "x", medium: "x", high: "x" } };
  assert.deepEqual(getSupportedThinkingLevels(noXhigh), ["off", "minimal", "low", "medium", "high"]);
});

// ── clampThinkingLevel (snap a requested level to a supported one) ──
test("clampThinkingLevel: a supported level is returned unchanged", () => {
  const deepseek = { reasoning: true, thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: "max" } };
  assert.equal(clampThinkingLevel(deepseek, "high"), "high");
  assert.equal(clampThinkingLevel(deepseek, "off"), "off");
});

test("clampThinkingLevel: an unsupported level snaps up to the next supported one", () => {
  const deepseek = { reasoning: true, thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: "max" } };
  // low/medium aren't supported → snap up to high
  assert.equal(clampThinkingLevel(deepseek, "low"), "high");
  assert.equal(clampThinkingLevel(deepseek, "medium"), "high");
  // minimal also snaps up to high
  assert.equal(clampThinkingLevel(deepseek, "minimal"), "high");
});

test("clampThinkingLevel: with nothing above, snaps down to the highest supported", () => {
  // reasoning model with only off/minimal supported; request xhigh → down to minimal
  const limited = { reasoning: true, thinkingLevelMap: { low: null, medium: null, high: null, xhigh: null } };
  assert.deepEqual(getSupportedThinkingLevels(limited), ["off", "minimal"]);
  assert.equal(clampThinkingLevel(limited, "xhigh"), "minimal");
});

test("clampThinkingLevel: a non-reasoning model clamps everything to off", () => {
  assert.equal(clampThinkingLevel({ reasoning: false }, "high"), "off");
  assert.equal(clampThinkingLevel({ reasoning: false }, "garbage"), "off");
});

// ── findCatalogThinkingModel (bundled-catalog metadata lookup) ──
const CATALOG = {
  deepseek: { models: [
    { id: "deepseek-v4-pro", reasoning: true, thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: "max" } },
    { id: "deepseek-chat", reasoning: false },
  ] },
};

test("findCatalogThinkingModel: resolves a model's reasoning + thinkingLevelMap by provider/id", () => {
  const m = findCatalogThinkingModel(CATALOG, "deepseek", "deepseek-v4-pro");
  assert.deepEqual(getSupportedThinkingLevels(m!), ["off", "high", "xhigh"]);
});

test("findCatalogThinkingModel: returns null for an unknown provider or model", () => {
  assert.equal(findCatalogThinkingModel(CATALOG, "deepseek", "nope"), null);
  assert.equal(findCatalogThinkingModel(CATALOG, "no-provider", "deepseek-v4-pro"), null);
  assert.equal(findCatalogThinkingModel(undefined, "deepseek", "deepseek-v4-pro"), null);
});

// ── unexpressible catalog rates ─────────────────────────────────────
test("native DeepSeek rates are treated as unexpressible; gateways are not", () => {
  assert.equal(catalogRatesAreUnexpressible("deepseek", "deepseek-v4-pro"), true);
  assert.equal(catalogRatesAreUnexpressible("deepseek", "deepseek-v4-flash"), true);
  assert.equal(catalogRatesAreUnexpressible("deepseek", "deepseek-v4-flash-vision-exp"), true);
  // The clock is DeepSeek's. A gateway resells under its own provider id at its own flat rate,
  // which the catalog CAN express — suppressing those would hide costs we actually know.
  assert.equal(catalogRatesAreUnexpressible("openrouter", "deepseek-v4-pro"), false);
  assert.equal(catalogRatesAreUnexpressible("vercel-ai-gateway", "deepseek-v4-pro"), false);
  assert.equal(catalogRatesAreUnexpressible(undefined, undefined), false);
});

test("no DeepSeek model id escapes the rule, whatever upstream renames it to", () => {
  // The rule keys on the provider alone BECAUSE it once keyed on /^deepseek-v4/: pi-ai 0.86.1
  // renamed deepseek-v4-flash to deepseek-flash, which fell out of that pattern and put a
  // confidently wrong number back on screen with nothing to notice it by. Every id the native
  // provider carries must be covered, and so must any id it is renamed to next.
  for (const id of ["deepseek-flash", "deepseek-chat", "deepseek-reasoner", "deepseek-v5", "anything"]) {
    assert.equal(catalogRatesAreUnexpressible("deepseek", id), true, `${id} must be withheld`);
  }
  // Pin it against the catalog we actually ship, so a future rename cannot quietly re-open a gap.
  for (const m of (registry.providers as Record<string, { models: Array<{ id: string }> }>)["deepseek"].models) {
    assert.equal(catalogRatesAreUnexpressible("deepseek", m.id), true, `bundled ${m.id} must be withheld`);
  }
});

test("the withheld reason is present exactly when the rates are withheld", () => {
  assert.ok((costWithheldReason("deepseek", "deepseek-v4-pro") ?? "").includes("time of day"));
  assert.equal(costWithheldReason("openrouter", "deepseek-v4-pro"), null);
});
