export const DEFAULT_TOOL_COLLAPSE_LINES = 24;
export const DEFAULT_TOOL_COLLAPSE_CHARS = 4_000;

export function shouldAutoCollapseToolText(
  text: string,
  maxLines = DEFAULT_TOOL_COLLAPSE_LINES,
  maxChars = DEFAULT_TOOL_COLLAPSE_CHARS,
): boolean {
  if (!text) { return false; }
  return text.length > maxChars || text.split("\n").length > maxLines;
}
