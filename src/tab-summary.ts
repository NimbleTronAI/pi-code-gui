// Tab-title summary — the pure core of PiService.generateTabSummary (the lightweight side-call
// that turns the first user message into a 3-word tab title, given to BOTH runtimes since the
// Rust binary has no summarize RPC). The ModelRuntime call stays in PiService; the prompt/
// context construction and the output cleaning live here so they're unit-tested.

export const TAB_SUMMARY_SYSTEM_PROMPT =
  "Generate a concise 3-word summary of the following user request. Respond with ONLY the three words, lowercase, no punctuation, no quotes, no explanation.";

/** The completeSimple context for the summary side-call. `now` is injected for determinism. */
export function buildSummaryContext(userInput: string, now: number): { systemPrompt: string; messages: Array<{ role: string; content: string; timestamp: number }> } {
  return {
    systemPrompt: TAB_SUMMARY_SYSTEM_PROMPT,
    messages: [{ role: "user", content: userInput, timestamp: now }],
  };
}

/** Clean the model's raw reply into a tab title: first line, trimmed, surrounding quotes
 *  stripped, capped at ~40 chars. Returns null when the reply is empty (the caller then keeps
 *  the raw first message). Pure — preserves the original truthy-text behavior verbatim. */
export function cleanTabSummary(text: string | null | undefined): string | null {
  if (!text) { return null; }
  return text.split("\n")[0].trim().replace(/^["']|["']$/g, "").slice(0, 40);
}
