// Behavioral contract for streaming tool calls over the Rust RPC transport — the net
// that static audits structurally cannot produce.
//
// Every user-facing streaming defect this project hit (upstream #124/#126/#129: tool-call
// `arguments`/`id`/`name` staying empty on the partial until the terminal event) is a
// RUNTIME behavior invisible to a source audit — it only shows on the wire. These pure
// helpers turn a captured `toolcall_delta` sequence into a verdict, so the opt-in
// `scripts/rpc-behavior.mjs` harness (real binary) and headless fixture tests both assert
// the same contract: a snapshot/RPC client must be able to correlate and render a tool
// call AS IT STREAMS, not after it completes.
//
// Pure + vscode-free: driven by fixtures in tests and by real RPC frames in the harness.

/** One `toolcall_delta`'s view of the partial tool-call block (what a snapshot client
 *  reads from `assistantMessageEvent.partial.content[contentIndex]`). */
export interface ToolCallDeltaFrame {
  /** 1-based ordinal of this delta within the tool call's stream. */
  index: number;
  id: string | null | undefined;
  name: string | null | undefined;
  /** The partial `arguments` value: null | {} | a partially-parsed object | a raw string. */
  arguments: unknown;
}

export interface ToolStreamReport {
  deltas: number;
  /** Ordinal where `id` first became non-empty, or null if never. */
  firstIdAt: number | null;
  /** Ordinal where `name` first became non-empty, or null if never. */
  firstNameAt: number | null;
  /** Ordinal where `arguments` first carried real content (non-null, non-empty), or null. */
  firstArgsAt: number | null;
  /** True if, once `id` appeared, it stayed non-empty on every subsequent delta. */
  idStableAfterFirst: boolean;
}

/** Whether a partial `arguments` value carries meaningful content yet — mirrors the
 *  webview's preview gate: null/undefined, empty object `{}`, and empty string are "not
 *  yet"; a partial object with ≥1 key or a non-empty string is "real". */
export function argumentsAreReal(args: unknown): boolean {
  if (args === null || args === undefined) { return false; }
  if (typeof args === "string") { return args.length > 0; }
  if (typeof args === "object") { return Object.keys(args).length > 0; }
  return true; // number/boolean — real
}

const nonEmpty = (s: string | null | undefined): boolean => typeof s === "string" && s.length > 0;

/** Reduce a tool call's ordered `toolcall_delta` frames to when each field became usable. */
export function analyzeToolStream(frames: ToolCallDeltaFrame[]): ToolStreamReport {
  let firstIdAt: number | null = null;
  let firstNameAt: number | null = null;
  let firstArgsAt: number | null = null;
  let idStableAfterFirst = true;
  for (const f of frames) {
    if (nonEmpty(f.id)) { if (firstIdAt === null) { firstIdAt = f.index; } }
    else if (firstIdAt !== null) { idStableAfterFirst = false; } // went empty again after appearing
    if (firstNameAt === null && nonEmpty(f.name)) { firstNameAt = f.index; }
    if (firstArgsAt === null && argumentsAreReal(f.arguments)) { firstArgsAt = f.index; }
  }
  return { deltas: frames.length, firstIdAt, firstNameAt, firstArgsAt, idStableAfterFirst };
}

export interface StreamViolation { code: string; detail: string; }

/** The streaming contract a snapshot/RPC client depends on. Returns [] when honored.
 *  `graceDeltas` allows the id/name to land within the first few frames rather than
 *  strictly frame 1 (providers vary in how the very first fragment is chunked). */
export function checkStreamContract(r: ToolStreamReport, graceDeltas = 3): StreamViolation[] {
  const v: StreamViolation[] = [];
  if (r.deltas === 0) { return v; } // no streamed tool call in this turn — nothing to assert
  if (r.firstIdAt === null || r.firstIdAt > graceDeltas) {
    v.push({ code: "id-not-early", detail: `tool-call id absent until delta ${r.firstIdAt ?? "never"} of ${r.deltas} (need ≤${graceDeltas}); snapshot clients can't correlate the preview with tool_execution_* (upstream #129).` });
  }
  if (r.firstNameAt === null || r.firstNameAt > graceDeltas) {
    v.push({ code: "name-not-early", detail: `tool-call name absent until delta ${r.firstNameAt ?? "never"} of ${r.deltas} (need ≤${graceDeltas}).` });
  }
  if (r.firstArgsAt === null || r.firstArgsAt >= r.deltas) {
    v.push({ code: "args-not-streamed", detail: `arguments never carried real content before the final delta (first-real=${r.firstArgsAt ?? "never"}, deltas=${r.deltas}); this renders as pause-then-pop, not streaming (upstream #124/#126).` });
  }
  if (r.firstIdAt !== null && !r.idStableAfterFirst) {
    v.push({ code: "id-unstable", detail: "tool-call id blinked back to empty after first appearing — correlation would break mid-stream." });
  }
  return v;
}

/** Coalescing detector for a pure message-delta stream (thinking or tool args): if the
 *  transport back-pressures, the binary drops/merges deltas and a snapshot client sees a
 *  long quiet gap then a burst. Given inter-delta gaps (ms), flag any gap that dwarfs the
 *  median — the signature of a stalled reader (the backpressure→coalescing class). */
export function detectCoalescing(gapsMs: number[], factor = 12, floorMs = 400): { coalesced: boolean; maxGapMs: number; medianGapMs: number } {
  if (gapsMs.length === 0) { return { coalesced: false, maxGapMs: 0, medianGapMs: 0 }; }
  const sorted = [...gapsMs].sort((a, b) => a - b);
  const median = sorted[Math.floor(sorted.length / 2)];
  const maxGap = sorted[sorted.length - 1];
  const coalesced = maxGap > floorMs && median > 0 && maxGap > median * factor;
  return { coalesced, maxGapMs: maxGap, medianGapMs: median };
}
