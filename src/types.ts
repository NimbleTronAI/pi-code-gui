/** Image content for prompt attachments */
export interface ImageContent {
  type: "image";
  source: {
    type: "base64";
    mediaType: string;
    data: string;
  };
}

/** Summary of a past session as returned by session listing. */
export interface SessionSummary {
  name?: string;
  path: string;
  firstMessage?: string;
  messageCount: number;
  created?: number;
  modified?: number;
}

/** A single entry in a session (message, compaction, model change, etc.). */
export type SessionEntryData = Record<string, unknown> & {
  id?: string;
  type?: string;
  message?: Record<string, unknown>;
  provider?: string;
  modelId?: string;
  thinkingLevel?: string;
  summary?: string;
  tokensBefore?: number;
  timestamp?: number;
  customType?: string;
  content?: unknown;
  label?: string;
  name?: string;
};

/** Webview message for prompt with optional images */
export interface PromptMessage {
  type: "prompt";
  text: string;
  images?: ImageContent[];
}

// Re-export shared protocol types and schemas.
// PiServiceEvent is now derived from the Zod schema (source of truth).
export {
  type ExtensionToWebview,
  type WebviewToExtension,
  type PiServiceEvent,
  validateExtensionToWebview,
  validateWebviewToExtension,
  isExtensionToWebview,
} from "./shared/protocol.js";

export type { ValidationResult, ValidationError } from "./shared/protocol.js";
