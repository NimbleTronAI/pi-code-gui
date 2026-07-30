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

// ── all-zero rates mean "no price stated", not "free" ─────────────────
// 99 of the 854 bundled models sit at 0/0, mixing genuinely-free models with whole
// subscription providers (qwen-token-plan, xiaomi-token-plan-*, zai, kimi-coding) that have no
// per-token price because a plan was bought up front. pi-ai gives no flag to separate them, so
// we decline to assert $0.00 and let the user apply their own model.
const ZERO = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
const PAID = { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 };
const USED = { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0, contextPercent: null, contextWindow: 200_000 };

test("rust: all-zero rates render $?? rather than a confident $0.00", () => {
  const s = computeUsageStats(USED, ZERO, "rust");
  assert.equal(s.costKnown, false, "a subscription plan's quota burn must not read as free");
  assert.equal(s.cost, 0);
});

test("rust: real rates still price the turn", () => {
  const s = computeUsageStats(USED, PAID, "rust");
  assert.equal(s.costKnown, true);
  assert.ok(s.cost > 0, "tokens x rates");
});

test("typescript: all-zero rates and no SDK cost → $??", () => {
  assert.equal(computeUsageStats(USED, ZERO, "typescript").costKnown, false);
});

test("typescript: an SDK-COMPUTED cost wins over zero rates (a measurement, not an inference)", () => {
  const s = computeUsageStats({ ...USED, cost: 0.02 }, ZERO, "typescript");
  assert.equal(s.costKnown, true);
  assert.equal(s.cost, 0.02);
});

test("a rates-bearing model with no turns yet still shows $0.00, not $??", () => {
  const idle = { ...USED, input: 0, output: 0 };
  assert.equal(computeUsageStats(idle, PAID, "rust").costKnown, true);
  assert.equal(computeUsageStats(idle, PAID, "typescript").costKnown, true);
});

test("cache-only rates can't price a turn → still $??", () => {
  const cacheOnly = { input: 0, output: 0, cacheRead: 0.5, cacheWrite: 6.25 };
  assert.equal(computeUsageStats(USED, cacheOnly, "rust").costKnown, false);
});

test("negative sentinel rates render $?? — never a negative cost", () => {
  // openrouter/auto and openrouter/auto-beta ship input/output of -1000000: pi-ai's way of
  // saying "pricing varies", since an auto-router picks an arbitrary downstream model. The
  // previous `rates !== null` test accepted them, and tokens x negative rates put a NEGATIVE
  // figure in the status bar (-$1500 after 1500 tokens, measured).
  const sentinel = { input: -1_000_000, output: -1_000_000, cacheRead: -1_000_000, cacheWrite: -1_000_000 };
  for (const rt of ["rust", "typescript"] as const) {
    const s = computeUsageStats(USED, sentinel, rt);
    assert.equal(s.costKnown, false, `${rt}: unpriceable`);
    assert.ok(s.cost >= 0, `${rt}: cost must never go negative`);
  }
});
