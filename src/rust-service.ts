// RustService — owns the out-of-process Rust Pi runtime (`pi --mode rpc`).
//
// Extracted from PiService so the ~85%-runtime-agnostic core isn't carrying the
// Rust-only process lifecycle, RPC handshake, event translation, synthetic
// steer/follow-up queue, and per-capability degradation tracking. PiService holds
// a RustService | null and delegates the Rust branch of each backend-aware method
// here; the shared handleAgentEvent stays in PiService (the Rust event shapes
// mirror the TS SDK's), reached through the RustHost callback below.
//
// The RustHost interface is the explicit contract between this subsystem and the
// core: every piece of shared PiService state RustService reads or writes, and
// every core capability it calls, passes through it. That coupling always
// existed inside the god class — here it's named and visible.

import { piWarn } from "./logger.js";
import { RustProcess, RUST_RPC, type RustEvent, type RustResponse, type RustProcessOpts } from "./rust-process.js";
import { formatRustLoadError } from "./extension-errors.js";
import { normalizeRustEvent, routeRustEvent, dropQueuedMessage, promoteQueuedToSteer, checkAndRecordDegraded, clearDegraded, parseRustModels, parseRustEntries, parseRustSlashCommands, commandsReplyLooksDrifted, modelsReplyLooksDrifted, entriesReplyLooksDrifted, sessionStatsLookDrifted, tokenFieldsLookDrifted } from "./rust-events.js";
import { isRustExtensionConflict } from "./rust-interop.js";
import { formatMissingToolsNotice } from "./rust-deps.js";
import { censusSessionFile } from "./session-format.js";
import { thinkingLevelIsLive, clampThinkingLevelForRust } from "./model-catalog.js";
import { buildRuntimeIdentityPrompt } from "./runtime-identity.js";
import type { RustInstallStatus } from "./rust-resolver.js";
import type { PiServiceEvent } from "./types.js";
import { backendCapabilityDefaults, type BackendCapabilities, type PiBackend } from "./pi-backend.js";

/** A model entry for the model-cycle list (shared with PiService). */
export interface CycleModel {
  provider: string;
  id: string;
  name?: string;
  cost?: { input: number; output: number };
  contextWindow?: number;
}

/** Cumulative token/cost usage as the webview status expects it. */
export interface RustUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextPercent: number | null;
  contextWindow: number;
}

export interface RustInitResult {
  success: boolean;
  error?: string;
  errorKind?: string;
  warning?: string;
}

/**
 * The callback surface RustService needs from PiService. PiService supplies an
 * implementation (closures over its own fields) when it constructs the service.
 */
export interface RustHost {
  emit(event: PiServiceEvent): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  handleAgentEvent(event: any): void;
  reportStatus(): void;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sendInitialMessages(entries: any[]): Promise<void>;
  /** emitSettings + emitSlashCommands, after the handshake. */
  emitPostInitState(): void;
  showDialog(
    dialogType: "select" | "confirm" | "input",
    prompt: string,
    extras: { options?: string[]; defaultValue?: string },
  ): Promise<unknown> | undefined;
  // Shared PiService state RustService reads/writes. (The run/streaming flags used to live here
  // as get/setAgentRunActive + setStreaming; RustService now owns them — see PiBackend — so the
  // event loop reads its own copy without a host round-trip.)
  /** Level is owned by RustService now; this is the orchestration hook that fires when it
   *  changes (PiService remembers the last non-off level for the off→on toggle). */
  rememberReasoning(): void;
  setSessionId(id: string): void;
  getCycleModels(): CycleModel[];
  setCycleModels(list: CycleModel[]): void;
  setAutoCompactionEnabled(v: boolean): void;
  setAutoRetryEnabled(v: boolean): void;
}

/** The pi-code-gui settings RustService consumes, resolved to plain values. */
export interface RustSessionConfig {
  defaultModelProvider?: string;
  defaultModelId?: string;
  /** Resolved thinking level ("off" when unset). */
  defaultThinkingLevel: string;
  /** Resolved extension policy ("balanced" when unset). */
  rustExtensionPolicy: string;
  anthropicApiKey?: string;
  openaiApiKey?: string;
  /** Resolved context budget (0 = no budget). */
  contextBudget: number;
}

/** Environment dependencies injected into RustService — everything that would
 *  otherwise couple it to vscode (configuration, binary detection, models.json
 *  setup, session dir, host UI). PiService supplies the real implementations;
 *  tests supply stubs, which is what makes the init/handshake sequence — the most
 *  complex code in the Rust subsystem — headlessly testable. */
export interface RustDeps {
  detectBinary(): RustInstallStatus;
  shouldDisableExtensions(cwd: string): boolean;
  /** VS Code's own workspace-trust verdict for this folder. rust-pi 0.3.0 gates
   *  project-local `.pi/settings.json` packages and `.pi/extensions/` behind trust and
   *  fails closed for non-interactive launches — which every `--mode rpc` session is. */
  workspaceIsTrusted(): boolean;
  /** The rustExtensions setting mode: "auto" | "enabled" | "disabled". */
  extensionsMode(): string;
  setupModels(): { piEnv: Record<string, string>; warnings: string[] };
  sessionDir(): string;
  workspaceCwd(): string;
  /** Read the current settings (called at init and on state refresh — not cached). */
  config(): RustSessionConfig;
  /** Show a blocking error notification (models.json setup failures). */
  showError(message: string): void;
  /** Offer one-click reopen of `sessionFile` after an unexpected crash. */
  offerReopen(sessionFile: string): void;
  /** Export a session JSONL to HTML by shelling out to `pi --export`. */
  exportHtml(sessionFile: string, outputPath: string): Promise<string>;
  /** Detect rust-pi's external tool prerequisites (fd, ripgrep). Returns the missing
   *  tools (command name + its install-guide URL), or null if all present. */
  detectMissingTools(): Promise<Array<{ name: string; docs: string }> | null>;
  /** Test seam: wrap/replace RustProcess construction (defaults to the real one). */
  createProcess?(opts: RustProcessOpts): RustProcess;
}

/** How long a fetched model list is served before getAvailableModels re-queries the binary. */
const MODELS_TTL_MS = 5000;

export class RustService implements PiBackend {
  private process: RustProcess | null = null;
  private initializing = false;
  private sessionPath: string | null = null;
  private usage: RustUsage | null = null;
  private contextWindow = 0;
  private lastContextTokens = 0;
  private slashCommands: Array<{ cmd: string; desc: string; source: string }> = [];
  /** Available models from get_available_models (owned here; read via getAvailableModels). */
  private _availableModels: CycleModel[] = [];
  /** When _availableModels was last refreshed (TTL guard for getAvailableModels). */
  private _modelsFetchedAt = 0;
  /** The active model identity — OWNED here (captured from get_state/applyState), read
   *  by PiService via the PiBackend getModel() seam instead of pushed up to a host field. */
  private _model: { id?: string; name?: string; provider?: string; api?: string; reasoning?: boolean } | null = null;
  /** The active thinking level — OWNED here; PiService reads it via getThinkingLevel(). */
  private _thinkingLevel = "off";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private entries: any[] = [];
  // Synthetic steer/follow-up queue: rust-pi (0.1.18) never emits queue_update,
  // so we mirror queued messages and clear them when the binary consumes them.
  private steering: string[] = [];
  private followUp: string[] = [];
  private degradedWarned = new Set<string>();
  // NOTE: transient-error retry is intentionally NOT done here. rust-pi retries the
  // dropped provider request IN PLACE (preserving the tool-call sequence) and emits its
  // own auto_retry_start/end events, which the webview surfaces. An earlier extension-
  // side reprompt-retry corrupted agentic turns (a re-sent prompt lands after a dangling
  // assistant tool_calls → provider 400), so it was removed. The binary's classifier not
  // covering some connection drops (e.g. "closed before headers") is tracked upstream.
  /** Guard against overlapping refreshState() runs — see refreshState(). */
  private _refreshing = false;
  /** One-shot guard for the get_state RPC-shape-drift warning (a permanent structural
   *  mismatch, distinct from transient capability degradation). */
  private _shapeProbeWarned = false;

  constructor(private readonly host: RustHost, private readonly deps: RustDeps) {}

  // ── Lifecycle ──────────────────────────────────────────

  /**
   * Initialize a session backed by the Rust Pi binary (`pi --mode rpc`).
   * The subprocess owns persistence and tool execution; we drive it over the
   * line-delimited JSON RPC protocol and route its events through the host's
   * handleAgentEvent path (the event shapes mirror the TS SDK's).
   */
  /** Say so — visibly — when rust-pi reports no history for a session file that demonstrably
   *  has some. Silence here is what let a corrupted session open as an ordinary blank tab.
   *
   *  The known cause is a `session_info` entry: the extension used to append one to record the
   *  tab name, and rust-pi's loader rejects the WHOLE file over it (verified black-box against
   *  0.1.22 — one such line turns a 137-message session into zero). Writing that entry has been
   *  fixed, but files already carrying one stay unloadable, so name the cause when we see it. */
  private warnIfHistoryWasNotLoaded(loaded: number): void {
    if (loaded > 0 || !this.sessionPath) { return; }
    const census = censusSessionFile(this.sessionPath);
    if (!census || census.messages === 0) { return; } // genuinely empty: nothing to report
    const cause = census.legacyNameEntries > 0
      ? " The cause is a `session_info` entry an older build of this extension appended to record the tab name — rust-pi's loader rejects the entire file over it."
      : "";
    const content = `⚠ This session's history did not load. The file on disk still holds ${census.messages} message${census.messages === 1 ? "" : "s"}, but the Rust runtime reported none, so the conversation above is missing AND the model has no context from it.${cause} Your transcript is intact on disk at ${this.sessionPath}`;
    piWarn(`Rust history not loaded: ${census.messages} messages on disk, 0 reported (legacy session_info entries: ${census.legacyNameEntries}) — ${this.sessionPath}`);
    this.host.emit({ type: "custom-message", data: { customType: "error", content, timestamp: Date.now() } });
  }

  async initialize(opts: { fresh?: boolean; openPath?: string }): Promise<RustInitResult> {
    this.initializing = true;
    try {
      return await this.initializeInner(opts);
    } finally {
      this.initializing = false;
    }
  }

  private async initializeInner(opts: { fresh?: boolean; openPath?: string }): Promise<RustInitResult> {
    const fresh = opts.fresh ?? false;
    const openPath = opts.openPath;
    // Reset per-session usage so a re-init (e.g. /new) starts clean.
    this.usage = null;
    this.lastContextTokens = 0;
    this.steering = [];
    this.followUp = [];
    this.degradedWarned.clear();

    const status = this.deps.detectBinary();
    if (!status.installed || !status.binaryPath) {
      return { success: false, error: status.error ?? "Rust Pi binary not found." };
    }

    const cwd = this.deps.workspaceCwd();
    const cfg = this.deps.config();

    // Build RPC args (flags verified against the v0.1.18 binary's README).
    const args = ["--mode", "rpc", "--session-dir", this.deps.sessionDir()];
    if (openPath) { args.push("--session", openPath); }
    else if (!fresh) { args.push("--continue"); }
    const provider = cfg.defaultModelProvider?.trim();
    const modelId = cfg.defaultModelId?.trim();
    // Apply the DEFAULT model only to a fresh session. A restored (--session) or
    // continued (--continue) session carries its own recorded provider/model in
    // its file; overriding with the setting would silently switch its model on
    // reopen (e.g. a deepseek-v4-pro session reopening as deepseek-chat).
    const restoring = !!openPath || !fresh;
    // Clamp against the DETECTED binary: `--thinking max` is rejected during argument parsing
    // by a pre-#139 build, which exits 2 before any RPC exists — the session never starts.
    const thinking = clampThinkingLevelForRust(cfg.defaultThinkingLevel?.trim() || "off", status.version);
    if (!restoring) {
      if (provider) { args.push("--provider", provider); }
      if (modelId) { args.push("--model", modelId); }
      // Always pass --thinking for a FRESH session, INCLUDING "off": rust-pi
      // defaults a reasoning model to "high" when the flag is absent (verified
      // live against 0.1.20), so omitting it for "off" would start the model
      // thinking at "high" against the configured default. A restored/continued
      // session carries its own recorded level (like model/provider above) and
      // get_state then syncs the display — so don't force the flag there.
      args.push("--thinking", thinking);
    }
    // Tell the session what it is running on. A Rust session cannot work this out for itself —
    // the workspace, session dir and process table look identical to a TypeScript session's, and
    // a reviewer that guessed from `ps` picked up ANOTHER session's rust-pi and misreported
    // itself. Same builder as the SDK path, so the two can never tell different stories.
    args.push("--append-system-prompt", buildRuntimeIdentityPrompt({
      runtime: "rust",
      model: provider && modelId ? { provider, id: modelId } : null,
      backendVersion: status.version?.match(/\d+\.\d+\.\d+/)?.[0],
    }));
    args.push("--extension-policy", cfg.rustExtensionPolicy?.trim() || "balanced");

    // rust-pi 0.3.0 gates project-local `.pi/settings.json` packages and `.pi/extensions/`
    // behind workspace trust, and a NON-INTERACTIVE launch — which `--mode rpc` always is —
    // fails closed. Measured against the real 0.3.0 binary: the process still starts and RPC
    // still answers, so this is not a crash. The project-local config is simply skipped, and
    // the only announcement is a stderr line that classifyRustLoadError does not recognise —
    // so it lands in the log via the generic `[rust-stderr]` path and never reaches the user.
    //
    // Defer to VS Code's verdict instead of prompting again: the user has already answered
    // this exact question for this folder, and package.json already declares
    // `capabilities.untrustedWorkspaces`. An untrusted workspace deliberately gets NO flag —
    // failing closed is correct there, not a regression to paper over.
    //
    // Safe on older binaries: 0.1.20 and 0.3.0 both IGNORE unknown flags (verified by spawning
    // each with a bogus one — RPC came up clean, stderr empty), so this needs no version gate
    // and a user pinned to an older build is unaffected.
    if (this.deps.workspaceIsTrusted()) { args.push("--trust"); }

    // Extension discovery. The Rust binary aborts `--mode rpc` startup when it
    // meets the workspace's TypeScript-SDK `.pi/` extensions (it wants its own
    // tool-manifest shape: `missing field 'parameters'`). Per the rustExtensions
    // setting we disable discovery up front ("disabled", or "auto" when those
    // extensions are detected); the catch below is the safety net for the rest.
    let noExtensions = this.deps.shouldDisableExtensions(cwd);
    if (noExtensions) { args.push("--no-extensions"); }

    // Inherit env + runtime API-key overrides so Rust can authenticate.
    const env: NodeJS.ProcessEnv = { ...process.env };
    if (cfg.anthropicApiKey) { env.ANTHROPIC_API_KEY = cfg.anthropicApiKey; }
    if (cfg.openaiApiKey) { env.OPENAI_API_KEY = cfg.openaiApiKey; }

    // Model catalog: override the Rust binary's stale built-in model list with the
    // bundled Pi catalog (writes models.json in the relocated agent home). Never
    // silent — fatal problems (unwritable dir) become a loud error + notification;
    // softer ones (an auth-seed miss) become chat warnings.
    try {
      const { piEnv, warnings } = this.deps.setupModels();
      Object.assign(env, piEnv);
      for (const w of warnings) {
        this.host.emit({ type: "custom-message", data: { customType: "error", content: `⚠ ${w}`, timestamp: Date.now() } });
      }
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e);
      piWarn(`Rust custom-models setup failed: ${m}`);
      this.host.emit({ type: "custom-message", data: { customType: "error", content: `⚠ Custom models for Rust couldn't be configured — ${m}`, timestamp: Date.now() } });
      this.deps.showError(`Pi Code Gui: ${m}`);
      // Continue: built-in models still work; an unresolved model is caught below.
    }

    this._thinkingLevel = thinking; this.host.rememberReasoning();

    let warning: string | undefined;
    try {
      await this.spawn(status.binaryPath, args, cwd, env);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      // Recover only from the extension-parse conflict, and only when we did NOT
      // already disable extensions. In "auto" mode we self-heal (retry with
      // discovery off + warn); when the user explicitly set "enabled" we respect
      // that and surface an actionable error that points to the setting.
      if (isRustExtensionConflict(msg) && !noExtensions && this.deps.extensionsMode() === "auto") {
        piWarn("Rust start hit a TS-extension conflict; retrying with --no-extensions");
        args.push("--no-extensions");
        noExtensions = true;
        warning = "rust-extensions-auto-disabled";
        try {
          await this.spawn(status.binaryPath, args, cwd, env);
        } catch (e2: unknown) {
          const msg2 = e2 instanceof Error ? e2.message : String(e2);
          // dispose() BEFORE dropping the reference: spawn() rejects on the readiness-probe
          // timeout while the child is still ALIVE, and nulling the handle first orphans it
          // (initializeRust also nulls PiService._rust on failure, so the Retry path's
          // dispose() has nothing left to kill). The orphan lingers holding its fds, its
          // --session-dir, and the SQLite index. Mirrors the handshake-failure paths below.
          this.process?.dispose();
          this.process = null;
          return { success: false, error: `Failed to start Rust Pi: ${msg2}`, errorKind: isRustExtensionConflict(msg2) ? "rust-extension-conflict" : undefined };
        }
      } else {
        this.process?.dispose(); // same orphan risk as above — kill before dropping the handle
        this.process = null;
        return { success: false, error: `Failed to start Rust Pi: ${msg}`, errorKind: isRustExtensionConflict(msg) ? "rust-extension-conflict" : undefined };
      }
    }

    this.sessionPath = openPath ?? null;

    // spawn succeeded above, so the process is live for the handshake.
    const proc = this.process!;

    // Handshake: state → models → history.
    // get_state doubles as the liveness check: if the process crashed during or
    // right after spawn, its pending request is rejected (or the call times out),
    // and we fail init here instead of returning success on a dead subprocess.
    // (handleExit swallows the crash itself while `initializing` is set.)
    try {
      const state = await proc.request(RUST_RPC.getState, {}, 15000);
      if (state.success) {
        this.applyState(state.data);
        // Shape probe: the extension is coupled to the pinned binary's RPC field
        // names with no version negotiation. If the reply lacks the fields every
        // tested version (0.1.18–87b70f74) carries, the shape has drifted — say so
        // once instead of degrading into scattered per-capability oddities.
        const d = (state.data ?? {}) as { model?: { id?: unknown }; activeModel?: unknown; thinkingLevel?: unknown; thinking?: unknown };
        // A drifted RPC SHAPE is a permanent structural mismatch, not a transient
        // capability degradation (which can recover and re-warn) — so it uses its own
        // one-shot flag rather than the warnDegraded/recordCapOk tracker.
        if (!this._shapeProbeWarned && (!(d.model?.id ?? d.activeModel) || (d.thinkingLevel ?? d.thinking) === undefined)) {
          this._shapeProbeWarned = true;
          this.host.emit({ type: "custom-message", data: { customType: "error", content: "Rust Pi's get_state reply is missing expected fields (model/thinkingLevel) — the binary's RPC shape may have drifted from the version this extension was tested against. Status readouts may be wrong; consider matching the pinned Rust Pi version.", timestamp: Date.now() } });
        }
      }
    } catch (e: unknown) {
      const m = e instanceof Error ? e.message : String(e);
      piWarn(`Rust get_state failed: ${m}`);
      this.process?.dispose();
      this.process = null;
      return { success: false, error: `Rust Pi started but did not respond (${m}). The binary may have crashed on startup — check the Pi Code Gui output channel.` };
    }
    if (!proc.isAlive()) {
      piWarn("Rust process exited during initialization handshake");
      this.process?.dispose();
      this.process = null;
      return { success: false, error: "Rust Pi exited during initialization. Check the Pi Code Gui output channel for the binary's stderr." };
    }

    try {
      const models = await proc.request(RUST_RPC.getAvailableModels, {}, 15000);
      const list = parseRustModels(models.data);
      if (models.success && list.length > 0) { this._availableModels = list; this._modelsFetchedAt = Date.now(); this.host.setCycleModels(list); this.recordCapOk("models"); }
      else {
        // Distinguish "genuinely no models" from "entries arrived but none parsed" (a shape
        // rename would otherwise silently empty the picker behind the generic notice).
        if (modelsReplyLooksDrifted(models.data)) {
          piWarn("get_available_models returned entries that parsed to 0 models — rust-pi's model shape may have drifted (see parseRustModels).");
        }
        this.warnDegraded("models", "Rust Pi returned no model list — model switching (/model) may be unavailable this session.");
      }
    } catch (e: unknown) {
      piWarn(`Rust get_available_models failed: ${e instanceof Error ? e.message : String(e)}`);
      this.warnDegraded("models", "Couldn't load the Rust model list — model switching (/model) may be unavailable this session.");
    }

    try {
      const msgs = await proc.request(RUST_RPC.getMessages, {}, 15000);
      const entries = parseRustEntries(msgs.data);
      // A reply that still carries messages but parsed to nothing means the history shape
      // drifted — otherwise resume just renders an empty conversation with no signal.
      if (entries.length === 0 && entriesReplyLooksDrifted(msgs.data)) {
        piWarn("get_messages returned entries that parsed to 0 messages — rust-pi's history shape may have drifted (see parseRustEntries).");
      }
      // Reconcile against the file on disk. A well-formed EMPTY reply is indistinguishable from a
      // genuinely new session, so the drift probe above stays silent — which is exactly how the
      // extension came to open resumed sessions as blank tabs with no signal at all. If the file
      // holds messages the runtime says it loaded none of, that is never normal: say so, loudly,
      // and name the count so the transcript is visibly still there.
      this.warnIfHistoryWasNotLoaded(entries.length);
      this.entries = entries;
      this.captureContextFromMessages(msgs.data);
      this.host.emit({ type: "batch-start", data: { hasEntries: entries.length > 0 } });
      await this.host.sendInitialMessages(entries);
      this.host.emit({ type: "batch-end", data: { hasEntries: entries.length > 0 } });
      this.recordCapOk("history");
    } catch (e: unknown) {
      piWarn(`Rust get_messages failed: ${e instanceof Error ? e.message : String(e)}`);
      this.warnDegraded("history", "Couldn't load this session's history from Rust Pi — earlier messages may not be shown (the session file on disk is intact).");
    }

    // The Rust session advertises its own commands/templates/skills — surface
    // them in the slash-command list instead of the TypeScript SDK's.
    try {
      const cmds = await proc.request(RUST_RPC.getCommands, {}, 8000);
      if (cmds.success) {
        this.slashCommands = parseRustSlashCommands(cmds.data);
        // Warn only on genuine drift — command entries we failed to recognize — NOT on a
        // legitimately empty list. rust-pi advertises `{commands: []}` when it has no session
        // commands (verified against v0.1.22 via a black-box RPC probe); the old
        // Object.keys()>0 check treated that well-formed empty reply as drift and warned on
        // every start. commandsReplyLooksDrifted distinguishes the two.
        if (this.slashCommands.length === 0 && commandsReplyLooksDrifted(cmds.data)) {
          piWarn("get_commands returned command entries that parsed to 0 slash commands — rust-pi's command shape may have drifted (see parseRustSlashCommands).");
        }
        this.recordCapOk("commands");
      }
    } catch (e: unknown) {
      piWarn(`Rust get_commands failed: ${e instanceof Error ? e.message : String(e)}`);
      this.warnDegraded("commands", "Couldn't load Rust Pi's slash commands — its session-specific commands may be missing from the list.");
    }

    await this.refreshUsage();
    this.host.reportStatus();
    try { this.host.emitPostInitState(); }
    catch (e: unknown) { piWarn(`Post-init emissions failed: ${e instanceof Error ? e.message : String(e)}`); }

    // Loud failure on an unresolved model. An invalid `defaultModelId` (e.g. the
    // non-existent "deepseek-v4-pro") leaves the Rust session with no active model
    // and otherwise SILENTLY inert — every prompt/command no-ops. Surface it.
    if (!this._model) {
      const valid = this.host.getCycleModels().slice(0, 8).map((m) => m.id).join(", ");
      const want = restoring
        ? "this session's recorded model"
        : (modelId ? `"${modelId}"${provider ? ` (provider "${provider}")` : ""}` : "your configured model");
      const content = `⚠ No model is active — ${want} could not be resolved, so this Rust session can't run. Pick a valid model with \`/model\`${valid ? ` (e.g. ${valid})` : ""}, or fix the \`pi-code-gui.defaultModelId\` setting.`;
      piWarn(`Rust session has no resolved model (configured: ${provider ?? "?"}/${modelId ?? "?"})`);
      this.host.emit({ type: "custom-message", data: { customType: "error", content, timestamp: Date.now() } });
    }

    // Proactively surface missing external tool prerequisites (fd/ripgrep) once per
    // host — rust-pi's find/grep tools shell out to them, and a manual install (not the
    // managed one, which checks) would otherwise only fail mid-session as a raw tool
    // error. Fire-and-forget so it never delays session readiness.
    if (!RustService._toolDepsWarned) {
      void this.deps.detectMissingTools().then((missing) => {
        if (!missing || missing.length === 0 || RustService._toolDepsWarned) { return; }
        RustService._toolDepsWarned = true;
        // formatMissingToolsNotice is docs-only — it names the missing tools and links
        // each one's authoritative per-OS install guide (no synthesized shell command).
        // Correct on every OS and copy-paste-safe even before `marked` loads. See contract.
        const content = formatMissingToolsNotice(missing);
        this.host.emit({ type: "custom-message", data: { customType: "info", content, timestamp: Date.now() } });
      }).catch(() => { /* detection is best-effort */ });
    }

    return { success: true, warning };
  }

  /** One-per-host guard for the missing-fd/rg proactive notice. */
  private static _toolDepsWarned = false;
  /** One-per-host guard: show the full "/compact differs under Rust" explanation once. */
  private static _compactGateExplained = false;
  /** One-per-host guard: warn once that a Rust auto-retry re-runs and re-bills the turn. */
  private static _autoRetryRebillWarned = false;

  /** Spawn (or re-spawn) the Rust RPC subprocess, disposing any prior one first. */
  private async spawn(binaryPath: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
    this.process?.dispose();
    const createProcess = this.deps.createProcess ?? ((o: RustProcessOpts) => new RustProcess(o));
    this.process = createProcess({
      binaryPath, args, cwd, env,
      onEvent: (e: RustEvent) => this.handleEvent(e),
      onExit: (code: number | null) => this.handleExit(code),
      // Surface a failed extension/skill load once, as an in-chat notice — users
      // can't be expected to read raw stderr, and we can't control which
      // extensions they have installed. Deduped upstream in RustProcess.
      onLoadError: (e) => this.host.emit({
        type: "custom-message",
        data: { customType: "error", content: `⚠ ${formatRustLoadError(e)}`, timestamp: Date.now() },
      }),
      // Confirm startup by a real get_state round-trip rather than a blind timer.
      readyCommand: RUST_RPC.getState,
    });
    await this.process.spawn();
  }

  /** Tear down the subprocess (it owns its own persistence). */
  dispose(): void {
    this.steering = [];
    this.followUp = [];
    this.process?.dispose();
    this.process = null;
  }

  // ── Event ingress ──────────────────────────────────────

  /** Route a raw Rust RPC event: intercept UI/errors, delegate the rest to the
   *  host's handleAgentEvent. The routing/dedupe/queue-clear DECISIONS live in
   *  the pure, unit-tested routeRustEvent (src/rust-events.ts); this shell just
   *  executes the resulting plan against vscode/PiService state. */
  private handleEvent(event: RustEvent): void {
    normalizeRustEvent(event);
    // One-time (per host): rust-pi's auto-retry restarts the WHOLE turn on a transient
    // provider error — re-running and RE-BILLING every tool call, not just re-issuing the
    // failed request (confirmed 2026-07-07: one prompt → 4 fully-executed, separately-billed
    // runs on a flaky provider; auto-retry off → a single clean failure, no duplication).
    // The retry spinner alone doesn't convey the cost consequence, so surface it once so a
    // multiplied bill is never silent. Turning off Auto-retry avoids it; the re-execution
    // itself is a rust-pi behaviour tracked upstream.
    if (event?.type === "auto_retry_start" && !RustService._autoRetryRebillWarned) {
      RustService._autoRetryRebillWarned = true;
      this.host.emit({ type: "custom-message", data: { customType: "info", content: "⚠ Auto-retry restarted this turn after a transient provider error. On the Rust runtime a retry re-runs the whole turn, so each attempt is billed again — a flaky provider can multiply the cost. Turn off Auto-retry in settings to avoid this (the re-run behaviour is tracked upstream).", timestamp: Date.now() } });
    }
    const queueNonEmpty = this.steering.length > 0 || this.followUp.length > 0;
    // routeRustEvent reads agentRunActive BEFORE handleAgentEvent clears it, so
    // the isRealAgentEnd dedupe sees the pre-delegate flag — a duplicate
    // agent_end won't trigger a second state re-sync.
    const routing = routeRustEvent(event, queueNonEmpty, this._agentRunActive);
    // rust-pi never emits queue_update; when it consumes a queued steer/
    // follow-up the message reappears here as a user turn — drop it from the
    // synthetic queue so the pending indicator clears.
    if (routing.dropQueuedText !== null && this.dropQueued(routing.dropQueuedText)) {
      this.emitQueue();
    }
    if (routing.captureSessionId) { this.host.setSessionId(routing.captureSessionId); }
    switch (routing.action) {
      case "ui-request":
        void this.handleUiRequest(event);
        return;
      case "extension-error":
        this.host.emit({ type: "custom-message", data: { customType: "error", content: `Extension error: ${event.error ?? ""}`, timestamp: Date.now() } });
        return;
      case "delegate":
        break;
    }
    try {
      this.host.handleAgentEvent(event);
    } catch (e: unknown) {
      piWarn(`handleEvent(${event?.type}): ${e instanceof Error ? e.message : String(e)}`);
    }
    // Mid-turn live tokens/cost: ACCUMULATE each assistant message's own usage rather
    // than re-polling get_session_stats — which lags, since it only counts PERSISTED
    // messages (the `pending` backlog stayed >0 mid-turn, so tokens read 0 until the
    // turn ended). The message_end EVENT carries the real per-round usage (the same
    // source context% already trusts via captureContext), so summing it climbs live.
    // agent_end's refreshState then SNAPS this.usage to the authoritative cumulative,
    // correcting any drift. (cost is recomputed from tokens × catalog rates in PiService.)
    if (event?.type === "message_end" && (event as { message?: { role?: string } }).message?.role === "assistant") {
      // rust-pi v0.1.22 delivers per-message usage here as
      // {input,output,cacheRead,cacheWrite,totalTokens,cost} (confirmed via a debug probe), so
      // this live per-round accumulate is what climbs the cost mid-run. Keep it the ONLY mid-run
      // usage writer — see the no-mid-run-refresh note at the agent_settled snap below.
      const mu = (event as { message?: { usage?: unknown } }).message?.usage;
      if (mu && typeof mu === "object") {
        // Secondary drift net on the live path: a usage object without numeric token fields
        // means a rename — accumulate would silently add 0 and the live cost would stall. Warn
        // once (a distinct, never-cleared cap so it doesn't flap with the authoritative "usage").
        if (tokenFieldsLookDrifted(mu)) {
          this.warnDegraded("usage-shape", "A Rust assistant message carried usage without the expected numeric token fields — the live cost estimate may be stuck; the usage wire-shape may have drifted.");
        } else {
          this.accumulateUsage(mu as Record<string, unknown>); this.host.reportStatus();
        }
      }
    }
    // After a turn, re-sync state so the (now-written) session file path,
    // model, and settings are captured for status + reload persistence.
    //
    // DO NOT refresh authoritative usage mid-run (e.g. on turn_end): get_session_stats only
    // counts PERSISTED messages, so it reads ~0 during an active turn (the pending backlog),
    // and applyUsage REPLACES this.usage wholesale — a mid-run refresh therefore WIPES the live
    // accumulate above back toward zero, hiding the cost until the very end. The authoritative
    // snap belongs only at a terminal event, where the stats have settled. Live mid-run cost is
    // the accumulate path's job (and is why TS, which re-sums entries per read, shows it fine).
    if (routing.isRealAgentEnd) { void this.refreshState(); }
    // agent_settled (v0.1.22) is the terminal "run fully settled" event, emitted after the
    // agent_end pair. Snap authoritatively here too: it's NOT gated on the agentRunActive
    // dedupe, so even if a duplicate agent_end latched the flag false and starved the
    // isRealAgentEnd refresh above, the final cost/token total still lands. Terminal, so the
    // stats have settled; refreshState's own _refreshing guard drops a redundant overlap with
    // an in-flight agent_end refresh. THIS is the real fix for the "cost froze after an
    // abort/retry" report — not a mid-run refresh.
    if (event?.type === "agent_settled") { void this.refreshState(); }
  }

  /** Surface an unexpected Rust subprocess exit in the chat. */
  /** Exit code of a crashed subprocess, so the "why can't I type?" error can say what happened
   *  instead of the misleading "not initialized". */
  private _exitCode: number | null | undefined;

  /** Message for a primitive invoked after the subprocess is gone. */
  private deadSessionMessage(): string {
    return this._exitCode !== undefined
      ? `Rust Pi is no longer running (it exited with code ${this._exitCode ?? "?"}). Run /new to start a fresh session.`
      : "Rust Pi session not initialized";
  }

  private handleExit(code: number | null): void {
    // A spawn failure during initialization (e.g. the extension-parse conflict)
    // is reported through initialize's return value — don't also surface the
    // generic "exited unexpectedly" message, which would race the recovery path.
    if (this.initializing) {
      piWarn(`Rust process exited during init (code ${code ?? "?"})`);
      return;
    }
    this._isStreaming = false;
    this._agentRunActive = false;
    // Clear any pending steer/queue indicator — the process that owned it is gone.
    if (this.steering.length || this.followUp.length) {
      this.steering = [];
      this.followUp = [];
      this.emitQueue();
    }
    const file = this.sessionPath;
    // Drop the dead process. Without this the session becomes a ZOMBIE: `initialized` stays
    // true, the webview keeps accepting input, and every subsequent prompt dies inside
    // RustProcess.writeLine at the `stdin.writable` check with only a debug line — the user
    // types into a session that is gone and sees nothing at all. Nulling it makes the primitives'
    // existing `if (!this.process)` guards fire instead, which surfaces a real error card.
    this._exitCode = code;
    try { this.process?.dispose(); } catch { /* already dead */ }
    this.process = null;
    this.host.emit({ type: "custom-message", data: { customType: "error", content: `Rust Pi exited unexpectedly (code ${code ?? "?"}).${file ? "" : " Start a new session to continue."}`, timestamp: Date.now() } });
    this.host.reportStatus();
    // The session JSONL persists on disk and rust-pi self-exits on stdin EOF (so
    // this is a real crash, not host teardown). Offer one-click recovery into a
    // fresh window via the existing resume flow — avoids in-place re-init (which
    // would replay history into the dead tab) and crash-loops (user-initiated).
    if (file) { this.deps.offerReopen(file); }
  }

  /** Map a Rust `extension_ui_request` onto the host's webview dialog/widget bridge. */
  private async handleUiRequest(req: RustEvent): Promise<void> {
    const method = String(req.method ?? "");
    const id = typeof req.id === "string" ? req.id : undefined;
    try {
      switch (method) {
        case "notify": {
          const isError = req.notifyType === "error" || req.notifyType === "warning";
          this.host.emit({ type: "custom-message", data: { customType: isError ? "error" : "extension-notify", content: String(req.message ?? ""), timestamp: Date.now() } });
          return;
        }
        case "setStatus": {
          const text = req.statusText;
          const empty = text === null || text === undefined;
          this.host.emit({ type: "widget-update", data: { key: `status-${req.statusKey}`, content: empty ? null : `**${req.statusKey}** ${text}` } });
          return;
        }
        case "setWidget": {
          const lines = Array.isArray(req.widgetLines) ? (req.widgetLines as string[]) : [];
          this.host.emit({ type: "widget-update", data: { key: String(req.widgetKey ?? "widget"), content: lines.length ? lines.join("\n") : null } });
          return;
        }
        case "select":
        case "confirm":
        case "input":
        case "editor": {
          const dialogType = method === "editor" ? "input" : method;
          const prompt = String(req.title ?? req.message ?? "");
          // Normalize select options: a Rust extension may send plain strings or
          // {value,label} objects. Show labels, but map the choice back to the
          // option's `value` so the binary's extension_ui_response matcher (which
          // compares the reply against an option's value/label) accepts it.
          let optionLabels: string[] | undefined;
          // Preserve each option's ORIGINAL value type (number/bool/string): the
          // binary matches the reply against the raw JSON value, so String()-
          // coercing a numeric/bool value would make Number(1) != "1" and the pick
          // would be rejected. (Duplicate labels collapse to the last value — a
          // degenerate input the pre-fix code failed on entirely.)
          const labelToValue = new Map<string, unknown>();
          if (Array.isArray(req.options)) {
            optionLabels = req.options.map((o) => {
              if (o && typeof o === "object") {
                const obj = o as Record<string, unknown>;
                const label = String(obj.label ?? obj.value ?? "");
                labelToValue.set(label, obj.value ?? obj.label ?? label);
                return label;
              }
              const s = String(o);
              labelToValue.set(s, s);
              return s;
            });
          }
          const pending = this.host.showDialog(dialogType, prompt, {
            options: optionLabels,
            defaultValue: (req.defaultValue ?? req.prefill) as string | undefined,
          });
          const chosen = pending ? await pending : undefined;
          if (id) {
            if (chosen === undefined || chosen === null) {
              this.process?.send(RUST_RPC.extensionUiResponse, { id, cancelled: true });
            } else if (method === "confirm") {
              this.process?.send(RUST_RPC.extensionUiResponse, { id, confirmed: !!chosen });
            } else {
              const value = labelToValue.has(String(chosen)) ? labelToValue.get(String(chosen)) : chosen;
              this.process?.send(RUST_RPC.extensionUiResponse, { id, value });
            }
          }
          return;
        }
        default:
          // setTitle / set_editor_text and other fire-and-forget methods: no-op for v1.
          return;
      }
    } catch (e: unknown) {
      piWarn(`handleUiRequest(${method}) failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  // ── State sync ─────────────────────────────────────────

  /** Re-query Rust `get_state` (e.g. after a turn) to capture sessionFile/model/settings. */
  async refreshState(): Promise<void> {
    // Concurrency guard: refreshState() fires post-turn (fire-and-forget on
    // agent_end) AND from compact(); without this they can overlap, and a stale
    // get_state's applyState could clobber a newer one. Skip a redundant refresh
    // while one is already in flight (the in-flight run captures the latest state).
    if (!this.process || this._refreshing) { return; }
    this._refreshing = true;
    try {
      try {
        const state = await this.process.request(RUST_RPC.getState, {}, 8000);
        if (state.success) { this.applyState(state.data); this.recordCapOk("status"); }
      } catch (e: unknown) {
        piWarn(`refreshState failed: ${e instanceof Error ? e.message : String(e)}`);
        this.warnDegraded("status", "Couldn't sync Rust Pi's status — the model/context readout may be stale.");
      }
      await this.refreshUsage();
      // Emit status the moment model + usage are known. Critically this is BEFORE
      // refreshEntries: that history pull (get_messages + parse) grows with the
      // session and, while it ran under the concurrency guard, the next turn's
      // refreshState would hit `_refreshing` and return early — so the token/cost/%
      // readout stayed at its init value during active use and only "caught up" once
      // the conversation went idle and a refresh finally finished uninterrupted.
      this.host.reportStatus();
    } finally {
      this._refreshing = false;
    }
    // Entries feed ONLY the Open Sessions tree, never the status bar — refresh them
    // OUTSIDE the guard so a slow history parse can't block the next turn's status.
    await this.refreshEntries();
  }

  /** Re-pull the Rust session's entries so the Open Sessions tree reflects new turns. */
  private async refreshEntries(): Promise<void> {
    if (!this.process) { return; }
    try {
      const msgs = await this.process.request(RUST_RPC.getMessages, {}, 8000);
      if (msgs.success) { this.entries = parseRustEntries(msgs.data); this.recordCapOk("history"); }
    } catch (e: unknown) {
      piWarn(`refreshEntries failed: ${e instanceof Error ? e.message : String(e)}`);
      this.warnDegraded("history", "Couldn't refresh this session's history from Rust Pi — the Open Sessions list may not reflect the latest turn.");
    }
  }

  /** Pull cumulative token/cost usage from the Rust subprocess (get_session_stats). */
  private async refreshUsage(): Promise<void> {
    if (!this.process) { return; }
    // Never take the authoritative snap while a turn is active. get_session_stats only counts
    // PERSISTED messages, so mid-turn it reads ~0, and applyUsage replaces this.usage wholesale
    // — a mid-run refresh would WIPE the live accumulate toward zero. The terminal snaps
    // (agent_end / agent_settled) run with the run flag already cleared, so they're unaffected;
    // this guards the one remaining mid-turn caller, compact() → refreshState() → refreshUsage().
    if (this._agentRunActive) { return; }
    try {
      const r = await this.process.request(RUST_RPC.getSessionStats, {}, 8000);
      if (r.success) {
        // A `success` reply whose token fields aren't numeric means the usage wire-shape drifted
        // (field rename/move). Warn instead of applying — otherwise every token reads 0 and the
        // status bar shows a silent "$0.00" on a billing session. Mirrors the get_state probe.
        if (sessionStatsLookDrifted(r.data)) {
          this.warnDegraded("usage", "Rust Pi's usage reply is missing the expected numeric token fields — its usage wire-shape may have drifted, so the cost readout could be wrong or $0. Check for a rust-pi update.");
        } else {
          this.applyUsage(r.data); this.recordCapOk("usage");
        }
      }
    } catch (e: unknown) {
      piWarn(`refreshUsage failed: ${e instanceof Error ? e.message : String(e)}`);
      this.warnDegraded("usage", "Couldn't read Rust Pi's token/cost usage — the usage readout may be missing or stale.");
    }
  }

  private applyUsage(data: unknown): void {
    if (!data || typeof data !== "object") { return; }
    const d = data as Record<string, unknown>;
    const t = (d.tokens && typeof d.tokens === "object" ? d.tokens : {}) as Record<string, unknown>;
    const n = (v: unknown): number => (typeof v === "number" ? v : 0);
    const cw = this.contextWindow;
    const ctx = this.lastContextTokens;
    this.usage = {
      input: n(t.input), output: n(t.output),
      cacheRead: n(t.cacheRead), cacheWrite: n(t.cacheWrite),
      cost: n(d.cost),
      contextWindow: cw,
      // Current context fill = latest turn's input(+cacheRead) over the window.
      contextPercent: (cw > 0 && ctx > 0) ? Math.min(100, (ctx / cw) * 100) : null,
    };
  }

  /** Record the latest turn's input(+cacheRead) tokens as the current context fill. */
  captureContext(usage: unknown): void {
    if (!usage || typeof usage !== "object") { return; }
    const u = usage as Record<string, unknown>;
    const n = (v: unknown): number => (typeof v === "number" ? v : 0);
    const ctx = n(u.input) + n(u.cacheRead);
    if (ctx > 0) { this.lastContextTokens = ctx; }
  }

  /** On resume, seed the context fill from the last assistant message's usage. */
  private captureContextFromMessages(data: unknown): void {
    const d = data as { messages?: unknown } | undefined;
    const messages = Array.isArray(d?.messages) ? d.messages : (Array.isArray(data) ? data : []);
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i] as { role?: string; usage?: unknown } | undefined;
      if (m?.role === "assistant" && m.usage) { this.captureContext(m.usage); return; }
    }
  }

  /** Apply a Rust `get_state` response to model/thinking/session fields (shared
   *  state via the host; the context window + on-disk path are owned here). */
  applyState(data: unknown): void {
    if (!data || typeof data !== "object") { return; }
    const d = data as Record<string, unknown>;
    // Field-name tolerance, annotated per version so future drift is diagnosable:
    // every live-tested binary (0.1.18 → 87b70f74) sends `model` and `thinkingLevel`
    // (verified via get_state probes). The `activeModel`/`thinking` alternates have
    // NOT been observed in any tested version — they are pure drift tolerance, and
    // the init-time shape probe warns when neither primary field is present.
    const model = (d.model ?? d.activeModel) as { id?: string; name?: string; provider?: string; contextWindow?: number; api?: string; reasoning?: boolean } | undefined;
    if (model && typeof model === "object") {
      // Carry `api` (the provider transport) and `reasoning` through: the GUI uses
      // them to tell whether the thinking level is actually transmitted on this
      // transport (only some serialize it) vs a display-only no-op.
      this._model = { id: model.id, name: model.name, provider: model.provider, api: model.api, reasoning: model.reasoning };
      if (typeof model.contextWindow === "number") {
        // Clamp the displayed context window to the user's context budget so the
        // context-% readout honours the budget for EVERY Rust model — including
        // built-in (static-registry) models, which never pass through models.json
        // and so can't be clamped at the source the way custom models are.
        //
        // Limitation / compromise: this clamp only affects the GUI's context-%
        // display. The binary's real auto-compaction trigger is should_compact()
        // = contextTokens > contextWindow − reserveTokens, evaluated against the
        // model's OWN contextWindow inside the Rust process. For CUSTOM models we
        // also bake the budget into models.json (see rust-models.ts applyManaged-
        // Models), so the binary compacts at the budget too — full parity with TS.
        // For BUILT-IN models we cannot lower that window without writing a
        // models.json entry that SHADOWS the built-in (which would replace the
        // provider's other models), so the binary keeps auto-compacting at the
        // registry window. Net result: the budget governs the % display
        // everywhere and real compaction for custom models; built-in models' real
        // compaction remains at their registry window. This was a deliberate
        // trade-off to avoid shadowing built-ins for a display-parity gain.
        const budget = this.deps.config().contextBudget;
        this.contextWindow = budget > 0 ? Math.min(model.contextWindow, budget) : model.contextWindow;
      }
    } else if (typeof d.modelId === "string") {
      this._model = { id: d.modelId, provider: typeof d.provider === "string" ? d.provider : undefined };
    }
    const thinking = (d.thinkingLevel ?? d.thinking) as string | undefined;
    if (typeof thinking === "string") { this._thinkingLevel = thinking; this.host.rememberReasoning(); }
    if (typeof d.sessionId === "string") { this.host.setSessionId(d.sessionId); }
    // Field names verified against the real binary's get_state response.
    if (typeof d.autoCompactionEnabled === "boolean") { this.host.setAutoCompactionEnabled(d.autoCompactionEnabled); }
    if (typeof d.autoRetryEnabled === "boolean") { this.host.setAutoRetryEnabled(d.autoRetryEnabled); }
    // Capture the on-disk session file (may be null until the first turn writes it)
    // so fresh Rust sessions can be persisted and restored on reload.
    if (typeof d.sessionFile === "string") { this.sessionPath = d.sessionFile; }
  }

  // Response parsing (parseRustModels/parseRustEntries/parseRustSlashCommands)
  // lives in rust-events.ts so it's pure + unit-tested.

  // ── Synthetic steer/follow-up queue ────────────────────

  /** Send a prompt/steer/follow-up to the Rust subprocess. */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async sendPrompt(text: string, images?: any[], mode?: string): Promise<void> {
    if (!this.process) { throw new Error(this.deadSessionMessage()); }
    const imgs = images && images.length > 0 ? images : undefined;
    const payload: Record<string, unknown> = { message: text };
    if (imgs) { payload.images = imgs; }
    if (mode === "steer") {
      this.process.send(RUST_RPC.steer, payload);
      // rust-pi never echoes queue_update, so surface the pending message
      // ourselves; it clears when the binary folds it into a user turn.
      this.steering.push(text);
      this.emitQueue();
    } else if (mode === "queue") {
      this.process.send(RUST_RPC.followUp, payload);
      this.followUp.push(text);
      this.emitQueue();
    } else {
      this.process.send(RUST_RPC.prompt, payload);
    }
  }

  /** Emit the synthetic steer/follow-up queue to the webview pending UI. */
  private emitQueue(): void {
    this.host.emit({ type: "queue-update", data: { steering: [...this.steering], followUp: [...this.followUp] } });
  }

  /** Drop the first queued steer/follow-up matching `text` once the binary
   *  consumes it (rust-pi has no queue_update to tell us). Returns true if one
   *  was removed. */
  private dropQueued(text: string): boolean {
    return dropQueuedMessage(this.steering, this.followUp, text);
  }

  /** Clear the synthetic queue and emit the (now-empty) pending UI. Used by the
   *  user-facing "clear queue" action (rust-pi auto-processes steers, so this
   *  only resets the local indicator). */
  clearQueueAndEmit(): void {
    this.steering = [];
    this.followUp = [];
    this.emitQueue();
  }

  /** Safety-net clear at agent_end: drop any queue entries the consume-path
   *  missed, emitting only if there were any (preserves prior behavior). */
  clearQueueIfAny(): void {
    if (this.steering.length || this.followUp.length) {
      this.steering = [];
      this.followUp = [];
      this.emitQueue();
    }
  }

  /** Promote a queued follow-up to a steering message. rust-pi auto-processes
   *  steers (no real server-side queue), so we send the text over the steer
   *  channel and reflect the move in the local synthetic queue indicator. */
  promoteToSteer(text: string): void {
    if (!this.process) { return; }
    if (!promoteQueuedToSteer(this.steering, this.followUp, text)) { return; }
    this.process.send(RUST_RPC.steer, { message: text });
    this.emitQueue();
  }

  // ── Capability-degradation warnings ────────────────────

  /** Surface a one-line, deduped warning when a Rust capability RPC fails, so a
   *  degraded session (no model list, no history, no usage readout) isn't silent.
   *  Warns once per capability per session until recordCapOk(cap) clears it. */
  private warnDegraded(cap: string, message: string): void {
    if (checkAndRecordDegraded(this.degradedWarned, cap)) {
      this.host.emit({ type: "custom-message", data: { customType: "error", content: `⚠ ${message}`, timestamp: Date.now() } });
    }
  }

  /** Mark a Rust capability healthy again so a later failure warns once more. */
  private recordCapOk(cap: string): void {
    clearDegraded(this.degradedWarned, cap);
  }

  // ── Backend-aware operations delegated from PiService ──

  /** Abort the current turn and any running bash. */
  abort(): void {
    this.process?.send(RUST_RPC.abortBash);
    this.process?.send(RUST_RPC.abort);
  }

  /** Abort a running bash tool only (the LLM turn keeps going). */
  abortBash(): void { this.process?.send(RUST_RPC.abortBash); }

  /** What the Rust runtime can do — data flags PiService's shared UI reads instead of
   *  hard-coding `_backendKind === "rust"` feature gates. The out-of-process RPC has no
   *  host-tool injection (no bridge tools / interactive cards), and no fork/reload/rename
   *  RPCs; it owns its own slash-command handling (so PiService does not intercept). */
  get capabilities(): BackendCapabilities {
    // The static flags are the runtime default for Rust (out-of-process RPC gates every
    // host-tool/fork/reload/rename feature; it owns its own slashes). Only thinkingLevelLive is
    // dynamic here — it depends on the active model's transport api — so override that one.
    return { ...backendCapabilityDefaults("rust"), thinkingLevelLive: () => thinkingLevelIsLive(this._model?.api) };
  }

  /** Set the active model on the wire (RPC). Applies the reply so the budget clamp /
   *  context-% reflect the new model immediately; returns the applied identity. */
  async setModel(provider: string, id: string): Promise<{ id?: string; name?: string; provider?: string } | null> {
    const resp = await this.requestOrError(RUST_RPC.setModel, { provider, modelId: id }, `Could not switch model to ${id}`);
    if (!resp) { return null; }
    this.applyState({ model: resp.data });
    return this._model;
  }

  /** Set the thinking level on the wire (RPC). Returns the OPTIMISTIC level immediately so the
   *  quick-pick never blocks; the binary's clamp (a non-reasoning model forces "off") is
   *  reconciled fire-and-forget — see reconcileThinkingLevel. Previously this awaited an inline
   *  get_state, freezing the picker for up to 8 s. */
  async setThinkingLevel(level: string): Promise<string> {
    const resp = await this.requestOrError(RUST_RPC.setThinkingLevel, { level }, "Could not set thinking level");
    if (!resp) { return this._thinkingLevel; }
    this._thinkingLevel = level; // optimistic
    void this.reconcileThinkingLevel(level);
    return this._thinkingLevel;
  }

  /** Fire-and-forget after set_thinking_level: re-read get_state to capture the binary's clamp,
   *  update state + status, and — if the model clamped the level — surface it as a chat info
   *  message a beat later. Keeps the picker responsive; the status chip and (if needed) the
   *  notice arrive when the round-trip returns. */
  private async reconcileThinkingLevel(requested: string): Promise<void> {
    try {
      const st = await this.request(RUST_RPC.getState, {}, 8000);
      if (!st?.success) { return; }
      this.applyState(st.data);
      if (this._thinkingLevel !== requested) {
        this.host.emit({ type: "custom-message", data: { customType: "info", content: `${this._model?.id ?? "This model"} doesn't support thinking levels — staying at "${this._thinkingLevel}".`, timestamp: Date.now() } });
      }
      this.host.reportStatus();
    } catch { /* keep the optimistic level */ }
  }

  /** rust-pi loads extensions/skills at startup and exposes no in-session reload RPC, so this
   *  reports false rather than pretending to succeed. capabilities.reloadContext is false too. */
  async reloadContext(): Promise<boolean> { return false; }

  async setAutoCompaction(enabled: boolean): Promise<void> {
    const r = await this.requestOrError(RUST_RPC.setAutoCompaction, { enabled }, "Could not toggle auto-compaction");
    if (r) { this.host.setAutoCompactionEnabled(enabled); }
  }

  async setAutoRetry(enabled: boolean): Promise<void> {
    const r = await this.requestOrError(RUST_RPC.setAutoRetry, { enabled }, "Could not toggle auto-retry");
    if (r) { this.host.setAutoRetryEnabled(enabled); }
  }

  /** Export the conversation to HTML by shelling out to `pi --export` (the binary
   *  owns its session files; there's no in-process session to export). */
  async exportToHtml(outputPath: string): Promise<string> {
    const sf = this.getSessionPath();
    if (!sf) { throw new Error("This Rust session hasn't been saved yet — send a message first, then export."); }
    return this.deps.exportHtml(sf, outputPath);
  }

  /** Promote a queued follow-up / clear the queue — PiBackend aliases. */
  clearQueue(): void { this.clearQueueAndEmit(); }

  /** Correlated RPC with unified error surfacing (used by the backend setters). */
  private async requestOrError(command: string, payload: Record<string, unknown>, label: string): Promise<RustResponse | null> {
    const fail = (m: string): null => { this.host.emit({ type: "custom-message", data: { customType: "error", content: `${label}: ${m}`, timestamp: Date.now() } }); return null; };
    const resp = await this.request(command, payload, 15000).catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
    if (!resp) { return null; }
    if (!resp.success) { return fail(resp.error ?? "unknown error"); }
    return resp;
  }

  /**
   * Compact the conversation context via the Rust RPC `compact` command. Uses
   * request() (correlated by id) — NOT send() — so the reply isn't dropped.
   */
  async compact(): Promise<void> {
    if (!this.process) { return; }
    try {
      const resp = await this.process.request(RUST_RPC.compact, {}, 120000);
      // ALL compact feedback — success and failure — uses customType "info", which
      // handleCustomMessage renders as a fresh in-chat ".message assistant" bubble and
      // scrolls to it (index.ts). It is deliberately the ONLY surface: never the
      // collapsed #live-panel side card ("extension-notify"/default), and never the
      // in-place-updating InlineCard ("display:true"), which can scroll out of view on
      // a repeat. So /compact always reports where the user is looking — the conversation.
      if (resp.success) {
        await this.refreshState();
        this.host.emit({ type: "custom-message", data: { customType: "info", content: "Context compacted.", timestamp: Date.now() } });
      } else {
        const err = resp.error ?? "";
        // The Rust runtime gates compaction behind its auto-compaction threshold
        // (contextTokens > contextWindow − reserveTokens) — manual /compact won't
        // summarize a conversation that still fits. That is NOT a failure, so
        // explain it honestly rather than flag a red error. (The TypeScript
        // runtime has no such gate and compacts on demand.)
        if (/not available|missing ids|already compacted|too little history|nothing to compact/i.test(err)) {
          // Explain the runtime difference in FULL the first time it's hit this host,
          // terse afterwards — so a user who /compacts a small conversation isn't told
          // the whole paragraph every time, but always understands why nothing happened.
          const content = RustService._compactGateExplained
            ? "Nothing to compact yet — the conversation still fits comfortably."
            : "Nothing to compact yet. The Rust runtime compacts automatically as the conversation approaches the model's context limit — it won't compact one that still fits comfortably (unlike the TypeScript runtime, which compacts on demand).";
          RustService._compactGateExplained = true;
          this.host.emit({ type: "custom-message", data: { customType: "info", content, timestamp: Date.now() } });
        } else {
          this.host.emit({ type: "custom-message", data: { customType: "info", content: `⚠️ Compact failed: ${err || "unknown error"}`, timestamp: Date.now() } });
        }
      }
    } catch (e: unknown) {
      this.host.emit({ type: "custom-message", data: { customType: "info", content: `⚠️ Compact failed: ${e instanceof Error ? e.message : String(e)}`, timestamp: Date.now() } });
    }
  }

  /** Low-level correlated RPC passthrough (for backend-aware PiService methods:
   *  set_model, set_thinking_level, set_auto_compaction, set_auto_retry, …). */
  request(command: string, payload?: Record<string, unknown>, timeoutMs?: number): Promise<RustResponse> {
    if (!this.process) { return Promise.reject(new Error("Rust Pi session not initialized")); }
    return this.process.request(command, payload, timeoutMs);
  }

  // ── State accessors for PiService getters ──────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getEntries(): any[] { return this.entries; }
  getSlashCommands(): Array<{ cmd: string; desc: string; source: string }> { return this.slashCommands; }
  /** The Rust catalog captured from get_available_models at init (includes custom
   *  models.json entries) — RustService owns this list (a step toward backend state
   *  ownership); PiService's picker reads it via the PiBackend seam. */
  /** Models for the /model picker. Re-queries the binary instead of serving the init-time
   *  snapshot: a user who adds a provider key or edits models.json mid-session would otherwise
   *  see a stale picker until they opened a new session (the SDK path re-queries every time, so
   *  this was a runtime asymmetry). User-initiated path, but TTL-guarded so repeated opens don't
   *  hammer the RPC. Falls back to the last good list whenever the refresh fails or comes back
   *  empty — the picker can never end up WORSE than the cached snapshot. */
  async getAvailableModels(): Promise<CycleModel[]> {
    const now = Date.now();
    if (this.process && now - this._modelsFetchedAt > MODELS_TTL_MS) {
      try {
        const r = await this.process.request(RUST_RPC.getAvailableModels, {}, 15000);
        const list = parseRustModels(r.data);
        if (r.success && list.length > 0) {
          this._availableModels = list;
          this.host.setCycleModels(list); // keep /model cycling in sync with the picker
          this._modelsFetchedAt = now;
          this.recordCapOk("models");
        }
      } catch (e: unknown) {
        piWarn(`Rust get_available_models refresh failed: ${e instanceof Error ? e.message : String(e)} — using the cached model list.`);
      }
    }
    return this._availableModels;
  }
  /** The active model identity (owned here; PiService reads it via the seam). */
  getModel(): { id?: string; name?: string; provider?: string; api?: string; reasoning?: boolean } | null { return this._model; }
  /** The active thinking level (owned here; PiService reads it via the seam). */
  getThinkingLevel(): string { return this._thinkingLevel; }
  /** Sync the stored level from a streamed thinking_level_changed echo (no wire call). */
  applyThinkingLevel(level: string): void { this._thinkingLevel = level; }

  // Run/streaming flags — OWNED here now (PiService applies them from the event stream via these
  // setters and reads via the getters). The event loop reads its own copy directly for the
  // agent_end dedupe (routeRustEvent) and the mid-turn usage guard — no host round-trip.
  private _agentRunActive = false;
  private _isStreaming = false;
  getAgentRunActive(): boolean { return this._agentRunActive; }
  setAgentRunActive(v: boolean): void { this._agentRunActive = v; }
  isStreaming(): boolean { return this._isStreaming; }
  setStreaming(v: boolean): void { this._isStreaming = v; }
  /** The on-disk session file, or null. CONTRACT: a fresh Rust session has no
   *  file until the binary writes its first turn (it's captured from get_state's
   *  `sessionFile`), so this is null between init and the first turn — callers
   *  persisting it must tolerate null rather than recording a stale path. */
  getSessionPath(): string | null { return this.sessionPath; }
  /** Add one assistant message's token usage to the running cumulative so the status bar
   *  climbs live mid-turn. Replaced wholesale by the authoritative get_session_stats total
   *  at agent_end (applyUsage), so any estimate drift self-corrects each turn. */
  private accumulateUsage(u: Record<string, unknown>): void {
    const n = (v: unknown): number => (typeof v === "number" ? v : 0);
    const base = this.usage ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextPercent: null, contextWindow: this.contextWindow };
    this.usage = {
      ...base,
      input: base.input + n(u.input),
      output: base.output + n(u.output),
      cacheRead: base.cacheRead + n(u.cacheRead),
      cacheWrite: base.cacheWrite + n(u.cacheWrite),
    };
  }

  getUsage(): RustUsage {
    // Recompute context% from the CURRENT lastContextTokens (updated by captureContext
    // on every assistant message_end) rather than returning the value baked into
    // this.usage at the last get_session_stats refresh. Without this, the % only moved
    // at agent_end — staying at its turn-start value through a long multi-tool turn.
    const cw = this.contextWindow;
    const ctx = this.lastContextTokens;
    const contextPercent = (cw > 0 && ctx > 0) ? Math.min(100, (ctx / cw) * 100) : null;
    const u = this.usage;
    return u
      ? { ...u, contextWindow: cw, contextPercent }
      : { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextPercent, contextWindow: cw };
  }
}
