// Usage / token cost policy — the pure decision behind PiService.getUsageStats. The genuine
// runtime divergence lives here: the Rust binary reports cost:0 (it doesn't compute cost), so
// we derive it from tokens × the catalog's published rates; the SDK computes its own per-turn
// cost. Extracted so the costKnown ("$??" vs "$0.00") rules are unit-tested.
import type { Runtime } from "./types.js";
import { computeTokenCost } from "./model-catalog.js";

export interface RawUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextPercent: number | null;
  contextWindow: number;
}

export type CostRates = { input: number; output: number; cacheRead: number; cacheWrite: number };

export interface UsageStats extends RawUsage {
  /** False when we have no cost rates for the model → the status bar renders "$??", not "$0". */
  costKnown: boolean;
}

/** Combine the backend's raw usage with the catalog rates into the display stats. Pure.
 *  - Rust: the binary reports cost:0, so cost = tokens × rates (0 when no rates); costKnown
 *    tracks whether we hold rates at all.
 *  - SDK: keeps the SDK's own computed cost; costKnown when it computed one OR we hold rates
 *    (a rates-bearing model with no turns yet legitimately shows $0.00, not $??). */
export function computeUsageStats(u: RawUsage, rates: CostRates | null, runtime: Runtime): UsageStats {
  if (runtime === "rust") {
    return { ...u, cost: rates ? computeTokenCost(u, rates) : 0, costKnown: rates !== null };
  }
  return { ...u, costKnown: u.cost > 0 || rates !== null };
}
