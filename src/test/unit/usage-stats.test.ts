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

test("rust: a binary-reported cost wins over the computed one", () => {
  // rust-pi 0.8.0 prices each turn itself (message_end usage.cost.total, get_session_stats cost)
  // from the rates in its own catalog. That figure is the binary's measurement; tokens x OUR rates
  // would re-price stored turns at today's rates, which is not what was billed.
  const s = computeUsageStats(usage({ input: 1_000_000, cost: 99 }), RATES, "rust");
  assert.equal(s.cost, 99);
  assert.equal(s.costKnown, true);
  assert.equal(s.costNote, undefined);
});

test("rust: a binary-reported cost shows even when the catalog holds no rates for the model", () => {
  // e.g. a model the user priced in their own models.json: the binary prices it, we cannot.
  const s = computeUsageStats(usage({ input: 1_000_000, cost: 2.5 }), null, "rust");
  assert.equal(s.cost, 2.5);
  assert.equal(s.costKnown, true);
});

test("rust: zero binary cost with priceable rates falls back to tokens × rates", () => {
  // An older or user-supplied binary that reports cost 0: our arithmetic, as before.
  const s = computeUsageStats(usage({ input: 1_000_000, output: 1_000_000, cost: 0 }), RATES, "rust");
  assert.equal(s.cost, 18);
  assert.equal(s.costKnown, true);
});

test("withheld rates still beat a binary-reported cost", () => {
  // The binary prices DeepSeek from the same flat catalog rates, so its figure is no more right
  // than ours: the $?? policy applies on top of whatever the binary reports.
  const s = computeUsageStats(usage({ input: 1_000_000, output: 1_000_000, cost: 16.65 }), RATES, "rust", "because clocks");
  assert.equal(s.costKnown, false);
  assert.equal(s.cost, 0);
  assert.equal(s.costNote, "because clocks");
});

test("rust: turns stored at cost 0 by an older binary are priced from tokens and added to the binary's cost", () => {
  // R4: rust-pi sums STORED per-turn costs, so a session resumed from a pre-0.8.0 binary carries
  // 0 for its old turns. RustService hands their token counts over as `uncosted`.
  const uncosted = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };
  const s = computeUsageStats(usage({ input: 2_000_000, cost: 4, uncosted }), RATES, "rust");
  assert.equal(s.cost, 7);   // 4 (binary) + 1M x 3 (legacy offset)
  assert.equal(s.costKnown, true);
  assert.equal("uncosted" in s, false, "the offset's token counts are not display stats");
});

test("rust: earlier zero-cost turns we cannot price make the session cost unknown", () => {
  // Review of record S1: the binary's figure alone would silently drop the old turns while
  // claiming to be the whole session's cost. "$??" with the reason, never a confident partial.
  const uncosted = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const rates of [null, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }]) {
    const s = computeUsageStats(usage({ input: 2_000_000, cost: 4, uncosted }), rates, "rust");
    assert.equal(s.costKnown, false, JSON.stringify(rates));
    assert.equal(s.cost, 0);
    assert.match(String(s.costNote), /No per-token price/);
    assert.match(String(s.costNote), /older Rust Pi/, "says why the session total is unknown");
  }
  // No zero-cost turns with tokens: the binary's own figure stands, rates or not.
  assert.equal(computeUsageStats(usage({ cost: 4, uncosted: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }), null, "rust").costKnown, true);
});

test("rust: a resume whose history could not be read makes the cost unknown, whatever the binary reports", () => {
  const s = computeUsageStats(usage({ input: 2_000_000, cost: 4, uncostedUnread: true }), RATES, "rust");
  assert.equal(s.costKnown, false);
  assert.equal(s.cost, 0);
  assert.equal("uncostedUnread" in s, false, "not a display stat");
  // Review Cc (SF1/SF2): the binary at 0 is no longer "complete" — its tokens count only what it
  // kept after a compaction, and without the history we cannot tell. Unknown, never re-priced.
  const z = computeUsageStats(usage({ input: 1_000_000, cost: 0, uncostedUnread: true }), RATES, "rust");
  assert.equal(z.costKnown, false, `shown ${z.cost}`);
  assert.match(String(z.costNote), /history couldn't be read/);
});

test("rust: a compacted session, unread usage, or per-turn costs that don't add up make the cost unknown", () => {
  // Review Cc SF1 (PROVEN on 0.8.0): the summary calls a compaction makes are billed but appear in
  // no reply, so any figure after a compaction would be a confident under-count. SF2: an unread
  // usage reply on a resume hides whether it compacted. N2: a stats total above the per-turn sum
  // means the per-turn figures drifted. Each is "$??" with its reason, for any rates or cost.
  for (const [reason, note] of [["compacted", /compacted/], ["usage-unread", /usage couldn't be read/], ["mismatch", /don't add up/]] as const) {
    for (const cost of [0, 4]) {
      const s = computeUsageStats(usage({ input: 2_000_000, cost, costUnknown: reason }), RATES, "rust");
      assert.equal(s.costKnown, false, `${reason} at binary cost ${cost}: shown ${s.cost}`);
      assert.equal(s.cost, 0);
      assert.match(String(s.costNote), note);
      assert.equal("costUnknown" in s, false, "not a display stat");
    }
  }
  // The withheld-rates note still wins (it is the more specific reason).
  assert.equal(computeUsageStats(usage({ cost: 4, costUnknown: "compacted" }), RATES, "rust", "because clocks").costNote, "because clocks");
});

test("rust: earlier zero-cost turns on another model than the current one make the session cost unknown", () => {
  // Pricing them at the CURRENT model's rates would be a confident wrong figure: they ran on a
  // model whose rates we are not holding. Applies whether or not the binary has priced a turn yet.
  const uncosted = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 };
  for (const cost of [0, 4]) {
    const s = computeUsageStats(usage({ input: 2_000_000, cost, uncosted, uncostedOtherModel: true }), RATES, "rust");
    assert.equal(s.costKnown, false, `binary cost ${cost}`);
    assert.equal(s.cost, 0);
    assert.match(String(s.costNote), /older Rust Pi/);
    assert.equal("uncostedOtherModel" in s, false, "not a display stat");
  }
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

// ── withheld cost: a price the catalog cannot express ────────────────
// Native DeepSeek V4 bills on a clock (peak 2x off-peak) and the catalog holds one flat scalar —
// which is ALSO stale: pi-ai 0.84.3 still ships pre-August-16 rates understating output by up to
// 4.6x. DeepSeek reports no cost of its own (verified live: token counts only), so there is
// nothing to fall back on. Show nothing rather than a confident wrong number.
test("withheld rates force $?? on the Rust path, with the reason attached", () => {
  const u = { input: 1_000_000, output: 1_000_000, cacheRead: 0, cacheWrite: 0, cost: 0, contextPercent: null, contextWindow: 0 };
  const rates = { input: 0.435, output: 0.87, cacheRead: 0, cacheWrite: 0 };
  const s = computeUsageStats(u, rates, "rust", "because clocks");
  assert.equal(s.costKnown, false, "renders $??");
  assert.equal(s.cost, 0, "no figure is asserted");
  assert.equal(s.costNote, "because clocks", "the chip can explain itself");
});

test("withheld rates also beat a TypeScript-runtime COMPUTED cost", () => {
  // The subtle one. The SDK derives its cost from the same flat catalog rates, so a non-zero
  // SDK cost is not a measurement — without this, the TypeScript runtime would keep showing the
  // very number the Rust runtime is suppressing.
  const u = { input: 500_000, output: 500_000, cacheRead: 0, cacheWrite: 0, cost: 0.65, contextPercent: null, contextWindow: 0 };
  const s = computeUsageStats(u, null, "typescript", "because clocks");
  assert.equal(s.costKnown, false);
  assert.equal(s.cost, 0);
});

test("no withheld reason leaves both runtimes exactly as they were", () => {
  const u = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextPercent: null, contextWindow: 0 };
  const rates = { input: 2, output: 4, cacheRead: 0, cacheWrite: 0 };
  const s = computeUsageStats(u, rates, "rust");
  assert.equal(s.costKnown, true);
  assert.equal(s.cost, 2);
  assert.equal(s.costNote, undefined);
});

test("an unpriceable model explains its own $?? too, on both runtimes", () => {
  // The common case, and the one that actually shipped broken: DeepSeek is rare, a 0/0-rate model
  // is not. Without this the chip said "$??" and, worse, my first attempt blanked the tooltip.
  const u = { input: 1000, output: 500, cacheRead: 0, cacheWrite: 0, cost: 0, contextPercent: null, contextWindow: 0 };
  for (const runtime of ["rust", "typescript"] as const) {
    const s = computeUsageStats(u, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, runtime);
    assert.equal(s.costKnown, false, runtime);
    assert.ok((s.costNote ?? "").includes("subscription"), runtime + " explains why");
  }
});

test("a priced session carries no note to explain", () => {
  const u = { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextPercent: null, contextWindow: 0 };
  const s = computeUsageStats(u, { input: 3, output: 6, cacheRead: 0, cacheWrite: 0 }, "rust");
  assert.equal(s.costKnown, true);
  assert.equal(s.costNote, undefined);
});
