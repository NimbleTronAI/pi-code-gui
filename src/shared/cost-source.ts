// What a shown session cost is, in words — shared by the webview's status chip and the
// Sessions tree so the two say the same thing. The decision itself is computeUsageStats
// (src/usage-stats.ts).

/** "billed": the provider reported what it charged (pi-ai `totalFromProvider`). "estimated":
 *  tokens priced at the bundled catalog's rates. "mixed": some of each. */
export type CostSource = "billed" | "estimated" | "mixed";

export function costSourceText(source: CostSource | undefined): string | undefined {
  switch (source) {
    case "billed": return "Cost as billed by the provider.";
    case "estimated": return "Estimated cost: tokens priced at the model's catalog rates. Your provider's bill may differ.";
    case "mixed": return "Partly billed cost reported by the provider, partly estimated at catalog rates.";
    default: return undefined;
  }
}
