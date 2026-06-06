/** Image content for prompt attachments */
export interface ImageContent {
  type: "image";
  source: {
    type: "base64";
    mediaType: string;
    data: string;
  };
}

/**
 * Which Pi runtime backs a session: the in-process TypeScript SDK
 * (`@earendil-works/pi-coding-agent`) or the out-of-process Rust binary
 * (`pi --mode rpc`).
 */
export type Runtime = "typescript" | "rust";

/** Summary of a past session as returned by session listing. */
export interface SessionSummary {
  name?: string;
  path: string;
  firstMessage?: string;
  messageCount: number;
  created?: number;
  modified?: number;
  /** The runtime that created this session (used for the unified Past Sessions list). */
  runtime?: Runtime;
}

/**
 * A persisted reference to an open session window, tagged with the runtime that
 * created it so reload can restore each tab on its origin runtime.
 */
export interface OpenSessionRef {
  path: string;
  runtime: Runtime;
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
