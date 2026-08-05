export interface LineChangeSummary {
  additions: number;
  deletions: number;
}

function splitLines(text: string): string[] {
  if (!text) { return []; }
  const lines = text.split("\n");
  if (lines.at(-1) === "") { lines.pop(); }
  return lines;
}

/** Count inserted and deleted lines using a memory-bounded LCS calculation. */
export function summarizeLineChanges(before: string, after: string): LineChangeSummary {
  const oldLines = splitLines(before);
  const newLines = splitLines(after);
  let prefix = 0;
  while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) {
    prefix++;
  }
  let oldEnd = oldLines.length;
  let newEnd = newLines.length;
  while (oldEnd > prefix && newEnd > prefix && oldLines[oldEnd - 1] === newLines[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  const oldChanged = oldLines.slice(prefix, oldEnd);
  const newChanged = newLines.slice(prefix, newEnd);
  // Avoid quadratic work for complete rewrites of very large files. In that
  // case the bounded middle region is conservatively treated as replaced.
  if (oldChanged.length * newChanged.length > 4_000_000) {
    return { additions: newChanged.length, deletions: oldChanged.length };
  }

  let previous = new Uint32Array(newChanged.length + 1);
  for (const oldLine of oldChanged) {
    const current = new Uint32Array(newChanged.length + 1);
    for (let index = 1; index <= newChanged.length; index++) {
      current[index] = oldLine === newChanged[index - 1]
        ? previous[index - 1] + 1
        : Math.max(previous[index], current[index - 1]);
    }
    previous = current;
  }

  const unchanged = previous[newChanged.length];
  return {
    additions: newChanged.length - unchanged,
    deletions: oldChanged.length - unchanged,
  };
}

export function formatLineChangeSummary(before: string, after: string): string {
  const { additions, deletions } = summarizeLineChanges(before, after);
  return `+${additions} −${deletions}`;
}
