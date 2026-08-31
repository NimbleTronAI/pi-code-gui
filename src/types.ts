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

/** Plan-mode lifecycle. rust-pi reports none of this — see RustService.planMode. */
export type PlanMode = "off" | "planning" | "pending" | "approved";

/** Tool-approval posture, mirroring rust-pi's ApprovalMode. */
export type ApprovalMode = "always-ask" | "write" | "yolo";

/** Compile-time exhaustiveness guard. Placing `assertNever(x)` in the default/else of a
 *  discriminated switch makes adding a third runtime a TYPE error at every unhandled
 *  branch, instead of silently falling through to the TypeScript path. */
export function assertNever(x: never, context = "value"): never {
  throw new Error(`Unhandled ${context}: ${JSON.stringify(x)}`);
}

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
