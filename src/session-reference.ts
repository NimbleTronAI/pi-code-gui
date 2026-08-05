export function extractSessionId(content: string): string | undefined {
  const firstLine = content.split("\n", 1)[0]?.trim();
  if (!firstLine) { return undefined; }
  try {
    const header = JSON.parse(firstLine) as { id?: unknown };
    return typeof header.id === "string" && header.id.trim() ? header.id : undefined;
  } catch {
    return undefined;
  }
}
