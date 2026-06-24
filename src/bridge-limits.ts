// Pure, vscode-free output-size guards for the VS Code bridge tools. Extracted
// from bridge-tools.ts (which imports vscode) so the context-overflow bounds can
// be unit-tested headlessly. `boundedJson` is the SOLE guard that keeps a giant
// tool result (a huge document outline, thousands of references) from blowing the
// model's context window, so its boundaries matter.

/** Max lines / UTF-8 bytes a bridge-tool result may carry before it's truncated. */
export const MAX_OUTPUT_LINES = 2000;
export const MAX_OUTPUT_BYTES = 50 * 1024;

/** Truncate `text` to at most `maxLines` lines, then to `maxBytes` UTF-8 bytes. */
export function truncateText(text: string, maxLines = MAX_OUTPUT_LINES, maxBytes = MAX_OUTPUT_BYTES): string {
  const lines = text.split("\n");
  let output = lines.length > maxLines ? lines.slice(0, maxLines).join("\n") : text;
  if (Buffer.byteLength(output, "utf8") > maxBytes) {
    output = Buffer.from(output, "utf8").subarray(0, maxBytes).toString("utf8");
  }
  return output;
}

/** JSON-stringify `value`, replacing it with a bounded "truncated" envelope when
 *  it exceeds the line/byte limits. The sole context-overflow guard on bridge
 *  tool results. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function boundedJson(value: any): string {
  const text = JSON.stringify(value) ?? "null";
  const lineCount = text.split("\n").length;
  const byteCount = Buffer.byteLength(text, "utf8");
  if (lineCount <= MAX_OUTPUT_LINES && byteCount <= MAX_OUTPUT_BYTES) { return text; }
  return JSON.stringify({
    truncated: true,
    message: "Result exceeded output limits.",
    originalBytes: byteCount,
    originalLines: lineCount,
    resultJsonPrefix: truncateText(text),
  });
}
