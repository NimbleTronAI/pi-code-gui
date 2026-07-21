// PiBackend — the formal contract for the ~15% of a session that genuinely diverges
// between the two runtimes. PiService (the orchestrator) holds one `PiBackend` and
// delegates the primitive operations to it. This REDUCED the old `if (_backendKind === "rust")`
// branching (which appeared in ~15 methods and forced null-returning SDK getters) — it did not
// eliminate it: a handful of runtime-IDENTITY checks remain in PiService (backend selection,
// init/dispose routing), and extension.ts still reaches past this seam via
// PiService.sessionManagerInstance for the clone/fork/export session-file paths. Those are
// genuinely SDK-shaped and not yet modelled here; do not read this interface as a complete
// boundary.
//
// The split is deliberate: PRIMITIVES (send a prompt, abort, set the model on the wire,
// read usage, …) live behind this interface and are implemented by SdkService /
// RustService. ORCHESTRATION that merely sequences primitives + UI (cycleModel,
// toggleAutoCompaction, pickModel, the slash-command handler, status formatting) stays
// in PiService — it's runtime-agnostic and calls these primitives. Backends advertise
// what they can do via `capabilities` (a data flag) rather than PiService hard-coding
// `!isRust` conditionals.
import { assertNever, type Runtime } from "./types.js";

/** A backend's usage snapshot. Shared shape across runtimes (RustService already used
 *  it; SdkService now computes the same from its SessionManager). */
export interface BackendUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextPercent: number | null;
  contextWindow: number;
}

/** What a runtime can do — replaces scattered `_backendKind === "rust"` feature gates.
 *  A capability is a property of the backend, checked by PiService's shared UI. */
export interface BackendCapabilities {
  readonly kind: Runtime;
  /** In-process VS Code editor-bridge tools (vscode_*). */
  readonly bridgeTools: boolean;
  /** Interactive custom message cards (vs. markdown fallback). */
  readonly customCards: boolean;
  /** Per-session /tools enable-disable picker. */
  readonly toolsPicker: boolean;
  /** Fork/clone a session from an entry. */
  readonly fork: boolean;
  /** Reload context files mid-session (/reload). */
  readonly reloadContext: boolean;
  /** Export the conversation to HTML. */
  readonly exportHtml: boolean;
  /** Rename a session (/name). */
  readonly rename: boolean;
  /** Whether PiService should intercept builtin slash commands before sending (TS),
   *  or forward everything raw because the backend handles its own slashes (Rust). */
  readonly interceptSlashCommands: boolean;
  /** Whether the thinking level is transmitted on the active transport (a no-op
   *  transport shows a read-only reasoning on/off badge rather than a graded picker).
   *  Depends on the active model's api, so it's a method, not a static flag. */
  thinkingLevelLive(): boolean;
}

/** Whether PiService should flip its own settings state EAGERLY on a toggle, or wait for the
 *  backend to echo the change back.
 *
 *  This is the one genuine state divergence between the runtimes: the SDK applies the setting
 *  in-process, so flipping immediately is safe and keeps the UI responsive; the Rust RPC may
 *  reject or clamp the request, so its state is only flipped by the host callback on success.
 *
 *  Exhaustive on Runtime — a third runtime is a compile error here, which is the point: it must
 *  declare a flip policy rather than silently inheriting "eager". Expressed as a predicate
 *  because the previous inline form needed an if-branch whose only body was a comment. */
export function flipsStateEagerly(runtime: Runtime): boolean {
  switch (runtime) {
    case "typescript": return true;
    case "rust": return false;
    default: return assertNever(runtime, "runtime");
  }
}

/** The single source of truth for a runtime's DEFAULT capability flags. Both backends and the
 *  PiService no-backend fallback derive from this so the defaults can't drift apart (adding a
 *  capability to BackendCapabilities is now one edit here, compile-checked everywhere).
 *
 *  Every gated feature is TS-only (out-of-process RPC has no host-tool injection, no
 *  fork/reload/rename RPCs, and owns its own slash handling), so the flags are `!rust` — EXCEPT
 *  exportHtml, which both runtimes support. `thinkingLevelLive` here is the STATIC default
 *  (`!rust`, correct for the SDK and for the no-model fallback); RustService overrides it with a
 *  per-model check (`thinkingLevelIsLive(model.api)`) since it's dynamic there. */
export function backendCapabilityDefaults(runtime: Runtime): BackendCapabilities {
  const rust = runtime === "rust";
  return {
    kind: runtime,
    bridgeTools: !rust,
    customCards: !rust,
    toolsPicker: !rust,
    fork: !rust,
    reloadContext: !rust,
    exportHtml: true,
    rename: !rust,
    interceptSlashCommands: !rust,
    thinkingLevelLive: () => !rust,
  };
}

/** The primitive, runtime-divergent operations PiService delegates. Implemented by
 *  SdkService (in-process SDK) and RustService (out-of-process RPC). Orchestration
 *  and UI stay in PiService and call through this. */
export interface PiBackend {
  readonly capabilities: BackendCapabilities;

  /** Send a user turn / steer / follow-up. `mode` is "steer" | "queue" | undefined. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendPrompt(text: string, images: any[] | undefined, mode: string | undefined): Promise<void>;
  /** Abort the in-flight LLM turn. */
  abort(): Promise<void> | void;
  /** Abort a running bash tool (best-effort; no-op if unsupported). */
  abortBash(): void;
  /** Compact the conversation context. */
  compact(): Promise<void>;
  /** The active model identity — OWNED by the backend (Rust captures it from get_state /
   *  applyState; the SDK sets it at init + on setModel). PiService reads this instead of
   *  holding its own `_model`. `api`/`reasoning` carry the transport + reasoning flag the
   *  UI uses to decide whether the thinking level is actually transmitted. */
  getModel(): { id?: string; name?: string; provider?: string; api?: string; reasoning?: boolean } | null;
  /** Set the active model on the wire. Returns the resolved model identity applied
   *  (or null if it couldn't be set); the backend also updates its own getModel(). */
  setModel(provider: string, id: string): Promise<{ id?: string; name?: string; provider?: string } | null>;
  /** The active thinking level — OWNED by the backend (Rust captures it from
   *  get_state/applyState; the SDK sets it at init + on setThinkingLevel). PiService reads
   *  this instead of holding its own `_thinkingLevel`. */
  getThinkingLevel(): string;
  /** Set the thinking level on the wire. Returns the level actually in effect after
   *  the backend clamps/validates (may differ from the request); the backend also updates
   *  its own getThinkingLevel(). */
  setThinkingLevel(level: string): Promise<string>;
  /** Update the STORED thinking level WITHOUT a wire call — the echo path for a streamed
   *  `thinking_level_changed` event (the wire already changed; we're just syncing state). */
  applyThinkingLevel(level: string): void;
  /** The in-flight run flag + the streaming flag — OWNED by the backend (both are driven from
   *  the agent event stream via translateAgentEvent, which PiService applies through these
   *  setters). PiService reads them for the preempting-prompt guard and the status bar; RustService
   *  reads its OWN copy directly for the agent_end dedupe and the mid-turn usage guard, so its
   *  event loop doesn't round-trip through a host callback. */
  getAgentRunActive(): boolean;
  setAgentRunActive(v: boolean): void;
  isStreaming(): boolean;
  setStreaming(v: boolean): void;
  /** Reload context files / extensions / skills in-session. Returns false when the runtime has
   *  no in-session reload (Rust loads them at startup), so the caller can say so instead of
   *  reaching through to a raw session object. Guarded by capabilities.reloadContext. */
  reloadContext(): Promise<boolean>;
  /** Toggle auto-compaction on the backend. */
  setAutoCompaction(enabled: boolean): Promise<void>;
  /** Toggle auto-retry on the backend. */
  setAutoRetry(enabled: boolean): Promise<void>;
  /** Export the conversation to HTML at `outputPath`; returns the written path. */
  exportToHtml(outputPath: string): Promise<string>;
  /** Cumulative token/cost usage for the status bar. */
  getUsage(): BackendUsage;
  /** Session entries for the Open Sessions tree (display only). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  getEntries(): any[];
  /** The runtime's own slash commands — the agent-provided ones only (Rust reports its
   *  extensions/templates/skills over RPC; the SDK introspects its extension runner and
   *  adds the builtin prompt templates). PiService appends the shared GUI + capability
   *  commands, so this returns just the per-runtime slice. */
  getSlashCommands(): Array<{ cmd: string; desc: string; source: string }>;
  /** Models available for the /model picker. Rust returns its own get_available_models
   *  catalog (includes custom models.json entries); the SDK queries its ModelRuntime. The
   *  picker reads this instead of branching on runtime for the data source. */
  getAvailableModels(): Promise<Array<{ provider: string; id: string; name?: string; cost?: { input: number; output: number }; contextWindow?: number }>>;
  /** Promote a queued follow-up to a steer message. */
  promoteToSteer(text: string): void;
  /** Clear the pending steer/follow-up queue. */
  clearQueue(): void | Promise<void>;
  /** Tear down the runtime. */
  dispose(): void;
}
