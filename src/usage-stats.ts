// Usage / token cost policy — the pure decision behind PiService.getUsageStats. The SDK prices
// its own turns; this decides whether that figure can be shown ("$0.00") or must be "$??", and
// why. Extracted so the costKnown rules are unit-tested.

import type { CostSource } from "./shared/cost-source.js";
export type { CostSource };

export interface RawUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  /** Whether `cost` is what the provider billed (pi-ai `Usage.cost.totalFromProvider`, 1.5.0):
   *  "all" = every usage record that counts was billed by the provider, "some" = a mix of billed
   *  and catalog-estimated records, "none" (or absent) = all estimated. Only OpenRouter reports
   *  billed totals in pi-ai 1.5.2. */
  costFromProvider?: CostFromProvider;
  contextPercent: number | null;
  contextWindow: number;
}

export type CostFromProvider = "all" | "some" | "none";

export type CostRates = { input: number; output: number; cacheRead: number; cacheWrite: number };

export interface UsageStats extends RawUsage {
  /** False when we have no cost rates for the model → the status bar renders "$??", not "$0". */
  costKnown: boolean;
  /** Why the cost is withheld, when it is — surfaced as the status chip's tooltip so "$??" is
   *  self-explanatory at the point a user meets it. Absent when a cost IS shown. */
  costNote?: string;
  /** What a SHOWN cost is: the provider's bill, a catalog estimate, or a mix. Absent when the
   *  cost is withheld. Its wording is costSourceText (src/shared/cost-source.ts). */
  costSource?: CostSource;
}

/** Whether rates say anything we can price a turn with.
 *
 *  All-zero rates are NOT a price of zero — they are the catalog declining to state one. 99 of
 *  the 854 bundled models sit at 0/0, and they are two different things wearing the same face:
 *  genuinely free models (openrouter `:free`, google `gemma-*`, nvidia NIM) and whole
 *  subscription providers (`qwen-token-plan`, `xiaomi-token-plan-*`, `zai`, `kimi-coding`) where
 *  there simply is no per-token price because a plan was bought up front. pi-ai gives us no flag
 *  to tell them apart, and the only alternative — hardcoding a provider list — is exactly the
 *  brittleness catalog generation exists to avoid. So we decline to assert: a plan user sees
 *  "$??" and applies their own mental model instead of a confident "$0.00" that quietly
 *  understates their quota burn. Cache rates alone can't price a turn, so only input/output
 *  count here. */
function ratesArePriceable(rates: CostRates | null): rates is CostRates {
  return rates !== null && (rates.input > 0 || rates.output > 0);
}

/** Combine the backend's raw usage with the catalog rates into the display stats. Pure.
 *  Keeps the SDK's own computed cost; costKnown when it computed one OR we hold priceable rates
 *  (a rates-bearing model with no turns yet legitimately shows $0.00, not $??). An SDK-computed
 *  cost > 0 wins over missing rates — that is a measurement, not an inference — but a withheld
 *  reason (rates the catalog cannot express) outranks everything. */
export function computeUsageStats(raw: RawUsage, rates: CostRates | null, withheldReason?: string | null): UsageStats {
  const u = { ...raw };
  // A total the provider billed is a measurement, not an inference from catalog rates, so none
  // of the rules below (all about trusting catalog rates) apply to it — not even a withheld
  // reason, and a billed $0 is a real $0.00.
  if (u.costFromProvider === "all") { return { ...u, costKnown: true, costSource: "billed" }; }
  const shownSource: CostSource = u.costFromProvider === "some" ? "mixed" : "estimated";
  // An unexpressible price outranks an SDK-computed cost. That cost is not a measurement here:
  // the SDK derives it from the same flat catalog rates, so "the SDK computed one" is not
  // evidence it is right. See catalogRatesAreUnexpressible.
  if (withheldReason) { return { ...u, cost: 0, costKnown: false, costNote: withheldReason }; }
  const known = u.cost > 0 || ratesArePriceable(rates);
  // Whenever we render "$??" the reason travels with it. The unpriceable case is the COMMON one
  // (99 of 854 bundled models sit at 0/0 rates: genuinely free models and whole subscription
  // providers, which the catalog gives us no way to tell apart) — so leaving it unexplained is
  // what a user actually meets most of the time.
  const NO_RATE_NOTE =
    "No per-token price is published for this model in the bundled catalog — it may be free, or " +
    "billed under a subscription plan — so the session cost can't be computed. Token counts above " +
    "are still exact.";
  return known ? { ...u, costKnown: true, costSource: shownSource } : { ...u, costKnown: false, costNote: NO_RATE_NOTE };
}
