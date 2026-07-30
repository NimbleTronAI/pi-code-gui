// Model selection — the pure core of PiService's model picker (/model). vscode-free: the
// QuickPick item shapes are plain data the shell hands to vscode.window.showQuickPick, so the
// available→choice mapping, the static fallback list, the check/★ labelling, and the
// scoped-models mapping are all unit-tested.
 

export interface ModelCost { input: number; output: number; }
export interface ModelChoice { label: string; provider: string; modelId: string; cost?: ModelCost; contextWindow?: number; }

/** Static fallback shown when no runtime catalog is available (no pricing — only
 *  runtime-reported pricing is ever displayed). */
export const FALLBACK_MODELS: ModelChoice[] = [
  { label: "Claude Sonnet 4.5", provider: "anthropic", modelId: "claude-sonnet-4-5" },
  { label: "Claude Haiku 4.5", provider: "anthropic", modelId: "claude-haiku-4-5" },
  { label: "Claude Opus 4.5", provider: "anthropic", modelId: "claude-opus-4-5" },
  { label: "GPT 4o", provider: "openai", modelId: "gpt-4o" },
  { label: "Gemini 2.5 Pro", provider: "google", modelId: "gemini-2.5-pro" },
  { label: "DeepSeek V3", provider: "deepseek", modelId: "deepseek-chat" },
];

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

