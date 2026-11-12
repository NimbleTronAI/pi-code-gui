// Pure, vscode-free model-catalog helpers: thinking-level capability (picker/clamp/reconcile)
// against the bundled catalog, and catalog cost lookup. Kept free of vscode for headless testing.

/** The full graded thinking range, lowest→highest, matching pi-ai's EXTENDED_THINKING_LEVELS.
 *  "off" is the floor. This is the *superset*; the levels a concrete model actually honors are
 *  a subset — see getSupportedThinkingLevels.
 *
 *  `max` is a first-class 7th tier, distinct from `xhigh`: some models (e.g. Kimi K3) accept
 *  only `max`, and Anthropic exposes `effort:"max"` above xhigh. Like `xhigh` it is offered ONLY
 *  when a model explicitly maps it. */
export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
export type ThinkingLevel = (typeof THINKING_LEVELS)[number];

/** The thinking-capability shape read off a catalog/SDK model. Mirrors the fields
 *  @earendil-works/pi-ai carries per model. `thinkingLevelMap` maps each graded
 *  level to the provider's effort token, or `null` when that level isn't a distinct
 *  setting for the model (e.g. DeepSeek collapses minimal/low/medium → null, so it
 *  effectively supports off/high/xhigh only). An absent map means a reasoning model
 *  with the full graded range except xhigh (which requires an explicit mapping). */
export interface ThinkingModel {
  reasoning?: boolean;
  thinkingLevelMap?: Record<string, string | null> | null;
}

/** Levels actually meaningful for `model`, lowest→highest. Ported verbatim from
 *  pi-ai's getSupportedThinkingLevels so the extension's picker only ever offers
 *  levels the SDK will honor: a non-reasoning model → ["off"]; a level
 *  mapped to null is dropped; xhigh is offered only when explicitly mapped. */
export function getSupportedThinkingLevels(model: ThinkingModel): ThinkingLevel[] {
  if (!model.reasoning) { return ["off"]; }
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) { return false; }
    // xhigh and max are top-tier rungs offered ONLY when the model explicitly maps them —
    // an absent key means the model doesn't distinguish that tier, so it must not be surfaced.
    if (level === "xhigh" || level === "max") { return mapped !== undefined; }
    return true;
  });
}

/** Snap a requested level to the nearest one `model` supports — prefer the lowest
 *  supported level ≥ the request, else the highest below it. Ported from pi-ai's
 *  clampThinkingLevel so a saved default/session level a model can't honor degrades
 *  predictably rather than silently no-op'ing. */
export function clampThinkingLevel(model: ThinkingModel, level: string): ThinkingLevel {
  const available = getSupportedThinkingLevels(model);
  if (available.includes(level as ThinkingLevel)) { return level as ThinkingLevel; }
  const requested = THINKING_LEVELS.indexOf(level as ThinkingLevel);
  if (requested === -1) { return available[0] ?? "off"; }
  for (let i = requested; i < THINKING_LEVELS.length; i++) {
    if (available.includes(THINKING_LEVELS[i])) { return THINKING_LEVELS[i]; }
  }
  for (let i = requested - 1; i >= 0; i--) {
    if (available.includes(THINKING_LEVELS[i])) { return THINKING_LEVELS[i]; }
  }
  return available[0] ?? "off";
}

/** A catalog model entry carrying an `id` alongside its thinking metadata. */
type CatalogThinkingEntry = ThinkingModel & { id: string };

/** Resolve a model's thinking metadata (reasoning + thinkingLevelMap) from the
 *  bundled catalog by provider + id — the fallback when no SDK model object is at hand.
 *  Returns null for an unknown provider/model so callers fall back to the full graded
 *  range rather than over-narrowing. */
export function findCatalogThinkingModel(
  providers: Record<string, { models: CatalogThinkingEntry[] }> | undefined,
  provider: string,
  id: string,
): ThinkingModel | null {
  const entry = providers?.[provider]?.models.find((m) => m.id === id);
  return entry ? { reasoning: entry.reasoning, thinkingLevelMap: entry.thinkingLevelMap } : null;
}

/**
 * Models whose PUBLISHED price the catalog's four flat rates cannot express, so any cost we
 * compute from them is wrong by construction rather than merely stale.
 *
 * Native DeepSeek V4 bills on a clock: peak is 2x off-peak (UTC 01:00-04:00 and 06:00-10:00 on
 * weekdays; weekends always off-peak). A single scalar cannot be right at both ends of that, and
 * the catalog has no field for it. Two independent facts make this worse than a rounding error:
 *
 *   - The single figure the catalog can carry is wrong half the time whichever end it picks, and
 *     which end it picks has already moved under us. Through 0.85.1 it shipped the pre-August-16
 *     rates: deepseek-v4-pro output at $0.87 against a real $1.98 off-peak / $3.96 peak,
 *     understating by 2.3x to 4.6x. pi-ai 0.86.1 moved it to $3.96 — now exact at peak and 2x
 *     OVER off-peak, i.e. no longer stale and still not right. Bumping pi-ai cannot fix this;
 *     only a catalog field for the clock could. Rechecked 2026-11-12 against DeepSeek's pricing
     page with the pi-ai 1.5.2 catalog: the catalog carries the peak rates for both
     deepseek-flash and deepseek-v4-pro, off-peak is half, and Chinese public holidays are
     off-peak. Pi's computed figure is therefore never low, and up to 2x high. The founder chose
     to keep $?? rather than price each message by its timestamp or show an upper bound.
 *   - The provider does not report cost. Verified against api.deepseek.com: the usage object
 *     carries token counts only (prompt_tokens, completion_tokens, prompt_cache_hit_tokens,
 *     prompt_cache_miss_tokens) with no cost field and no billing headers, so there is nothing
 *     authoritative to fall back on. earendil-works/pi#6881 would read a reported cost where one
 *     exists; it cannot help here.
 *
 * Upstream has this as earendil-works/pi#8510 and #8491, both auto-closed by a new-contributor
 * bot; a maintainer's only comment floats a blended midpoint, which is still wrong by ±50% by
 * construction. So we decline to state a number until the catalog can express the real one.
 *
 * Deliberately keyed to the NATIVE `deepseek` provider. The same models reached through a
 * gateway (openrouter, vercel-ai-gateway, opencode) are billed and priced by that gateway under
 * its own provider id and its own rates, which are not affected by DeepSeek's clock.
 *
 * Keyed to the provider ALONE, deliberately: the clock is a property of DeepSeek's billing, not
 * of any one model id. This used to also match `/^deepseek-v4/`, and pi-ai 0.86.1 renamed
 * `deepseek-v4-flash` to `deepseek-flash` — which silently dropped it out of the match and put a
 * confidently wrong number back on screen. A model-name pattern cannot survive upstream renames,
 * and the failure is invisible when it happens, so there is nothing to pattern-match on. If
 * DeepSeek ever ships a flat-rate model we will over-withhold on it; that error is visible and
 * harmless, which the other direction is not.
 */
export function catalogRatesAreUnexpressible(provider: string | undefined, modelId: string | undefined): boolean {
  void modelId;   // intentionally unused — see above
  return provider === "deepseek";
}

/** Why a cost is being withheld, for the status chip's tooltip. Null when it is not. */
export function costWithheldReason(provider: string | undefined, modelId: string | undefined): string | null {
  return catalogRatesAreUnexpressible(provider, modelId)
    ? "DeepSeek bills by time of day. Peak hours (01:00\u201304:00 and 06:00\u201310:00 UTC, Monday to Friday) cost twice the off-peak rate, which applies at all other times, including weekends and Chinese public holidays. The bundled catalog holds only the peak price, and DeepSeek doesn't report what it billed, so any figure here could be up to 2\u00d7 too high. Your DeepSeek dashboard shows the actual cost."
    : null;
}

/** The per-million-token cost rates a model's catalog entry carries, or null when
 *  absent. Used to restore billing rates a stripped runtime `models.json` override
 *  omits — without which pi-ai's calculateCost (rate/1e6 × tokens) yields exactly $0
 *  and the status bar shows no cost at all. */
export function findCatalogModelCost(
  providers: Record<string, { models: Array<{ id: string; cost?: { input: number; output: number; cacheRead: number; cacheWrite: number } }> }> | undefined,
  provider: string,
  id: string,
): { input: number; output: number; cacheRead: number; cacheWrite: number } | null {
  return providers?.[provider]?.models.find((m) => m.id === id)?.cost ?? null;
}

/** Reconcile a runtime model's thinking capability against the authoritative bundled
 *  catalog, returning the same object shape (a shallow copy when upgraded, else `base`
 *  unchanged). A custom `~/.pi/agent/models.json` entry that OMITS `reasoning` makes the
 *  SDK ModelRegistry default it to `false`, masking a model the published catalog knows
 *  reasons — which clamps the level to "off" (in our clamp AND the SDK's own
 *  `clampThinkingLevel`/`getSupportedThinkingLevels`, both keyed off the model object)
 *  and collapses the picker. This never lets a runtime override DOWNGRADE a known-
 *  reasoning model: if `base` already reasons it's returned untouched (custom maps
 *  preserved); only a falsy `base.reasoning` is upgraded, taking the catalog's reasoning
 *  + thinkingLevelMap. Unknown models (absent from the catalog) are returned as-is, so a
 *  deliberately non-reasoning custom model is respected. */
export function reconcileThinkingCapability<T extends ThinkingModel>(
  providers: Record<string, { models: CatalogThinkingEntry[] }> | undefined,
  provider: string,
  id: string,
  base: T,
): T {
  // A live `max`-keyed top tier is now first-class (THINKING_LEVELS carries `max`), so it is
  // passed through untouched — no longer folded into `xhigh`. Preserve the same-object contract
  // (callers rely on `out === base` = no clobber): return `base` directly when it already reasons.
  if (base.reasoning) { return base; }
  const bundled = findCatalogThinkingModel(providers, provider, id);
  if (bundled?.reasoning) {
    return { ...base, reasoning: true, thinkingLevelMap: base.thinkingLevelMap ?? bundled.thinkingLevelMap };
  }
  return base;
}

