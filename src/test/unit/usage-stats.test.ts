// Headless tests for the extracted usage/cost policy (src/usage-stats.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { computeUsageStats, type RawUsage, type CostRates } from "../../usage-stats.js";

const RATES: CostRates = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };
const usage = (over: Partial<RawUsage> = {}): RawUsage => ({
  input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextPercent: null, contextWindow: 0, ...over,
});

test("rust with rates: cost derived from tokens × rates, costKnown true", () => {
  const u = usage({ input: 1_000_000, output: 1_000_000 });
  const s = computeUsageStats(u, RATES, "rust");
  assert.equal(s.cost, 18); // 1M×3 + 1M×15 = 18,000,000 / 1e6
  assert.equal(s.costKnown, true);
});

test("rust without rates: cost 0, costKnown false (→ $??)", () => {
  const s = computeUsageStats(usage({ input: 500_000 }), null, "rust");
  assert.equal(s.cost, 0);
  assert.equal(s.costKnown, false);
});

test("rust ignores any cost the binary reported and recomputes from tokens", () => {
  // Binary reports cost:99 but Rust cost is always recomputed from rates.
  const s = computeUsageStats(usage({ input: 1_000_000, cost: 99 }), RATES, "rust");
  assert.equal(s.cost, 3);
});

test("sdk: keeps the SDK-computed cost; costKnown true when cost > 0", () => {
  const s = computeUsageStats(usage({ cost: 0.42 }), null, "typescript");
  assert.equal(s.cost, 0.42);
  assert.equal(s.costKnown, true);
});

test("sdk: zero cost but rates present → costKnown true ($0.00, not $??)", () => {
  const s = computeUsageStats(usage({ cost: 0 }), RATES, "typescript");
  assert.equal(s.cost, 0);
  assert.equal(s.costKnown, true);
});

test("sdk: zero cost and no rates → costKnown false ($??)", () => {
  const s = computeUsageStats(usage({ cost: 0 }), null, "typescript");
  assert.equal(s.costKnown, false);
});

test("passes token counts and context through unchanged", () => {
  const u = usage({ input: 10, output: 20, cacheRead: 5, cacheWrite: 2, contextPercent: 42, contextWindow: 200_000 });
  const s = computeUsageStats(u, RATES, "typescript");
  assert.deepEqual(
    { input: s.input, output: s.output, cacheRead: s.cacheRead, cacheWrite: s.cacheWrite, contextPercent: s.contextPercent, contextWindow: s.contextWindow },
    { input: 10, output: 20, cacheRead: 5, cacheWrite: 2, contextPercent: 42, contextWindow: 200_000 },
  );
});
