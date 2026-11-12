// PiBackend — the contract between PiService (the orchestrator) and SdkService (the in-process
// Pi SDK runtime). PiService holds one `PiBackend` and delegates the primitive operations to it;
// the interface is also the test seam that lets PiService be driven headlessly with a fake.
// extension.ts still reaches past it via PiService.sessionManagerInstance for the
// clone/fork/export session-file paths, so do not read it as a complete boundary.
//
// The split is deliberate: PRIMITIVES (send a prompt, abort, set the model on the wire,
// read usage, …) live behind this interface and are implemented by SdkService. ORCHESTRATION
// that merely sequences primitives + UI (cycleModel, toggleAutoCompaction, pickModel, the
// slash-command handler, status formatting) stays in PiService and calls these primitives.
import type { RawUsage } from "./usage-stats.js";

/** A backend's usage snapshot: the cost policy's input (usage-stats.ts RawUsage). */
export type BackendUsage = RawUsage;

/** The primitive operations PiService delegates to SdkService. Orchestration and UI stay in
 *  PiService and call through this. */
export interface PiBackend {
  /** Send a user turn / steer / follow-up. `mode` is "steer" | "queue" | undefined. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendPrompt(text: string, images: any[] | undefined, mode: string | undefined): Promise<void>;
  /** Abort the in-flight LLM turn. */
  abort(): Promise<void> | void;
  /** Abort a running bash tool (best-effort; no-op if unsupported). */
  abortBash(): void;
  /** Compact the conversation context. */
  compact(): Promise<void>;
  /** The active model identity — OWNED by the backend (set at init + on setModel). PiService
   *  reads this instead of holding its own `_model`. */
  getModel(): { id?: string; name?: string; provider?: string; api?: string; reasoning?: boolean } | null;
  /** Set the active model on the wire. Returns the resolved model identity applied
   *  (or null if it couldn't be set); the backend also updates its own getModel(). */
  setModel(provider: string, id: string): Promise<{ id?: string; name?: string; provider?: string } | null>;
  /** Persist a display name for this session through the SDK session. */
  setSessionName(name: string): Promise<boolean>;
  /** The active thinking level — OWNED by the backend (set at init + on setThinkingLevel).
   *  PiService reads this instead of holding its own `_thinkingLevel`. */
  getThinkingLevel(): string;
  /** Set the thinking level on the wire. Returns the level actually in effect; the backend also
   *  updates its own getThinkingLevel(). */
  setThinkingLevel(level: string): Promise<string>;
  /** Update the STORED thinking level WITHOUT a wire call — the echo path for a streamed
   *  `thinking_level_changed` event (the wire already changed; we're just syncing state). */
  applyThinkingLevel(level: string): void;
  /** The in-flight run flag + the streaming flag — OWNED by the backend (both are driven from
   *  the agent event stream via translateAgentEvent, which PiService applies through these
   *  setters). PiService reads them for the preempting-prompt guard, the abort watchdog and the
   *  status bar. */
  getAgentRunActive(): boolean;
  setAgentRunActive(v: boolean): void;
  isStreaming(): boolean;
  setStreaming(v: boolean): void;
  /** Reload context files / extensions / skills in-session. Returns false when the session has
   *  no reload, so the caller can say so instead of reaching through to a raw session object. */
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
  /** The agent-provided slash commands (the session's extension commands + the builtin prompt
   *  templates). PiService appends the GUI/session commands. */
  getSlashCommands(): Array<{ cmd: string; desc: string; source: string }>;
  /** Models available for the /model picker (the SDK's ModelRuntime). */
  getAvailableModels(): Promise<Array<{ provider: string; id: string; name?: string; cost?: { input: number; output: number }; contextWindow?: number }>>;
  /** Promote a queued follow-up to a steer message. */
  promoteToSteer(text: string): void;
  /** Clear the pending steer/follow-up queue. */
  clearQueue(): void | Promise<void>;
  /** Tear down the runtime. */
  dispose(): void;
}
