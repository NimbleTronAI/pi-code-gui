// Headless tests for the extracted usage/cost policy (src/usage-stats.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeUsageStats, type RawUsage, type CostRates } from "../../usage-stats.js";

const RATES: CostRates = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const usage = (over: Partial<RawUsage> = {}): RawUsage => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextPercent: null, contextWindow: 0, ...over,
});

test("sdk: keeps the SDK-computed cost; costKnown true when cost > 0", () => {
  const s = computeUsageStats(usage({ cost: 0.42 }), null);
  assert.equal(s.cost, 0.42);
  assert.equal(s.costKnown, true);
});

test("sdk: zero cost but rates present → costKnown true ($0.00, not $??)", () => {
  const s = computeUsageStats(usage({ cost: 0 }), RATES);
  assert.equal(s.cost, 0);
  assert.equal(s.costKnown, true);
});

test("sdk: zero cost and no rates → costKnown false ($??)", () => {
  const s = computeUsageStats(usage({ cost: 0 }), null);
  assert.equal(s.costKnown, false);
});

test("passes token counts and context through unchanged", () => {
  const u = usage({ input: 10, output: 20, cacheRead: 5, cacheWrite: 2, contextPercent: 42, contextWindow: 200_000 });
  const s = computeUsageStats(u, RATES);
  assert.deepEqual(
    { input: s.input, output: s.output, cacheRead: s.cacheRead, cacheWrite: s.cacheWrite, contextPercent: s.contextPercent, contextWindow: s.contextWindow },
    { input: 10, output: 20, cacheRead: 5, cacheWrite: 2, contextPercent: 42, contextWindow: 200_000 },
  );
});

// ── all-zero rates mean "no price stated", not "free" ─────────────────
// 99 of the 854 bundled models sit at 0/0, mixing genuinely-free models with whole
// subscription providers (qwen-token-plan, xiaomi-token-plan-*, zai, kimi-coding) that have no
// per-token price because a plan was bought up front. pi-ai gives no flag to separate them, so
// we decline to assert $0.00 and let the user apply their own model.
const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const PAID = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
const USED = { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0, contextPercent: null, contextWindow: 200_000 };

test("all-zero rates and no SDK cost → $??", () => {
  assert.equal(computeUsageStats(USED, ZERO).costKnown, false);
});

test("an SDK-COMPUTED cost wins over zero rates (a measurement, not an inference)", () => {
  const s = computeUsageStats({ ...USED, cost: 0.02 }, ZERO);
  assert.equal(s.costKnown, true);
  assert.equal(s.cost, 0.02);
});

test("a rates-bearing model with no turns yet still shows $0.00, not $??", () => {
  const idle = { ...USED, input: 0, output: 0 };
  assert.equal(computeUsageStats(idle, PAID).costKnown, true);
});

test("cache-only rates can't price a turn → still $??", () => {
  const cacheOnly = { input: 0, output: 0, cacheRead: 0.5, cacheWrite: 6.25 };
  assert.equal(computeUsageStats(USED, cacheOnly).costKnown, false);
});

test("negative sentinel rates render $?? — never a negative cost", () => {
  // openrouter/auto and openrouter/auto-beta ship input/output of -1000000: pi-ai's way of
  // saying "pricing varies", since an auto-router picks an arbitrary downstream model. The
  // previous `rates !== null` test accepted them, and tokens x negative rates put a NEGATIVE
  // figure in the status bar (-$1500 after 1500 tokens, measured).
  const sentinel = { input: -1_000_000, output: -1_000_000, cacheRead: -1_000_000, cacheWrite: -1_000_000 };
  const s = computeUsageStats(USED, sentinel);
  assert.equal(s.costKnown, false, "unpriceable");
  assert.ok(s.cost >= 0, "cost must never go negative");
});

// ── withheld cost: a price the catalog cannot express ────────────────
// Native DeepSeek V4 bills on a clock (peak 2x off-peak) and the catalog holds one flat scalar —
// which cannot be right at both ends of the clock. DeepSeek reports no cost of its own (verified live: token counts only), so there is
// nothing to fall back on. Show nothing rather than a confident wrong number.
test("withheld rates force $?? even over an SDK-COMPUTED cost, with the reason attached", () => {
  // The subtle one. The SDK derives its cost from the same flat catalog rates, so a non-zero
  // SDK cost is not a measurement.
  const u = { input: 500_000, output: 500_000, cacheRead: 0, cacheWrite: 0, cost: 0.65, contextPercent: null, contextWindow: 0 };
  const s = computeUsageStats(u, null, "because clocks");
  assert.equal(s.costKnown, false, "renders $??");
  assert.equal(s.cost, 0, "no figure is asserted");
  assert.equal(s.costNote, "because clocks", "the chip can explain itself");
});

test("no withheld reason keeps the SDK's own figure", () => {
  const u = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, cost: 2, contextPercent: null, contextWindow: 0 };
  const rates = { input: 2, output: 4, cacheRead: 0, cacheWrite: 0 };
  const s = computeUsageStats(u, rates);
  assert.equal(s.costKnown, true);
  assert.equal(s.cost, 2, "the SDK's figure, not a re-pricing");
  assert.equal(s.costNote, undefined);
});

test("an unpriceable model explains its own $?? too", () => {
  // The common case, and the one that actually shipped broken: DeepSeek is rare, a 0/0-rate model
  // is not. Without this the chip said "$??" and, worse, my first attempt blanked the tooltip.
  const u = { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0, contextPercent: null, contextWindow: 0 };
  const s = computeUsageStats(u, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.equal(s.costKnown, false);
  assert.ok((s.costNote ?? "").includes("subscription"), "explains why");
});

test("a priced session carries no note to explain", () => {
  const u = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextPercent: null, contextWindow: 0 };
  const s = computeUsageStats(u, { input: 3, output: 6, cacheRead: 0, cacheWrite: 0 });
  assert.equal(s.costKnown, true);
  assert.equal(s.costNote, undefined);
});
