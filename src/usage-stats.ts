// Usage / token cost policy — the pure decision behind PiService.getUsageStats. Both runtimes
// now price their own turns: the SDK per turn, and rust-pi (0.8.0+) per turn from the rates in
// its own catalog (message_end usage.cost.total, summed over the turns get_messages lists). We fall back to
// tokens × the catalog's published rates only for a Rust binary that reports no cost, and for
// turns an older binary stored at cost 0. Extracted so the costKnown ("$??" vs "$0.00") rules
// are unit-tested.
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
  /** Rust only: the token counts of turns an older binary stored at cost 0 (R4), priced here
   *  from the catalog rates and added to the binary's own cost. Absent when there are none. */
  uncosted?: TokenCounts;
  /** Rust only: some `uncosted` turn ran on another model than the current one (or on one we
   *  cannot name), so the current rates cannot price it. */
  uncostedOtherModel?: boolean;
  /** Rust only: a resume whose history could not be read, so turns stored at 0 are unknown. */
  uncostedUnread?: boolean;
  /** Rust only: why no session cost can be stated at all (review Cc). "compacted": the session
   *  compacted, and rust-pi reports the cost of its summary calls nowhere; "usage-unread": a resume
   *  whose usage reply could not be read, so a compaction cannot be ruled out; "mismatch": the
   *  binary's session total exceeds its per-turn record, so the per-turn figures drifted;
   *  "aborted" (C34): a turn was stopped, and rust-pi stores a stopped turn at 0 (or at its input only) although the
   *  provider may bill it; "failed" (C34, review D R1/N2): a request failed after the provider
   *  accepted it, and rust-pi stores that turn at 0 (or at its input only) although the provider may bill it. */
  costUnknown?: "compacted" | "aborted" | "failed" | "usage-unread" | "mismatch";
}

export type TokenCounts = { input: number; output: number; cacheRead: number; cacheWrite: number };

export type CostRates = { input: number; output: number; cacheRead: number; cacheWrite: number };

export interface UsageStats extends RawUsage {
  /** False when we have no cost rates for the model → the status bar renders "$??", not "$0". */
  costKnown: boolean;
  /** Why the cost is withheld, when it is — surfaced as the status chip's tooltip so "$??" is
   *  self-explanatory at the point a user meets it. Absent when a cost IS shown. */
  costNote?: string;
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

const COST_UNKNOWN_NOTES: Record<NonNullable<RawUsage["costUnknown"]>, string> = {
  compacted:
    "This session has been compacted. Rust Pi doesn't report what the summaries it writes when " +
    "compacting cost, so the session cost can't be computed. Token counts above don't include them.",
  aborted:
    "A turn in this session was stopped before it finished. The provider may still bill a stopped " +
    "request, but Rust Pi saves it at no cost, or at only part of its cost, so the session cost can't be " +
    "computed. Token counts above may not include all of it.",
  failed:
    "A request in this session failed part-way through. The provider may still bill it, but Rust Pi " +
    "saves it at no cost, or at only part of its cost, so the session cost can't be computed. Token " +
    "counts above may not include all of it.",
  "usage-unread":
    "This session's usage couldn't be read from Rust Pi, so it can't be checked for a compaction " +
    "(whose cost Rust Pi doesn't report) and the session cost can't be computed.",
  mismatch:
    "Rust Pi's per-turn costs don't add up to its session total (its usage format may have changed), " +
    "so the session cost can't be computed.",
};

/** Combine the backend's raw usage with the catalog rates into the display stats. Pure.
 *  - Rust: a cost the binary reported (> 0) is shown, plus tokens × rates for any `uncosted`
 *    turns stored at 0, e.g. by an older binary (R4). Those turns make the cost "$??" when they
 *    ran on another model or the current one has no priceable rates. A binary that reports 0
 *    gets the old arithmetic: cost = tokens × rates when the rates are priceable, else "$??".
 *    A compacted session, a stopped turn saved at no cost, an unread usage or history reply on a
 *    resume, or a per-turn record that doesn't add up is "$??" whatever the figures
 *    (`costUnknown`, `uncostedUnread`).
 *  - SDK: keeps the SDK's own computed cost; costKnown when it computed one OR we hold
 *    priceable rates (a rates-bearing model with no turns yet legitimately shows $0.00, not $??).
 *    An SDK-computed cost > 0 always wins — that is a measurement, not an inference. */
export function computeUsageStats(raw: RawUsage, rates: CostRates | null, runtime: Runtime, withheldReason?: string | null): UsageStats {
  // `uncosted*` are inputs to the price, not display stats — keep them out of what we return.
  const { uncosted, uncostedOtherModel, uncostedUnread, costUnknown, ...u } = raw;
  // An unexpressible price outranks BOTH runtimes' normal paths, including an SDK-computed cost.
  // That cost is not a measurement here: the SDK derives it from the same flat catalog rates, so
  // "the SDK computed one" is not evidence it is right. See catalogRatesAreUnexpressible.
  if (withheldReason) { return { ...u, cost: 0, costKnown: false, costNote: withheldReason }; }
  const priceable = ratesArePriceable(rates);
  // Whenever we render "$??" the reason travels with it. The unpriceable case is the COMMON one
  // (99 of 854 bundled models sit at 0/0 rates: genuinely free models and whole subscription
  // providers, which the catalog gives us no way to tell apart) — so leaving it unexplained is
  // what a user actually meets most of the time.
  const NO_RATE_NOTE =
    "No per-token price is published for this model in the bundled catalog — it may be free, or " +
    "billed under a subscription plan — so the session cost can't be computed. Token counts above " +
    "are still exact.";
  if (runtime === "rust") {
    // A figure from an incomplete record is a confident under-count: "$??" with the reason instead.
    if (costUnknown) { return { ...u, cost: 0, costKnown: false, costNote: COST_UNKNOWN_NOTES[costUnknown] }; }
    // Turns stored at 0 (by an older binary, or live at 0) carry no figure. We price them only from their
    // tokens at the current model's rates — so if they ran on another model, or the current
    // model has no priceable rates, the session's total is unknown: "$??", never a partial sum.
    const legacy = uncosted && (uncosted.input + uncosted.output + uncosted.cacheRead + uncosted.cacheWrite) > 0 ? uncosted : null;
    if (legacy && uncostedOtherModel) {
      return { ...u, cost: 0, costKnown: false, costNote:
        "Some turns in this session were saved without a cost (for example by an older Rust Pi) on " +
        "another model than the current one, so the session cost can't be computed. Token counts " +
        "above are still exact." };
    }
    if (legacy && !priceable) {
      return { ...u, cost: 0, costKnown: false, costNote:
        "No per-token price is published for this model in the bundled catalog, and some turns in " +
        "this session were saved without a cost (for example by an older Rust Pi), so the session " +
        "cost can't be computed. Token counts above are still exact." };
    }
    // Whatever the binary reports: its figure covers only the context it kept after a compaction,
    // and without the history we can tell neither that nor which turns were saved without a cost.
    if (uncostedUnread) {
      return { ...u, cost: 0, costKnown: false, costNote:
        "This session's history couldn't be read from Rust Pi, so the session cost can't be computed." };
    }
    // The binary's own figure is a per-turn record of what it priced, so it wins over re-pricing
    // every stored turn at today's rates; the old turns' price is added on top.
    if (u.cost > 0) {
      const offset = legacy && priceable ? computeTokenCost(legacy, rates) : 0;
      return { ...u, cost: u.cost + offset, costKnown: true };
    }
    if (!priceable) { return { ...u, cost: 0, costKnown: false, costNote: NO_RATE_NOTE }; }
    return { ...u, cost: computeTokenCost(u, rates), costKnown: true };
  }
  const known = u.cost > 0 || priceable;
  return known ? { ...u, costKnown: true } : { ...u, costKnown: false, costNote: NO_RATE_NOTE };
}
