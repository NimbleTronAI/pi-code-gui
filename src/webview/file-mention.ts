export interface WorkspaceFileMention {
  start: number;
  query: string;
}

export function findWorkspaceFileMention(
  text: string,
  cursor: number,
): WorkspaceFileMention | undefined {
  const beforeCursor = text.slice(0, cursor);
  const match = beforeCursor.match(/(?:^|\s)@([^\s@]*)$/);
  if (!match) { return undefined; }

  const matchedText = match[0];
  return {
    start: beforeCursor.length - matchedText.length + (/^\s/.test(matchedText) ? 1 : 0),
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
