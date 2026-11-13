// Model selection — the pure core of PiService's model picker (/model). vscode-free: the
// QuickPick item shapes are plain data the shell hands to vscode.window.showQuickPick, so the
// available→choice mapping, the static fallback list, the check/★ labelling, and the
// scoped-models mapping are all unit-tested.

import registry from "./model-registry.generated.json";


export interface ModelCost { input: number; output: number; }
export interface ModelChoice { label: string; provider: string; modelId: string; cost?: ModelCost; contextWindow?: number; }

/**
 * What the fallback list should OFFER, as a preference chain per row: the first id the bundled
 * catalog actually carries wins, and its catalog name becomes the label.
 *
 * This was a literal list, and it rotted exactly as you would expect — it still offered GPT-4o
 * and `deepseek-chat`, a model DeepSeek had withdrawn, so the one list shown when nothing else
 * is available was partly pointing at models that no longer exist. Nothing failed; a row simply
 * would not have worked if picked.
 *
 * Resolving against the bundle instead makes it self-healing. A pi-ai bump that withdraws or
 * renames a model moves the row to the next preference on its own, and a row whose whole chain
 * is gone drops out rather than lingering as a dead entry. Curation stays deliberate — these are
 * chosen starting points, not "everything in the catalog" — but keeping them ALIVE is no longer
 * a manual chore that only gets done when someone notices.
 *
 * Chains run newest-first and end on something long-lived, so an exotic flagship that vanishes
 * degrades to a model that is still there.
 */
const FALLBACK_PREFERENCES: ReadonlyArray<{ provider: string; ids: readonly string[] }> = [
  { provider: "anthropic", ids: ["claude-opus-5", "claude-opus-4-8", "claude-opus-4-5"] },
  { provider: "anthropic", ids: ["claude-sonnet-5", "claude-sonnet-4-6", "claude-sonnet-4-5"] },
  { provider: "anthropic", ids: ["claude-haiku-4-5"] },
  { provider: "openai", ids: ["gpt-5.5", "gpt-5.2", "gpt-5"] },
  { provider: "google", ids: ["gemini-3.5-flash", "gemini-2.5-pro"] },
  { provider: "deepseek", ids: ["deepseek-v4-pro", "deepseek-flash"] },
];

/** Resolve a preference chain against the bundled catalog. Pure; exported for the tests. */
export function resolveFallbackModels(
  providers: Record<string, { models: Array<{ id: string; name?: string }> }>,
  preferences: ReadonlyArray<{ provider: string; ids: readonly string[] }> = FALLBACK_PREFERENCES,
): ModelChoice[] {
  const out: ModelChoice[] = [];
  for (const { provider, ids } of preferences) {
    const models = providers[provider]?.models ?? [];
    for (const id of ids) {
      const hit = models.find((m) => m.id === id);
      if (hit) { out.push({ label: hit.name || hit.id, provider, modelId: hit.id }); break; }
    }
  }
  return out;
}

/** Static fallback shown when no runtime catalog is available (no pricing — only
 *  runtime-reported pricing is ever displayed, and with no runtime there is none). */
export const FALLBACK_MODELS: ModelChoice[] = resolveFallbackModels(registry.providers);

/** Format model specs (pricing + context window) for the QuickPick `detail` line. Empty when
 *  there's no data. Pure. */
export function formatModelDetail(cost?: ModelCost, contextWindow?: number): string {
  const parts: string[] = [];
  // All-zero rates are the catalog declining to state a price, not a price of zero — the same
  // call the status chip makes (see ratesArePriceable in usage-stats.ts). Rendering
  // "$0/$0 per M tokens" would assert free for subscription providers that merely have no
  // per-token rate, so the pricing clause is omitted and only the context window shows.
  if (cost && (cost.input > 0 || cost.output > 0)) { parts.push(`$${cost.input}/$${cost.output} per M tokens`); }
  if (contextWindow) { parts.push(`${Math.round(contextWindow / 1000)}K context`); }
  return parts.join(" · ");
}

/** Map the backend's getAvailableModels() rows to picker choices (name falls back to id). Pure. */
export function toModelChoices(available: Array<{ provider: string; id: string; name?: string; cost?: ModelCost; contextWindow?: number }>): ModelChoice[] {
  return available.map((m) => ({ label: m.name || m.id, provider: m.provider, modelId: m.id, cost: m.cost, contextWindow: m.contextWindow }));
}

export interface ModelPickerItem { label: string; description: string; detail: string; provider: string; modelId: string; isDefault: boolean; }

/** Build the QuickPick items: active model marked `$(check)`, the saved default marked ★. Pure —
 *  a function of (models, currentId, defaultModel). */
export function buildModelPickerItems(models: ModelChoice[], currentId: string | undefined, defModel: { provider: string; id: string } | null): ModelPickerItem[] {
  return models.map((m) => {
    const isDefault = !!defModel && m.provider === defModel.provider && m.modelId === defModel.id;
    return {
      label: `${m.label}${m.modelId === currentId ? " $(check)" : ""}${isDefault ? " ★" : ""}`,
      description: m.provider,
      detail: formatModelDetail(m.cost, m.contextWindow),
      provider: m.provider,
      modelId: m.modelId,
      isDefault,
    };
  });
}

/** The two options for the "save as default?" step, shared by every picker that offers one.
 *
 *  This step used to present ONE item ("★ Save as default"), leaving "no" to be expressed by
 *  dismissing the QuickPick — an invisible affordance the user has to guess at. Declining is a
 *  real answer and gets a real row, which also names what would be kept, so the consequence of
 *  each choice is on screen rather than remembered. */
export interface DefaultChoiceItem { label: string; description: string; save: boolean }

export function buildDefaultChoiceItems(nextLabel: string, currentDefaultLabel: string | null): DefaultChoiceItem[] {
  return [
    { label: `\u2605 Save "${nextLabel}" as default`, description: "Start future sessions with this", save: true },
    currentDefaultLabel
      ? { label: `Keep "${currentDefaultLabel}" as default`, description: "This session only", save: false }
      : { label: "Don't set a default", description: "This session only", save: false },
  ];
}
