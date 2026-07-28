// Pure, vscode-free model-catalog helpers SHARED BY BOTH RUNTIMES: thinking-level
// capability (picker/clamp/reconcile), cost computation, and the maxTokens/compat
// shaping used when writing the Rust binary's models.json. Formerly rust-catalog.ts —
// renamed because that name wrongly implied Rust-only ownership (audit finding).
// Kept separate from rust-models.ts (which imports vscode) for headless testing.

/**
 * Resolve the `maxTokens` to write for a catalog model — or `undefined` to OMIT
 * the field entirely, letting rust-pi/the provider apply its own default.
 *
 * Background: rust-pi 0.1.20 forwards a catalog model's `maxTokens` to the
 * provider VERBATIM as the request's max_tokens (0.1.18 ignored it and hard-
 * capped at 4096). The bundled pi-ai registry gives a `maxTokens` for every
 * model, but for some it's a PLACEHOLDER that merely copies `contextWindow`
 * (grok 2,000,000; kimi 262,144) rather than a real output limit. Sending such a
 * value is a hard provider 400 ("Invalid max_tokens value, valid range [1, N]")
 * that surfaces as a SILENT empty turn — verified live against deepseek.
 *
 * The rule mirrors the TS SDK's openai-completions provider, which only sends
 * max_tokens when a real value is set and otherwise omits it:
 *  - a real limit (maxTokens < contextWindow) is used VERBATIM, so genuine large
 *    capacity is preserved (deepseek-v4-pro's 384,000 is kept and works);
 *  - a placeholder (maxTokens >= contextWindow — you can never emit the entire
 *    window, since input always consumes some) or a garbage/non-positive value
 *    is treated as absent and omitted, which is safer than guessing a number
 *    (verified live: deepseek rejects an over-range max_tokens but completes
 *    normally when the field is absent).
 */
export function resolveMaxOutputTokens(maxTokens: number, contextWindow: number): number | undefined {
  if (!Number.isFinite(maxTokens) || maxTokens <= 0) { return undefined; }
  const mt = Math.floor(maxTokens);
  const cw = Number.isFinite(contextWindow) && contextWindow > 0 ? Math.floor(contextWindow) : 0;
  if (cw > 0 && mt >= cw) { return undefined; }
  return mt;
}

/**
 * Provider transports whose request body actually carries a thinking/reasoning
 * control, so the chosen thinking *level* has a real effect on generation. Each
 * emits a thinking/effort/budget field on the wire that the provider honors:
 *  - `anthropic-messages`     → `thinking: {budget_tokens}` (level → token budget)
 *  - `openai-responses`       → `reasoning_effort` (level → effort category)
 *  - `google-generative-ai`   → thinking config
 *  - `openai-completions`     → `thinking: {type: enabled|disabled}`, plus
 *      `reasoning_effort: "high"` at high/xhigh.
 *
 * `openai-completions` was historically EXCLUDED here because rust-pi serialized
 * no reasoning field for it. That changed in pi_agent_rust 6c5f43b3 (the DeepSeek
 * thinking-level fix, ahead of the published v0.1.18 — the extension ships a local
 * build until upstream releases it). Verified end-to-end 2026-06-26 against the
 * real DeepSeek API: `off` → zero reasoning tokens / no `reasoning_content`; every
 * other level → real `reasoning_content`, accepted with no 400. So the level is
 * genuinely transmitted now. Two honest limits:
 *  - The grading is COARSE: on the wire minimal/low/medium are identical
 *    ({type: enabled}, no effort) and high/xhigh are identical (+effort high), so
 *    the effective control on DeepSeek is ~on/off, not a fine budget.
 *  - `openai-completions` is a BROAD transport (~50 providers). Only DeepSeek is
 *    verified to honor the field; others may ignore it. The per-model `reasoning`
 *    flag still gates the picker (a non-reasoning model clamps to off), so we
 *    only over-claim for a reasoning-capable model on a provider that silently
 *    drops the field — a tolerable failure (level shown, mildly ineffective)
 *    versus the prior guaranteed no-op for DeepSeek.
 *
 * `mistral-conversations` and anything unknown are treated as NOT live until
 * confirmed, which fails safe (we under-claim control rather than overstate it).
 */
const THINKING_LIVE_TRANSPORTS: ReadonlySet<string> = new Set([
  "anthropic-messages",
  "openai-responses",
  "google-generative-ai",
  "openai-completions",
]);

/** True when the model's transport (`api`) actually transmits the thinking level,
 *  so a graded picker is meaningful. False for unknown/unverified transports,
 *  where the level is a no-op and only reasoning on/off (a property of the model,
 *  not an adjustable knob) is real. */
export function thinkingLevelIsLive(api: string | null | undefined): boolean {
  return typeof api === "string" && THINKING_LIVE_TRANSPORTS.has(api);
}

/** The full graded thinking range, lowest→highest, matching rust-pi's `--thinking`
 *  possible-values and pi-ai's EXTENDED_THINKING_LEVELS. "off" is the floor. This
 *  is the *superset*; the levels a concrete model actually honors are a subset —
 *  see getSupportedThinkingLevels.
 *
 *  `max` is the first-class 7th tier added upstream (pi_agent_rust#139) — distinct from
 *  `xhigh`, since some models (e.g. Kimi K3) accept only `max` and Anthropic exposes
 *  `effort:"max"` above xhigh. Like `xhigh` it is offered ONLY when a model explicitly maps
 *  it: a pre-#139 pi-ai keys its top tier `xhigh:"max"` (no `max` KEY), so on the current
 *  bundled catalog and the pinned v0.1.22 binary `max` is never surfaced or sent. It lights up
 *  once the bundled catalog is regenerated from a post-#139 pi-ai (and the rust pin is bumped);
 *  the presence of a distinct `max` key is itself the signal the backend understands it. */
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
 *  levels the SDK/binary will honor: a non-reasoning model → ["off"]; a level
 *  mapped to null is dropped; xhigh is offered only when explicitly mapped. */
export function getSupportedThinkingLevels(model: ThinkingModel): ThinkingLevel[] {
  if (!model.reasoning) { return ["off"]; }
  return THINKING_LEVELS.filter((level) => {
    const mapped = model.thinkingLevelMap?.[level];
    if (mapped === null) { return false; }
    // xhigh and max are top-tier rungs offered ONLY when the model explicitly maps them —
    // an absent key means the model doesn't distinguish that tier (a pre-#139 catalog never
    // carries a `max` key), so it must not be surfaced.
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

/** The `compat` block pi_agent_rust reads for per-model thinking control. */
export interface RustThinkingCompat {
  thinkingLevelMap?: Record<string, string>;
  forceAdaptiveThinking?: boolean;
  thinkingFormat?: string;
}

/** Build the `{ compat }` fragment to write into pi_agent_rust's models.json so the
 *  Rust backend serializes thinking the same way the TS path does (gh #116/#117). It
 *  nests `thinkingLevelMap` / `forceAdaptiveThinking` / `thinkingFormat` under `compat`
 *  — the shape the binary deserializes (`model.compat.*`, camelCase); a top-level
 *  thinkingLevelMap is silently dropped. Null map entries (e.g. DeepSeek collapses
 *  minimal/low/medium → null) are FILTERED OUT: the binary's `thinking_level_map` is a
 *  `HashMap<String,String>` that rejects null values, and an absent level just falls
 *  back to the transport's built-in mapping. Returns `{}` (no `compat` key) when the
 *  model carries no thinking metadata, keeping models.json minimal. */
export function buildThinkingCompat(model: {
  thinkingLevelMap?: Record<string, string | null> | null;
  compat?: { thinkingFormat?: string; forceAdaptiveThinking?: boolean };
}): { compat?: RustThinkingCompat } {
  const compat: RustThinkingCompat = {};
  if (model.thinkingLevelMap) {
    const tlm: Record<string, string> = {};
    for (const [level, mapped] of Object.entries(model.thinkingLevelMap)) {
      if (typeof mapped === "string") { tlm[level] = mapped; }
    }
    if (Object.keys(tlm).length) { compat.thinkingLevelMap = tlm; }
  }
  if (typeof model.compat?.forceAdaptiveThinking === "boolean") {
    compat.forceAdaptiveThinking = model.compat.forceAdaptiveThinking;
  }
  if (model.compat?.thinkingFormat) { compat.thinkingFormat = model.compat.thinkingFormat; }
  return Object.keys(compat).length ? { compat } : {};
}

/** A catalog model entry carrying an `id` alongside its thinking metadata. */
type CatalogThinkingEntry = ThinkingModel & { id: string };

/** Resolve a model's thinking metadata (reasoning + thinkingLevelMap) from the
 *  bundled catalog by provider + id. The Rust path has no SDK ModelRegistry to
 *  resolve against (it's built only on the TS path), so the thinking-level picker
 *  reads metadata from here instead. Returns null for an unknown provider/model so
 *  callers fall back to the full graded range rather than over-narrowing. */
export function findCatalogThinkingModel(
  providers: Record<string, { models: CatalogThinkingEntry[] }> | undefined,
  provider: string,
  id: string,
): ThinkingModel | null {
  const entry = providers?.[provider]?.models.find((m) => m.id === id);
  return entry ? { reasoning: entry.reasoning, thinkingLevelMap: entry.thinkingLevelMap } : null;
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

/** Compute a turn/session cost from token counts and per-million-token rates — the
 *  same arithmetic as pi-ai's calculateCost (rate / 1e6 × tokens, summed). Used to
 *  derive cost EXTENSION-SIDE for the Rust backend, whose binary reports cost:0 even
 *  with full rates in its catalog (it doesn't compute cost). */
export function computeTokenCost(
  usage: { input?: number; output?: number; cacheRead?: number; cacheWrite?: number },
  rates: { input: number; output: number; cacheRead: number; cacheWrite: number },
): number {
  const n = (v?: number): number => (typeof v === "number" ? v : 0);
  return (
    n(usage.input) * rates.input +
    n(usage.output) * rates.output +
    n(usage.cacheRead) * rates.cacheRead +
    n(usage.cacheWrite) * rates.cacheWrite
  ) / 1_000_000;
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

