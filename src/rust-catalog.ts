// Pure, vscode-free helpers for shaping the bundled model catalog before it's
// written to the Rust binary's models.json. Kept separate from rust-models.ts
// (which imports vscode) so they can be unit-tested headlessly.

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
