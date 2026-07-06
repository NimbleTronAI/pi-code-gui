// Headless tests for the catalog maxTokens resolver (rust-catalog.ts). rust-pi
// 0.1.20 forwards a model's maxTokens to the provider verbatim, so the bundled
// registry's placeholder values (a copy of contextWindow) must be OMITTED — not
// sent — while genuine sub-window limits are kept. Boundaries are anchored on a
// verified-live finding: deepseek rejects max_tokens outside [1, 393216] with an
// HTTP 400 (silent empty turn), accepts deepseek-v4-pro's 384000, and completes
// normally when the field is omitted entirely.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveMaxOutputTokens, thinkingLevelIsLive, getSupportedThinkingLevels, clampThinkingLevel, findCatalogThinkingModel, reconcileThinkingCapability, computeTokenCost, buildThinkingCompat } from "../../rust-catalog.js";

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

test("computeTokenCost: tokens × per-million rates, summed (matches pi-ai calculateCost)", () => {
  const rates = { input: 0.435, output: 0.87, cacheRead: 0.003625, cacheWrite: 0 };
  // 1000 input + 500 output → 1000/1e6*0.435 + 500/1e6*0.87 = 0.000435 + 0.000435
  assert.equal(computeTokenCost({ input: 1000, output: 500 }, rates), 0.00087);
  assert.equal(computeTokenCost({}, rates), 0); // no tokens → $0
  assert.equal(computeTokenCost({ input: 1_000_000 }, rates), 0.435); // 1M input = the input rate
});

test("buildThinkingCompat nests Anthropic forceAdaptiveThinking under compat", () => {
  assert.deepEqual(
    buildThinkingCompat({ thinkingLevelMap: { xhigh: "xhigh" }, compat: { forceAdaptiveThinking: true } }),
    { compat: { thinkingLevelMap: { xhigh: "xhigh" }, forceAdaptiveThinking: true } },
  );
});

test("buildThinkingCompat filters null thinkingLevelMap entries (HashMap<String,String> rejects null)", () => {
  // DeepSeek collapses minimal/low/medium → null; only string mappings survive.
  assert.deepEqual(
    buildThinkingCompat({ thinkingLevelMap: { minimal: null, low: null, medium: null, high: "high", xhigh: "max" }, compat: { thinkingFormat: "deepseek" } }),
    { compat: { thinkingLevelMap: { high: "high", xhigh: "max" }, thinkingFormat: "deepseek" } },
  );
});

test("buildThinkingCompat omits the compat key entirely for a model with no thinking metadata", () => {
  assert.deepEqual(buildThinkingCompat({}), {});
  // A map of only-null entries collapses to no map → no compat key.
  assert.deepEqual(buildThinkingCompat({ thinkingLevelMap: { low: null, medium: null } }), {});
});

test("buildThinkingCompat preserves forceAdaptiveThinking:false (authoritative legacy signal)", () => {
  assert.deepEqual(
    buildThinkingCompat({ compat: { forceAdaptiveThinking: false } }),
    { compat: { forceAdaptiveThinking: false } },
  );
});

test("a real limit below the context window is kept verbatim", () => {
  assert.equal(resolveMaxOutputTokens(8192, 200000), 8192);
  assert.equal(resolveMaxOutputTokens(32768, 1047576), 32768);
});

test("deepseek-v4-pro 384,000 (< its 1,000,000 window) is kept, not omitted", () => {
  assert.equal(resolveMaxOutputTokens(384000, 1000000), 384000);
});

test("a large but deliberate sub-window value is trusted (genuine capacity preserved)", () => {
  assert.equal(resolveMaxOutputTokens(500000, 1000000), 500000);
  assert.equal(resolveMaxOutputTokens(262143, 262144), 262143);
});

test("a placeholder (maxTokens == contextWindow) is omitted → provider default applies", () => {
  assert.equal(resolveMaxOutputTokens(2000000, 2000000), undefined); // grok
  assert.equal(resolveMaxOutputTokens(262144, 262144), undefined);   // kimi
  assert.equal(resolveMaxOutputTokens(8192, 8192), undefined);       // any model where they're equal
});

test("a value above the context window is also omitted", () => {
  assert.equal(resolveMaxOutputTokens(4096, 4095), undefined);
});

test("garbage / non-positive maxTokens is omitted (provider default keeps the model callable)", () => {
  assert.equal(resolveMaxOutputTokens(0, 200000), undefined);
  assert.equal(resolveMaxOutputTokens(-5, 200000), undefined);
  assert.equal(resolveMaxOutputTokens(NaN, 200000), undefined);
  assert.equal(resolveMaxOutputTokens(Infinity, 200000), undefined);
});

test("a real value is kept even when the context window is missing/zero (can't judge a placeholder)", () => {
  assert.equal(resolveMaxOutputTokens(8192, 0), 8192);
  assert.equal(resolveMaxOutputTokens(8192, NaN), 8192);
});

test("fractional input is floored to an integer", () => {
  assert.equal(resolveMaxOutputTokens(8192.9, 200000), 8192);
});

test("a kept value is always a positive integer", () => {
  for (const [mt, cw] of [[5, 100], [8192.9, 200000], [1, 2]] as Array<[number, number]>) {
    const out = resolveMaxOutputTokens(mt, cw);
    assert.ok(out !== undefined && Number.isInteger(out) && out >= 1, `expected positive int, got ${out} for (${mt}, ${cw})`);
  }
});

// ── thinkingLevelIsLive (which transports actually transmit the thinking level) ──
test("thinkingLevelIsLive: true for transports that serialize a reasoning field", () => {
  assert.equal(thinkingLevelIsLive("anthropic-messages"), true);
  assert.equal(thinkingLevelIsLive("openai-responses"), true);
  assert.equal(thinkingLevelIsLive("google-generative-ai"), true);
});

test("thinkingLevelIsLive: true for openai-completions (DeepSeek) — pi_agent_rust 6c5f43b3 transmits thinking:{type} + reasoning_effort; verified live against the DeepSeek API", () => {
  assert.equal(thinkingLevelIsLive("openai-completions"), true);
});

test("thinkingLevelIsLive: fails safe to false for unknown/unverified and empty transports", () => {
  assert.equal(thinkingLevelIsLive("mistral-conversations"), false);
  assert.equal(thinkingLevelIsLive("totally-new-api"), false);
  assert.equal(thinkingLevelIsLive(""), false);
  assert.equal(thinkingLevelIsLive(undefined), false);
  assert.equal(thinkingLevelIsLive(null), false);
});

// ── getSupportedThinkingLevels (per-model levels from pi-ai metadata) ──
// Mirrors @earendil-works/pi-ai. DeepSeek's thinkingLevelMap collapses
// minimal/low/medium to null, so it supports off/high/xhigh only — which matches
// the wire capture (minimal/low/medium send identical {type:enabled} bodies).
test("getSupportedThinkingLevels: a non-reasoning model supports only off", () => {
  assert.deepEqual(getSupportedThinkingLevels({ reasoning: false }), ["off"]);
  assert.deepEqual(getSupportedThinkingLevels({}), ["off"]);
});

test("getSupportedThinkingLevels: a reasoning model with no map gets the full range except xhigh", () => {
  assert.deepEqual(getSupportedThinkingLevels({ reasoning: true }),
    ["off", "minimal", "low", "medium", "high"]);
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

// ── findCatalogThinkingModel (Rust-path metadata lookup, no SDK registry) ──
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
