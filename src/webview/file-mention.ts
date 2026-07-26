export interface WorkspaceFileMention {
  start: number;
  query: string;
}

export function findWorkspaceFileMention(
  text: string,
  cursor: number,
): WorkspaceFileMention | undefined {
  if (cursor < 0 || cursor > text.length) { return undefined; }
  const lineStart = cursor === 0 ? 0 : text.lastIndexOf("\n", cursor - 1) + 1;
  const linePrefix = text.slice(lineStart, cursor);
  const match = linePrefix.match(/^\s*@([^\s@]*)$/);
  if (!match) { return undefined; }

  return {
    start: lineStart + linePrefix.lastIndexOf("@"),
    query: match[1] ?? "",
  };
}

export function removeWorkspaceFileMention(
  text: string,
  start: number,
  cursor: number,
): { text: string; cursor: number } {
  if (start < 0 || start > cursor || cursor > text.length) {
    return { text, cursor };
  }
  const before = text.slice(0, start);
  let after = text.slice(cursor);
  if (/\s$/.test(before) && /^\s/.test(after)) {
    after = after.slice(1);
  }
  return {
    text: before + after,
    cursor: start,
  };
}
