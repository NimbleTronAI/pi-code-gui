// The Thinking/Reasoning dial — pure decisions behind PiService's status chip, the /thinking
// picker, and the on/off toggle. Thinking and Reasoning are two axes of ONE dial: "off"
// disables thinking; any other level enables it at that reasoning effort (mirrors the wire's
// thinking.type + reasoning_effort/effort fields). vscode-free so the composed chip text, the
// restore-last-level rule, the toggle target, and the picker rows are all unit-tested.

/** The composed status-bar chip: text + whether it's an actionable (clickable) control. A
 *  transport that can't transmit the level (some Rust provider apis) degrades to a read-only
 *  "reasoning: on/off" badge — the only real axis there. Pure. */
export function composeThinkingStatus(opts: { live: boolean; reasoningOn: boolean; level: string }): { text: string; clickable: boolean } {
  if (!opts.live) { return { text: `reasoning: ${opts.reasoningOn ? "on" : "off"}`, clickable: false }; }
  if (opts.level === "off") { return { text: "thinking: off", clickable: true }; }
  return { text: `thinking: on · reasoning: ${opts.level}`, clickable: true };
}

/** The reasoning level to apply when Thinking is turned on with no explicit choice: the last
 *  one used (if the model still supports it), else the model's highest supported level. Pure. */
export function pickDefaultReasoningLevel(supported: string[], lastReasoning: string | undefined): string {
  const on = supported.filter((l) => l !== "off");
  if (lastReasoning && on.includes(lastReasoning)) { return lastReasoning; }
  return on[on.length - 1] ?? "high";
}

/** Toggle the Thinking axis: off→the restore level, on→"off". Pure. */
export function toggleThinkingTarget(realLevel: string, defaultReasoning: string): string {
  return realLevel === "off" ? defaultReasoning : "off";
}

export const REASONING_DESCR: Record<string, string> = {
  minimal: "minimal reasoning", low: "brief reasoning", medium: "balanced reasoning",
  high: "extended reasoning", xhigh: "very high reasoning", max: "maximum reasoning",
};

/** A row in the /thinking QuickPick: a group separator or a selectable level. */
export type ThinkingPickerRow =
  | { separator: true; label: string }
  | { separator: false; label: string; description: string; level: string; isDefault: boolean };

/** Build the picker rows: "Off", a "Reasoning level" separator, then the model's supported
 *  on-levels. Active level marked `$(check)`, the saved default marked ★. Pure — a function of
 *  (onLevels, current, defaultLevel). */
export function buildThinkingPickerRows(onLevels: string[], current: string, defLevel: string): ThinkingPickerRow[] {
  const fmt = (lvl: string, label: string): string =>
    `${lvl === current ? "$(check) " : ""}${label}${lvl === defLevel ? " ★" : ""}`;
  return [
    { separator: false, label: fmt("off", "Off"), description: "thinking off", level: "off", isDefault: defLevel === "off" },
    { separator: true, label: "Reasoning level" },
    ...onLevels.map((l) => ({ separator: false as const, label: fmt(l, l), description: REASONING_DESCR[l] ?? "reasoning", level: l, isDefault: l === defLevel })),
  ];
}
