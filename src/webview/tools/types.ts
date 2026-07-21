// ── Tool data shapes ─────────────────────────────────────────
//
// These live in their own module so state.ts can name the live-tool-card entry shape without
// importing tools/index.ts (which imports state.ts). Types only — this module emits no runtime
// code and disappears from the bundle entirely.

export type ToolData = Record<string, unknown> & {
  toolCallId: string;
  toolName: string;
  entryId?: string;
  args?: Record<string, unknown>;
  fromMessage?: boolean;
};

export type ToolPartialResult = { content?: Array<{ type: string; text: string }> };

/** The SDK's hard-truncation report. Also declared on WebviewEventData in global.d.ts; naming it
 *  here is what lets `result.details.truncation` be read without a cast. */
export type Truncation = {
  truncated: boolean;
  truncatedBy?: string;
  totalLines: number;
  outputLines: number;
  outputBytes: number;
  maxBytes?: number;
  maxLines?: number;
  firstLineExceedsLimit?: boolean;
};

export type ToolResult = {
  content?: Array<{ type: string; text: string }>;
  // Intersected rather than replaced: `details` carries arbitrary per-tool keys, but truncation
  // is the one the read renderer actually destructures.
  details?: { truncation?: Truncation } & Record<string, unknown>;
  text?: string;
};

/** A tool-card element. The `_toolBlock` / `_writeState` / … expandos the renderers hang off it
 *  are declared on HTMLElement in global.d.ts — they were reached through `(el as any)._x` casts
 *  in 37 places, which defeated checking on state that was ALREADY typed. */
export type ToolEl = HTMLElement;

/** A tool renderer, as registered in `state.toolRenderers` and stored alongside each live card.
 *  One shape for both: the registry and the card entry hold the same objects. */
export interface ToolRenderer {
  create: (data: ToolData) => ToolEl;
  update: (el: ToolEl, partialResult: ToolPartialResult) => void;
  finalize: (el: ToolEl, result: ToolResult, isError: boolean, entryId?: string) => void;
}

/** A live tool card, keyed by toolCallId in `state.currentToolBlocks`.
 *
 *  ALWAYS this pair. The declaration used to be `{ el, renderer } | HTMLElement`, and nine read
 *  sites carried an `(entry as any).el || entry` fallback for the bare-element arm — but only two
 *  writers exist (handleToolStart's bash promotion and its create path) and both build the pair,
 *  so that arm was never produced. Worse, the fallback was not even protective: had `el` been
 *  falsy it yielded the entry OBJECT, whose `.getAttribute` is undefined, so the read sites that
 *  call `block.getAttribute(...)` unguarded would have thrown on it anyway. */
export interface ToolBlockEntry {
  el: ToolEl;
  renderer?: ToolRenderer;
}
