import { splitEditorContext } from "./editor-context.js";

const TURN_PREVIEW_CHARACTER_LIMIT = 700;

interface MessageLike {
  id?: unknown;
  role?: unknown;
  content?: unknown;
}

interface HistoryEntryLike {
  id?: unknown;
  type?: unknown;
  message?: MessageLike;
}

export interface ConversationTurnPreview {
  entryId: string;
  user: string;
  agent: string;
}

function extractTextContent(content: unknown): string {
  if (typeof content === "string") { return content; }
  if (!Array.isArray(content)) { return ""; }
  return content.flatMap((part): string[] => {
    if (!part || typeof part !== "object") { return []; }
    const block = part as Record<string, unknown>;
    return block.type === "text" && typeof block.text === "string" ? [block.text] : [];
  }).join("\n");
}

export function truncateConversationTurnPreview(text: string): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= TURN_PREVIEW_CHARACTER_LIMIT) { return normalized; }
  return `${normalized.slice(0, TURN_PREVIEW_CHARACTER_LIMIT - 1).trimEnd()}…`;
}

/** Build one lightweight minimap item per complete Session user turn. */
export function buildConversationTurnPreviews(
  entries: readonly unknown[],
): ConversationTurnPreview[] {
  const turns: ConversationTurnPreview[] = [];
  let current: ConversationTurnPreview | undefined;

  for (const value of entries) {
    if (!value || typeof value !== "object") { continue; }
    const entry = value as HistoryEntryLike;
    if (entry.type !== "message" || !entry.message) { continue; }
    const message = entry.message;
    if (message.role === "user") {
      const entryId = typeof entry.id === "string"
        ? entry.id
        : typeof message.id === "string" ? message.id : undefined;
      if (!entryId) {
        current = undefined;
        continue;
      }
      const prompt = splitEditorContext(extractTextContent(message.content));
      current = {
        entryId,
        user: truncateConversationTurnPreview(prompt.text),
        agent: "",
      };
      turns.push(current);
      continue;
    }
    if (message.role !== "assistant" || !current) { continue; }
    const text = extractTextContent(message.content);
    if (!text) { continue; }
    current.agent = truncateConversationTurnPreview(
      current.agent ? `${current.agent}\n${text}` : text,
    );
  }

  return turns;
}
