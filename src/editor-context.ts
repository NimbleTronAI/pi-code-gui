import type { EditorContextItem } from "./shared/protocol.js";

const CONTEXT_START = "<pi-on-code-editor-context>";
const CONTEXT_END = "</pi-on-code-editor-context>";

export interface ActiveEditorContext {
  id: string;
  path: string;
  languageId: string;
  source: "selection" | "document";
  content: string;
  truncated: boolean;
}

export interface PromptEditorContext {
  items: EditorContextItem[];
  activeDocument?: ActiveEditorContext;
  attachedDocuments?: ActiveEditorContext[];
}

export interface SplitPromptContext {
  text: string;
  context?: PromptEditorContext;
}

export function truncateUtf8(text: string, maxBytes: number): { text: string; truncated: boolean } {
  const encoded = Buffer.from(text, "utf8");
  if (encoded.byteLength <= maxBytes) {
    return { text, truncated: false };
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  let end = maxBytes;
  while (end > 0) {
    try {
      return {
        text: decoder.decode(encoded.subarray(0, end)),
        truncated: true,
      };
    } catch {
      end--;
    }
  }
  return { text: "", truncated: true };
}

export function appendEditorContext(text: string, context: PromptEditorContext): string {
  if (context.items.length === 0) { return text; }

  const payload = JSON.stringify({
    instruction:
      "Use active editor and explicitly @-attached document contents as primary context. Other visible editors are path references; read them only when relevant.",
    ...context,
  });
  const separator = text ? "\n\n" : "";
  return `${text}${separator}${CONTEXT_START}\n${payload}\n${CONTEXT_END}`;
}

export function splitEditorContext(text: string): SplitPromptContext {
  const startMarker = `${CONTEXT_START}\n`;
  const start = text.lastIndexOf(startMarker);
  if (start < 0) { return { text }; }

  const payloadStart = start + startMarker.length;
  const end = text.lastIndexOf(CONTEXT_END);
  if (end < payloadStart || text.slice(end + CONTEXT_END.length).trim()) {
    return { text };
  }

  try {
    const parsed = JSON.parse(text.slice(payloadStart, end).trim()) as PromptEditorContext & {
      instruction?: string;
    };
    if (!parsed || !Array.isArray(parsed.items)) {
      return { text };
    }
    const { instruction: _instruction, ...context } = parsed;
    return {
      text: text.slice(0, start).trimEnd(),
      context,
    };
  } catch {
    return { text };
  }
}
