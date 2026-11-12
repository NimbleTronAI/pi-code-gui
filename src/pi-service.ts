import * as path from "node:path";
import * as fs from "node:fs";
import * as vscode from "vscode";

import { type PiServiceEvent, validateExtensionToWebview } from "./types.js";
import { piDebug, piWarn, registerSecret } from "./logger.js";
import { piAiNoticeMessage } from "./version-compare.js";
import { getApiKey } from "./secrets.js";
import { confirmRendererConsent } from "./renderer-consent.js";

import { getSupportedThinkingLevels, clampThinkingLevel, findCatalogThinkingModel, findCatalogModelCost, catalogRatesAreUnexpressible, costWithheldReason, reconcileThinkingCapability, THINKING_LEVELS, type ThinkingModel } from "./model-catalog.js";
import { computeUsageStats, type UsageStats } from "./usage-stats.js";
import { composeThinkingStatus, pickDefaultReasoningLevel, toggleThinkingTarget, buildThinkingPickerRows } from "./thinking-dial.js";
import { buildSummaryContext, cleanTabSummary } from "./tab-summary.js";
import { EventBus } from "./event-bus.js";
import bundledRegistry from "./model-registry.generated.json";
import { buildPiPackageCandidates, pickPiPackagePath } from "./pi-package-path.js";


import { resolveWorkspaceCwd } from "./workspace.js";
import { translateAgentEvent, extractMessageText } from "./agent-events.js";
import { replaySessionEntries, indexEntries } from "./session-replay.js";
import { SdkService, importWithRetry, type PiSdk, type PiAi, type SdkDeps, type CatalogProviders } from "./sdk-service.js";
import { createBridgeTools } from "./bridge-tools.js";
import { shouldDropPreemptingPrompt } from "./prompt-guard.js";
import type { PiBackend } from "./pi-backend.js";
import { createExtensionUIBridge, type ExtensionUIBridge } from "./extension-ui-bridge.js";
import { buildSlashCommandList, parseSlashCommand } from "./slash-commands.js";
import { runLogin, runLogout, type AuthFlowDeps } from "./auth-flow.js";
import { mapSessionTools, findLastActiveTools, buildToolPickerRows, summarizeToolSelection } from "./active-tools.js";
import { resolveFallbackModels, toModelChoices, buildModelPickerItems, buildDefaultChoiceItems, type ModelChoice } from "./model-picker.js";


export interface InstallStatus {
  installed: boolean;
  hasApiKey: boolean;
  path?: string;
  error?: string;
}

type EventListener = (event: PiServiceEvent) => void;

// ── SDK Resolution ───────────────────────────────────────

export function resolvePiPackagePath(): string {
  // List the NVM node versions (the only fs read needed to build candidates);
  // ordering/dedup/priority live in the pure, tested buildPiPackageCandidates.
  let nvmVersions: string[] = [];
  const nvmDir = process.env.NVM_DIR;
  if (nvmDir) {
    try {
      const versionsDir = path.join(nvmDir, "versions", "node");
      if (fs.existsSync(versionsDir)) { nvmVersions = fs.readdirSync(versionsDir); }
    } catch (e: unknown) { piWarn(`Non-critical failure (ignored): ${e instanceof Error ? e.message : String(e)}`); }
  }

  const candidates = buildPiPackageCandidates({
    platform: process.platform,
    pathEnv: process.env.PATH || "",
    appData: process.env.APPDATA,
    home: process.env.HOME || process.env.USERPROFILE,
    nvmDir,
    nvmVersions,
  });

  const found = pickPiPackagePath(candidates, (pkgJson) => {
    try { return fs.existsSync(pkgJson); } catch { return false; }
  });
  if (found) { return found; }

  throw new Error(
    "Pi coding agent SDK not found. Please install it:\n" +
      "  npm install -g @earendil-works/pi-coding-agent",
  );
}

// ── PiService ────────────────────────────────────────────

/** Register a configured secret with the logger and hand it back, so the config object is built
 *  and the redaction list is populated in one expression. */
function registerAndReturnSecret(value: string | undefined): string | undefined {
  registerSecret(value);
  return value;
}

/** Bridge an AbortSignal to a vscode CancellationToken so an already-open QuickPick/InputBox
 *  can be dismissed. Returns undefined when there is no signal, which keeps the plain
 *  (untokened) overload for callers that don't need it. */
function tokenFor(signal?: AbortSignal): vscode.CancellationToken | undefined {
  if (!signal) { return undefined; }
  const src = new vscode.CancellationTokenSource();
  if (signal.aborted) { src.cancel(); }
  else { signal.addEventListener("abort", () => src.cancel(), { once: true }); }
  return src.token;
}

/** How long to give an abort before telling the user it hasn't taken effect. Long enough that a
 *  normal stop never trips it, short enough that a stuck runtime doesn't look like a hang. */
const ABORT_GRACE_MS = 5000;

export class PiService {
  /** The Pi SDK runtime (module loading, auth, registry, session manager,
   *  agent session). The legacy field names
   *  (session, SDK, AI, …) are kept as thin getters over this service so the
   *  class's many read sites stay unchanged and runtime-agnostic. */
  private _sdk: SdkService | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get session(): any { return this._sdk?.session ?? null; }
  private unsubscribe: (() => void) | null = null;
  /** The webview event bus (validate → dispatch, listener-error isolation). See event-bus.ts. */
  private readonly _bus = new EventBus(validateExtensionToWebview, piWarn);
  /** The active model identity — OWNED by the backend (SdkService) and read through the seam,
   *  not stored here. Kept as a getter so the ~38 read-sites are unchanged; the backend updates
   *  it on init / setModel. */
  private get _model(): { id?: string; name?: string; provider?: string; api?: string; reasoning?: boolean } | null {
    return this.backend?.getModel() ?? null;
  }
  /** The active thinking level — now OWNED by the active backend and read through the
   *  seam (getter, so the ~10 read-sites are unchanged). Backends update it on init /
   *  setThinkingLevel / applyThinkingLevel. */
  private get _thinkingLevel(): string { return this.backend?.getThinkingLevel() ?? "off"; }
  /** Last non-"off" thinking level chosen, so turning Thinking back on restores the
   *  user's prior Reasoning level (falls back to the model's highest). */
  private _lastReasoningLevel: string | undefined;
  // The run/streaming flags are OWNED by the backend (see PiBackend); PiService reads them via
  // `this.backend` and applies the event-stream mutations through its setters.
  /** Event types already logged as unhandled, so upstream protocol drift is
   *  surfaced once in the output channel rather than flooding it per event. */
  private _warnedUnknownEvents = new Set<string>();
  private sessionId: string | null = null;

  /** The SDK runtime as a PiBackend, or null before init / after a failed init. PiService
   *  delegates the primitive operations (sendPrompt, abort, compact, setModel, …) here;
   *  orchestration and UI (pickers, slash dispatch, status/cost formatting) stay in PiService. */
  private get backend(): PiBackend | null {
    return this._sdk;
  }

  // SDK state — owned by SdkService; exposed under the legacy names as getters.
  private get _piRoot(): string | null { return this._sdk?.piRoot ?? null; }
  /* eslint-disable @typescript-eslint/no-explicit-any -- SDK objects are dynamically typed */
  private get SDK(): PiSdk | null { return this._sdk?.SDK ?? null; }
  private get AI(): PiAi | null { return this._sdk?.AI ?? null; }
  /** Unified auth+model facade (pi-coding-agent >= 0.80.8), owned by SdkService. */
  private get modelRuntime(): any { return this._sdk?.modelRuntime ?? null; }
  private get settingsManager(): any { return this._sdk?.settingsManager ?? null; }
  private get sessionManager(): any { return this._sdk?.sessionManager ?? null; }
  private get resourceLoader(): any { return this._sdk?.resourceLoader ?? null; }

  // Model cycling state (populated dynamically from registry)
  private cycleModels: Array<{ provider: string; id: string; name?: string; cost?: { input: number; output: number }; contextWindow?: number }> = [];
  private cycleIndex = 0;

  // Track current assistant message content (for toolCall stubs during message_update)
  private currentAssistantToolCalls: Map<string, { toolName: string; toolCallId: string; args: any; lastPreviewEmit?: number }> = new Map();

  // Widget activity timer (cleared on dispose to prevent leaks)
  /** The extension UIContext bridge (widget sweep + dialog routing), created on
   *  bindExtensionUI. Its dispose() stops the idle-widget timer. */
  private _uiBridge: ExtensionUIBridge | null = null;

  /* eslint-enable @typescript-eslint/no-explicit-any */

  // Pending interactive dialogs (select/confirm/input).  Maps dialog ID → Promise resolve.
  private _pendingDialogs = new Map<string, { resolve: (v: unknown) => void }>();


  // User message history for the resend/reuse feature (#2)
  private _userMessages: Array<{ id: string; text: string; timestamp?: number }> = [];

  // Settings state (#3)
  private _autoCompactionEnabled = true;
  private _autoRetryEnabled = true;
  private _showImages = true;

  constructor() {}

  // ── Public API ─────────────────────────────────────────

  onEvent(listener: EventListener): () => void {
    return this._bus.subscribe(listener);
  }

  /** Validate-then-dispatch a webview event (validation failure logs + pushes a diagnostic but
   *  still emits). See event-bus.ts. */
  private emit(event: PiServiceEvent): void { this._bus.emit(event); }

  /** Emit without validation (used internally to avoid recursive validation on diagnostics). */
  private emitSafe(event: PiServiceEvent): void { this._bus.emitSafe(event); }

  static async checkInstall(): Promise<InstallStatus> {
    try {
      const p = resolvePiPackagePath();

      // Verify critical transitive dependencies are actually present (not just
      // package.json stubs — npm global install hoisting can leave hollow dirs).
      const missing: string[] = [];
      const criticalDeps: Array<[string, string]> = [
        ["openai", "index.js"],
        ["@anthropic-ai/sdk", "index.mjs"],
      ];
      for (const [dep, entry] of criticalDeps) {
        const candidate = path.join(p, "node_modules", dep, entry);
        if (!fs.existsSync(candidate)) {
          // Also check top-level hoist (npm global installs sometimes hoist to
          // the global node_modules directly).
          const globalCandidate = path.join(p, "..", "..", dep, entry);
          if (!fs.existsSync(globalCandidate)) {
            missing.push(dep);
          }
        }
      }

      if (missing.length > 0) {
        return {
          installed: false,
          hasApiKey: false,
          error:
            `Pi SDK found but dependencies are missing: ${missing.join(", ")}. ` +
            `Reinstall with: npm uninstall -g @earendil-works/pi-coding-agent && npm install -g @earendil-works/pi-coding-agent`,
        };
      }

      return { installed: true, hasApiKey: true, path: p };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      return { installed: false, hasApiKey: false, error: e.message ?? String(e) };
    }
  }

  /** List past (saved-on-disk) sessions for the given cwd. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  static async listSessions(cwd: string): Promise<any[]> {
    try {
      const piRoot = resolvePiPackagePath();
      // Match initialize()'s retry parameters — fewer retries here
      // caused past-session lists to come up empty on slow first loads.
      const SDK = await importWithRetry(path.join(piRoot, "dist/index.js"), 5, 500);
      const cfg = vscode.workspace.getConfiguration("pi-code-gui");
      const sessionDir = cfg.get<string>("sessionDir")?.trim() || undefined;
      const sessions = await SDK.SessionManager.list(cwd, sessionDir);
      piDebug(`listSessions: found ${sessions.length} past sessions in ${cwd}`);
      return sessions;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      piWarn(`listSessions failed: ${e.message ?? e}`);
      return [];
    }
  }

  /** Delete a session file from disk. */
  static async deleteSessionFile(filePath: string): Promise<void> {
    if (typeof filePath !== "string") {
      throw new Error("deleteSessionFile: filePath must be a string");
    }
    await fs.promises.unlink(filePath);
  }

  async initialize(opts?: { fresh?: boolean; openPath?: string }): Promise<{ success: boolean; error?: string }> {
    const fresh = opts?.fresh ?? false;
    const openPath = opts?.openPath ?? null;
    // Re-init replaces any prior runtime state. Constructing a fresh SdkService below drops
    // any stale session reference, so a failed init reports `initialized === false`
    // instead of pointing at the abandoned session.

    // ── SDK plumbing (former init Steps 1–9) — owned by SdkService ──
    // Resolves/loads the SDK, adapts pi-ai ≥0.80, sets up auth/registry/settings,
    // picks the model (default override + session resume + capability reconcile +
    // thinking clamp), builds the ResourceLoader and tools, opens the
    // SessionManager, and creates the agent session. PiService applies the
    // returned shared state and wires the session to the UI below (Steps 10–12).
    this._sdk = new SdkService({
      emit: (e) => this.emit(e),
      resolvePiRoot: () => resolvePiPackagePath(),
    }, this.makeSdkDeps());
    const init = await this._sdk.initialize({ fresh, openPath });
    if (!init.success || !this.session) {
      return { success: false, error: init.error ?? "SDK initialization produced no session." };
    }
    // _model is owned by SdkService now (set during initialize); PiService reads it via
    // the getter. cycleModels remains PiService orchestration; _thinkingLevel is owned by
    // SdkService (set during initialize) and read via the getter.
    this.cycleModels = init.cycleModels ?? [];
    // Seed the off→on toggle memory from the restored level (restore sets
    // _thinkingLevel directly, bypassing setThinkingLevel/rememberReasoning), so a
    // session reopened at e.g. "high" toggles back to "high" rather than the model's
    // highest. Only a real reasoning level is worth remembering.
    this.rememberReasoning();
    this.sessionId = this.session.sessionId;

    // Restore active tools from session file (if resuming)
    if (init.isResuming) {
      this._restoreActiveToolsFromSession();
    }

    // ── Step 10: Subscribe to events ───────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    this.unsubscribe = this.session.subscribe((event: any) => {
      this.handleAgentEvent(event);
    });

    // ── Step 11: Bind extensions with webview-bridged UIContext ─
    await this.bindExtensionUI();

    // ── Step 12: Send initial message history (like TUI renderInitialMessages) ──
    const hasEntries = (this.sessionManager?.getEntries?.()?.length ?? 0) > 0;
    this.emit({ type: "batch-start", data: { hasEntries } });
    await this.sendInitialMessages();
    this.emit({ type: "batch-end", data: { hasEntries } });

    // Seed the settings toggles from the SESSION's real state before advertising them. They
    // used to be hardcoded `true` and never read back, so a resumed session whose settings
    // differed showed a UI that disagreed with its own behaviour — and, until setAutoRetry was
    // wired, a retry toggle that had never done anything anyway. Absent values keep the
    // current default.
    const sessionSettings = this._sdk?.readSessionSettings() ?? {};
    if (typeof sessionSettings.autoCompaction === "boolean") { this._autoCompactionEnabled = sessionSettings.autoCompaction; }
    if (typeof sessionSettings.autoRetry === "boolean") { this._autoRetryEnabled = sessionSettings.autoRetry; }

    this.reportStatus();
    try {
      this.emitSettings();
      this.emitSlashCommands();
    } catch (e: unknown) {
      piWarn(`Post-init emissions failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    return { success: true };
  }

  /** Real (vscode-backed) implementations of SdkService's environment deps.
   *  SdkService is vscode-free so its resolve→load→session init sequence can be
   *  driven headlessly in unit tests with stubbed deps (see sdk-service.test.ts). */
  private makeSdkDeps(): SdkDeps {
    return {
      workspaceCwd: () => resolveWorkspaceCwd(),
      config: () => {
        const cfg = vscode.workspace.getConfiguration("pi-code-gui");
        return {
          // Register before use: the logger scrubs these exact values from every log line and
          // from the error text that reaches the webview (a custom/self-hosted key matches no
          // vendor prefix, so pattern-matching alone would miss it).
          // SecretStorage is the source of truth (settings are migrated + cleared at activation);
          // the settings read remains as a fallback for a value written after startup.
          anthropicApiKey: getApiKey("anthropicApiKey") ?? registerAndReturnSecret(cfg.get<string>("anthropicApiKey")),
          openaiApiKey: getApiKey("openaiApiKey") ?? registerAndReturnSecret(cfg.get<string>("openaiApiKey")),
          defaultModelProvider: cfg.get<string>("defaultModelProvider"),
          defaultModelId: cfg.get<string>("defaultModelId"),
          defaultThinkingLevel: cfg.get<string>("defaultThinkingLevel") ?? "off",
          contextBudget: cfg.get<number>("contextBudget") ?? 0,
          sessionDir: cfg.get<string>("sessionDir")?.trim() || undefined,
        };
      },
      importModule: (absPath) => importWithRetry(absPath, 5, 500),
      fileExists: (p) => fs.existsSync(p),
      readFileUtf8: (p) => fs.promises.readFile(p, "utf-8"),
      buildBridgeTools: (defineTool, typebox) => createBridgeTools(defineTool, typebox),
      catalogProviders: () => this.catalogProviders,
      // Arbitrary JS in the webview — ask once per custom type and remember the answer.
      confirmRendererConsent: (customType) => confirmRendererConsent(customType),
      notifyOutdatedPiAi: (installed, supported, belowFloor) => {
        const UPDATE = "Update";
        // Below the floor the Pi SDK cannot start (breakage); merely
        // behind this build's target is a nudge. Same one-click offer either way, different
        // severity and wording, so a routine "newer version exists" doesn't read as breakage.
        const message = piAiNoticeMessage(installed, supported, belowFloor);
        const show = belowFloor ? vscode.window.showWarningMessage : vscode.window.showInformationMessage;
        void show(message, UPDATE).then((choice) => {
          if (choice === UPDATE) {
            const term = vscode.window.createTerminal("Update Pi SDK");
            term.show();
            // Typed, NOT executed — the user reviews and runs it, because this mutates global
            // npm state and automated installs are not reliable on every platform.
            term.sendText("npm install -g @earendil-works/pi-coding-agent", false);
          }
        });
      },
    };
  }


  /** Session entries for the Open Sessions tree (the SDK's sessionManager.getEntries()). */

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  getDisplayEntries(): any[] {
    return this.backend?.getEntries() ?? [];
  }

  // ── Extension UI Bridge ────────────────────────────

  /**
   * Bind extensions with a UIContext that bridges to the VS Code webview.
   * Without this, extensions like pi-tldr have hasUI=false and their
   * notify/setWidget calls silently do nothing.
   */
  private async bindExtensionUI(): Promise<void> {
    if (!this.session || typeof this.session.bindExtensions !== "function") {
      return;
    }

    // The UIContext (widget sweep, notify, interactive dialogs, TUI-stub Proxy) is built
    // by the extracted, headlessly-tested extension-ui-bridge; PiService supplies its two
    // effects (emit, showDialog) and keeps the handle to dispose the widget timer.
    this._uiBridge = createExtensionUIBridge({
      emit: (event) => this.emit(event),
      showDialog: (type, prompt, extras) => this._showDialog(type, prompt, extras),
    });
    const uiContext = this._uiBridge.uiContext;

    try {
      await this.session.bindExtensions({
        uiContext,
        onError: (error: Error, extensionPath: string) => {
          piWarn(`Extension error [${extensionPath}]: ${error?.message ?? error}`);
        },
      });
      piDebug("Extension UI context bound");
      // Log which extensions have handlers registered
      if (this.session?._extensionRunner) {
        const paths = this.session._extensionRunner.getExtensionPaths?.() ?? [];
        piDebug(`Loaded extensions: ${paths.length > 0 ? paths.join(", ") : "none"}`);
      }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      piWarn(`bindExtensions failed: ${e.message ?? e}`);
    }

    // Push updated slash-command list after extensions register commands
    this.emitSlashCommands();
  }

  /** Get all slash commands available to the user.
   *  Includes extension-registered commands, builtin SDK commands,
   *  and builtin prompt templates.  Each entry carries a `source`
   *  field so the UI can group or label them. */
  getAllSlashCommands(): Array<{ cmd: string; desc: string; source: string }> {
    // Assembly is pure + tested (buildSlashCommandList): the session's agent commands (the SDK
    // introspects its extension runner + builtin templates) + the GUI/session commands.
    return buildSlashCommandList(this.backend?.getSlashCommands() ?? []);
  }

  /** Emit all registered slash commands to the webview for autocomplete. */
  emitSlashCommands(): void {
    const all = this.getAllSlashCommands();
    this.emit({
      type: "slash-commands-update",
      data: { commands: all },
    });
  }

  /** Send existing session messages to the webview on initial load (or after reload). The
   *  replay decision (which events reproduce the session) is the pure, unit-tested
   *  replaySessionEntries (src/session-replay.ts); this shell owns the side effects: appending
   *  to the capped user-message history, then emitting each entry's group and yielding to the
   *  event loop so the webview paints top-down (oldest first) without a synchronous DOM flood
   *  that would crash the extension host on large sessions. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  async sendInitialMessages(providedEntries?: any[]): Promise<void> {
    // Build session context from the session manager, or from caller-provided entries.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    let entries: any[];
    if (providedEntries) {
      entries = providedEntries;
      piDebug(`sendInitialMessages: ${entries.length} provided entries`);
    } else {
      try {
        entries = this.sessionManager.getEntries();
        piDebug(`sendInitialMessages: ${entries?.length ?? 0} entries`);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (e: any) {
        piWarn(`sendInitialMessages: getEntries failed: ${e.message}`);
        return;
      }
    }
    if (!entries || entries.length === 0) { return; }

    const { groups, userMessages } = replaySessionEntries(entries, { now: Date.now() });
    for (const m of userMessages) {
      this._userMessages.push(m);
      if (this._userMessages.length > 50) { this._userMessages.shift(); }
    }

    const yieldTick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));
    for (const group of groups) {
      for (const ev of group) { this.emit(ev); }
      await yieldTick(); // paint incrementally
    }
  }

  // ── Agent event → PiServiceEvent translation ────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleAgentEvent(event: any): void {
    // The decision logic lives in the pure, unit-tested translateAgentEvent
    // (src/agent-events.ts). This shell builds the state snapshot, applies the
    // returned mutations, emits the events, then reports status after, reflecting
    // post-event state.
    const r = translateAgentEvent(event, {
      lookups: indexEntries(this.sessionManager?.getEntries?.() ?? []),
      userMessages: this._userMessages,
      toolCalls: this.currentAssistantToolCalls,
      now: Date.now(),
      prepareArgs: (toolName, args) => this._prepareToolArgs(toolName, args),
    });

    // The run/streaming flags are owned by the backend — apply the event-stream mutations
    // through it.
    if (r.setAgentRunActive !== undefined) { this.backend?.setAgentRunActive(r.setAgentRunActive); }
    if (r.setStreaming !== undefined) { this.backend?.setStreaming(r.setStreaming); }
    if (r.setThinkingLevel !== undefined) { this.backend?.applyThinkingLevel(r.setThinkingLevel); this.rememberReasoning(); }
    if (r.clearToolCalls) { this.currentAssistantToolCalls.clear(); }

    for (const ev of r.events) { this.emit(ev); }

    if (r.effects.reportStatus) { this.reportStatus(); }
    if (r.effects.unknownType && !this._warnedUnknownEvents.has(r.effects.unknownType)) {
      this._warnedUnknownEvents.add(r.effects.unknownType);
      piWarn(`Unhandled agent event "${r.effects.unknownType}" — possible upstream protocol drift (logged once).`);
    }
  }

  /**
   * Apply a tool's prepareArguments hook so the webview receives
   * validated/transformed args (e.g. the edit tool's legacy oldText/newText →
   * edits[]). The SDK runs prepareArguments internally but only AFTER emitting
   * tool_execution_start, so raw LLM args would otherwise leak through. Returns
   * args unchanged when there is no matching tool def.
   */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _prepareToolArgs(toolName: string, args: any): any {
    try {
      const tools = this.session?.agent?.state?.tools;
      if (tools) {
// eslint-disable-next-line @typescript-eslint/no-explicit-any
        const toolDef = (tools as any[]).find((t: any) => t.name === toolName);
        if (toolDef?.prepareArguments) { return toolDef.prepareArguments(args); }
      }
    } catch (_e: unknown) { piWarn(`Tool param decode skipped: ${_e instanceof Error ? _e.message : String(_e)}`); }
    return args;
  }

  /** The thinking level actually in effect for the current model — the stored level
   *  snapped to what the model honors. The status bar and pickers read this so the
   *  UI never claims a level the model will silently ignore (e.g. it shows "high"
   *  after switching to DeepSeek with a stored "low"). Falls back to the stored
   *  level when the model can't be resolved (no metadata to clamp by). */
  private realThinkingLevel(): string {
    const full = this.currentFullModel();
    return full ? clampThinkingLevel(full, this._thinkingLevel) : this._thinkingLevel;
  }

  /** The composed Thinking/Reasoning status for the single status-bar chip. Thinking and
   *  Reasoning are two axes of ONE dial: "off" disables thinking; any other level enables it at
   *  that reasoning effort (mirrors the wire's `thinking.type` + `reasoning_effort`/`effort`
   *  fields). */
  thinkingStatus(): { text: string } {
    // Chip composition is pure + tested (composeThinkingStatus).
    return { text: composeThinkingStatus(this.realThinkingLevel()) };
  }

  /** Remember the active reasoning level so toggling Thinking off→on can restore it. */
  private rememberReasoning(): void {
    if (this._thinkingLevel !== "off") { this._lastReasoningLevel = this._thinkingLevel; }
  }

  /** The reasoning level to apply when Thinking is turned on with no explicit choice:
   *  the last one used, else the model's highest supported level. */
  private defaultReasoningLevel(): string {
    return pickDefaultReasoningLevel(this.supportedThinkingLevels(), this._lastReasoningLevel);
  }

  /** Toggle Thinking on/off (the Thinking axis of the one dial). Off→on restores the
   *  last reasoning level (defaultReasoningLevel); on→off goes to "off". Returns false
   *  (after an honest notice) when there is nothing to toggle — a non-reasoning model —
   *  so callers don't claim success. */
  async toggleThinking(): Promise<boolean> {
    const onLevels = this.supportedThinkingLevels().filter((l) => l !== "off");
    if (onLevels.length === 0) {
      vscode.window.showInformationMessage(`${this._model?.id ?? "This model"} doesn't use reasoning, so there's nothing to toggle.`);
      return false;
    }
    await this.setThinkingLevel(toggleThinkingTarget(this.realThinkingLevel(), this.defaultReasoningLevel()));
    return true;
  }

  private reportStatus(): void {
    const stats = this.getUsageStats();
    const cfg = vscode.workspace.getConfiguration("pi-code-gui");
    const budget = cfg.get<number>("contextBudget") ?? 0;
    const thinking = this.thinkingStatus();
    this.emit({
      type: "status-update",
      data: {
        model: this._model?.id ?? this._model?.name ?? "pi",
        thinkingLevel: this.realThinkingLevel(),
        // Composed Thinking/Reasoning chip text. See thinkingStatus.
        thinkingDisplay: thinking.text,
        reasoning: this._model?.reasoning,
        isStreaming: this.backend?.isStreaming() ?? false,
        sessionId: this.sessionId ?? undefined,
        // On-disk session file (null until the first write). The webview persists this
        // into VS Code's webview state so deserializeWebviewPanel can re-attach the
        // session after a window reload.
        sessionFile: this.sessionFilePath ?? undefined,
        usage: stats,
        contextBudget: budget,
      },
    });
  }

  // ── User actions ───────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
  async sendPrompt(text: string, images?: any[], mode?: string): Promise<void> {
    if (!this.backend) { throw new Error("Pi session not initialized"); }

    // Dispatch trace (debug-level): mode + the streaming state the decision keys off.
    // Enable the "Pi Code Gui" output channel's Debug level to capture this — it's how
    // we pin the trigger of a preempting dispatch (see prompt-guard.ts).
    const agentRunActive = this.backend?.getAgentRunActive() ?? false;
    piDebug(`sendPrompt mode=${mode ?? "prompt"} agentRunActive=${agentRunActive} streaming=${this.backend?.isStreaming() ?? false} len=${text.length}`);

    // Never let a mode-less conversational prompt preempt an in-flight turn: a real
    // mid-stream follow-up arrives as steer/queue, so this is a stale/duplicate dispatch.
    // Drop it and log the call site so the (still-unconfirmed) trigger is captured.
    if (shouldDropPreemptingPrompt(mode, agentRunActive, text)) {
      piWarn(`Dropped a fresh prompt that would preempt an in-flight turn (streaming=${this.backend?.isStreaming() ?? false}). A mid-stream follow-up should arrive as steer/queue — a mode-less prompt here is a stale/duplicate dispatch. Text: ${JSON.stringify(text.slice(0, 80))}`);
      piDebug(`Preempting-prompt call site:\n${new Error("preempting-prompt dispatch").stack}`);
      this.emit({ type: "custom-message", data: { customType: "info", content: "Ignored a duplicate prompt that arrived while the current turn was still running.", timestamp: Date.now() } });
      return;
    }

    // Intercept builtin slash commands before sending. Builtin commands map
    // to PiService methods; unhandled slash commands (extension commands like /tldr,
    // and unknown ones) MUST go through the plain prompt path even while streaming —
    // the SDK runs them immediately, whereas steer()/followUp() reject them
    // ("extension commands cannot be queued").
    if (text.startsWith("/")) {
      const handled = await this.tryHandleCommand(text);
      if (handled) { return; }
      return this.backend.sendPrompt(text, undefined, undefined);
    }

    // Steer / queue: the primitive enforces the no-image-mid-stream rule and surfaces
    // steer/followUp rejections as an error card (via the shared emit).
    if (mode === "steer" || mode === "queue") {
      return this.backend.sendPrompt(text, images, mode);
    }

    // Default turn: vision auto-switch is PiService orchestration (it needs setModel +
    // the cycle list). Do it here, then hand the turn to the primitive.
    if (images && images.length > 0 && !this.activeModelSupportsImages()) {
      const visionModel = this.findVisionModel();
      if (!visionModel) {
        throw new Error(
          `Cannot send images: no vision-capable model available. ` +
          "Add an API key for Claude, GPT-4o, or Gemini to use images.",
        );
      }
      await this.setModel(visionModel.provider, visionModel.id);
      this.emit({ type: "custom-message", data: { customType: "info", content: `Auto-switched to ${visionModel.id} (vision-capable) for image support.`, timestamp: Date.now() } });
    }
    await this.backend.sendPrompt(text, images, undefined);
  }

  /** Check whether the active model's input capabilities include images. */
  private activeModelSupportsImages(): boolean {
 
    const rawModel = (this.session)?.model;
    if (!rawModel) { return true; }
    const input = rawModel.input as string[] | undefined;
    return input?.includes("image") ?? true;
  }

  /** Find a vision-capable model from the available scoped models. */
  private findVisionModel(): { provider: string; id: string } | null {
    if (!this.AI) { return null; }
    for (const cm of this.cycleModels) {
      const m = this.AI.getModel(cm.provider, cm.id);
      if (m?.input?.includes("image")) {
        return { provider: cm.provider, id: cm.id };
      }
    }
    return null;
  }

  /** Try to handle a slash command locally. Returns true if handled,
   *  false if the caller should forward to session.prompt(). */
  private async tryHandleCommand(text: string): Promise<boolean> {
    const { cmd: cmdName, arg } = parseSlashCommand(text);

    switch (cmdName) {
      // Builtin commands with PiService handlers
      case "model":  await this.cycleModel(); return true;
      case "new":    await this.newSession(); return true;
      case "login":  await this.login(); return true;
      case "logout": await this.logout(); return true;

      // Builtin commands intercepted before session.prompt (like the CLI does).
      // NOTE: /settings, /sessions, /model, /thinking are intercepted by
      // the webview's localSlashCommands and handled via handleSlashCommand.

      case "name": {
        if (arg) { this.session.setSessionName(arg); }
        return true;
      }

      case "tree":
        await vscode.commands.executeCommand("pi-code-gui.sessions.focus");
        return true;

      case "compact": {
        await this.session.compact(arg || undefined);
        return true;
      }

      case "export":
        await this.exportSessionInteractive(arg);
        return true;

      case "reload": {
        await this.backend?.reloadContext();
        // Re-send initial messages so the webview reflects updated extensions/skills
        await this.sendInitialMessages();
        this.emitSlashCommands();
        return true;
      }

      // Commands that delegate to VS Code commands:
      case "clone":
        await vscode.commands.executeCommand("pi-code-gui.cloneSession");
        return true;

      case "tools": {
        await this.pickActiveTools();
        return true;
      }

      case "fork":
      case "resume":
        // These are no-ops via text since they require interactive selection.
        // The UX is available via the Sessions tree context menus.
        return true;

      default:
        // Unknown command — let the caller send to session.prompt (handles
        // extension commands like /tldr, or falls through to the LLM)
        return false;
    }
  }

  async abort(): Promise<void> {
    // The backend kills any running bash before stopping the LLM turn (agent.abort alone would
    // orphan child processes). See SdkService.abort. The union return is voided.
    const backend = this.backend;
    void backend?.abort();

    // Watchdog: a Stop that never lands is indistinguishable from one still in flight — the user
    // gets a silent, permanently "stopping" turn. If the run is still active after the grace
    // period, say so rather than leave them guessing.
    if (!backend) { return; }
    setTimeout(() => {
      // Only complain about the run we actually tried to stop — not a later one, and not a
      // session that has since been disposed or replaced.
      if (this.backend !== backend || !backend.getAgentRunActive()) { return; }
      this.emit({ type: "custom-message", data: { customType: "error", content: `Stop was sent ${Math.round(ABORT_GRACE_MS / 1000)}s ago but the turn is still running. The runtime may be stuck inside a tool call — you can wait, or run /new to start a fresh session.`, timestamp: Date.now() } });
    }, ABORT_GRACE_MS);
  }

  /**
   * Compact the conversation context. Delegated to the backend, which calls the in-process
   * session (same call as the command-palette `pi-code-gui.compact`).
   */
  async compact(): Promise<void> {
    piDebug("compact() invoked");
    await this.backend?.compact();
  }

  /** `/export` from the chat: resolve a default path when none was given, export through the
   *  PiBackend seam, and report where it landed. */
  async exportSessionInteractive(arg?: string): Promise<void> {
    const outputPath = arg || vscode.Uri.joinPath(
      vscode.Uri.file(resolveWorkspaceCwd()),
      `pi-session-${this.sessionId?.slice(0, 8) ?? "export"}.html`,
    ).fsPath;
    try {
      const result = await this.exportToHtml(outputPath);
      vscode.window.showInformationMessage(`Session exported to: ${result}`);
    } catch (e: unknown) {
      // A failed export is a real, actionable answer — put it in the chat rather than
      // swallowing it.
      const msg = e instanceof Error ? e.message : String(e);
      this.emit({ type: "custom-message", data: { customType: "error", content: `Export failed: ${msg}`, timestamp: Date.now() } });
    }
  }

  async exportToHtml(outputPath: string): Promise<string> {
    // Delegated to the backend (PiBackend.exportToHtml): the SDK exports the in-process session.
    if (!this.backend) { throw new Error("No active session to export."); }
    return this.backend.exportToHtml(outputPath);
  }

  /** Resolve a pending interactive dialog (called from webview-panel.ts). */
  resolveDialog(id: string, value: unknown): void {
    const entry = this._pendingDialogs.get(id);
    if (entry) {
      this._pendingDialogs.delete(id);
      entry.resolve(value);
    }
  }

  /**
   * Show an interactive dialog in the webview and return a Promise.
   * Falls back to synchronous undefined if no listeners are attached
   * (the SDK then uses text-based fallback prompts).
   */
  private _showDialog(
    dialogType: "select" | "confirm" | "input",
    prompt: string,
    extras: { options?: string[]; defaultValue?: string },
  ): Promise<unknown> | undefined {
    if (this._bus.listenerCount === 0) {
      // No webview attached — SDK will fall back to text prompts
      return undefined;
    }
    const id = "dlg_" + Math.random().toString(36).slice(2, 10);
    return new Promise((resolve) => {
      this._pendingDialogs.set(id, { resolve });
      this.emit({
        type: "show_dialog",
        data: {
          dialogType,
          id,
          prompt,
          options: extras.options || [],
          defaultValue: extras.defaultValue || "",
        },
// eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
    });
  }

  async newSession(): Promise<void> {
    if (!this.session) {
      // No in-process session to quiesce — an SDK session that never initialized.
      piWarn("newSession(): no in-process session to quiesce — starting fresh");
      this.emit({ type: "sessionReset" });
      this.dispose();
      await this.initialize({ fresh: true });
      return;
    }
    // Kill running bash before waiting for idle (otherwise waitForIdle hangs).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    try { this.session.abortBash?.(); } catch (e: any) { piWarn(`abortBash() failed: ${e?.message ?? e}`); }
    await this.session.agent.waitForIdle();
    // Tell the webview to wipe the old conversation BEFORE the fresh session replays into it.
    // Without this /new looks like it did nothing: the session really is disposed and recreated,
    // but the chat DOM, tool cards and bash blocks from the previous session stay on screen, so
    // there is no visible evidence anything happened. `sessionReset` and its handler (resetChat)
    // existed and were wired end-to-end in the webview — nothing in the extension ever SENT it.
    this.emit({ type: "sessionReset" });
    this.dispose();
    await this.initialize({ fresh: true });
  }

  /** Resume a past session from a .jsonl file path. Disposes current and re-initializes. */
  async resumeSession(filePath: string): Promise<{ success: boolean; error?: string }> {
    // Kill running bash before waiting for idle.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    try { this.session?.abortBash?.(); } catch (e: any) { piWarn(`abortBash() failed: ${e?.message ?? e}`); }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    try { await this.session?.agent.waitForIdle(); } catch (e: any) { piWarn(`waitForIdle() failed: ${e?.message ?? e}`); }
    this.dispose();
    return this.initialize({ openPath: filePath });
  }

  /** Write a session entry directly to the session file, bypassing SDK _persist quirks. */
  private _forcePersistEntry(entry: Record<string, unknown>): void {
    const sf = this.sessionManager?.getSessionFile?.();
    if (!sf) {
      piWarn("_forcePersistEntry: no session file");
      return;
    }
    // Append ONLY to a file the SDK has already created. The SDK defers session
    // writes — it buffers entries in memory and flushes them with the session
    // header via an EXCLUSIVE create (openSync wx) on the first assistant message
    // (session-manager.js). If we appendFileSync first we'd (a) create the file
    // early, so the SDK's wx open throws EEXIST and the turn fails, and (b) leave a
    // headerless, malformed file. So never create it here — skip until it exists.
    if (!fs.existsSync(sf)) {
      piDebug(`_forcePersistEntry: session file not yet created by SDK; skipping ${String(entry.type)}`);
      return;
    }
    try {
      fs.appendFileSync(sf, JSON.stringify(entry) + "\n");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      piWarn(`_forcePersistEntry failed: ${e.message}`);
    }
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    // The backend applies the switch (registry/catalog resolve + session.setModel) and returns
    // the applied identity, or null when it couldn't. PiService owns the post-step: cycle index,
    // status.
    const applied = await this.backend?.setModel(provider, modelId);
    if (!applied) { return; }
    // The backend already stored the applied identity (getModel()); PiService just owns
    // the cycle index + status refresh.
    this.cycleIndex = this.cycleModels.findIndex((m) => m.provider === provider && m.id === modelId);
    if (this.cycleIndex === -1) { this.cycleIndex = 0; }
    this.reportStatus();
  }

  async cycleModel(): Promise<void> {
    if (this.cycleModels.length === 0) {
      vscode.window.showWarningMessage("No models available. Configure an API key first.");
      return;
    }
    if (!this.backend) {
      vscode.window.showWarningMessage("Pi session not ready yet.");
      return;
    }
    this.cycleIndex = (this.cycleIndex + 1) % this.cycleModels.length;
    const next = this.cycleModels[this.cycleIndex];
    const prevId = this._model?.id ?? "?";
    // Delegated to the backend primitive (same switch as setModel); PiService owns the
    // post-step + the cycle notice.
    const applied = await this.backend.setModel(next.provider, next.id);
    if (!applied) { return; }
    // Backend owns the applied identity (getModel()); PiService owns the notice + status.
    if (this.cycleModels.length <= 1) {
      vscode.window.showInformationMessage(`Only ${next.id} configured. Click the model name in the status bar to add more.`);
    } else {
      vscode.window.showInformationMessage(`Model: ${prevId} → ${next.id}`);
    }
    this.reportStatus();
  }

  async setThinkingLevel(level: string): Promise<void> {
    if (!this.backend) {
      piWarn(`setThinkingLevel("${level}") ignored: session not initialized`);
      return;
    }
    // The backend sets the level and returns the EFFECTIVE level (the SDK records the clamped
    // level itself and echoes the request). No force-persist here — the SDK records the change
    // via its deferred append path (a direct write would duplicate it and create the file
    // early, EEXIST on first prompt).
    const effective = await this.backend.setThinkingLevel(level);
    // The backend stored the effective level (getThinkingLevel()); PiService keeps the
    // off→on toggle memory + status.
    this.rememberReasoning();
    this.reportStatus();
    // A clamp means the model genuinely doesn't support the requested level, so say so rather
    // than leaving the switch a silent no-op.
    if (effective !== level) {
      vscode.window.showInformationMessage(`${this._model?.id ?? "This model"} doesn't support thinking levels — staying at "${effective}".`);
    }
  }

  // ── Default model / thinking persistence ──────────────

  /** Save the current model as the default for future sessions. */
  saveDefaultModel(target: { provider?: string; id?: string } | null = this._model, scope: vscode.ConfigurationTarget = vscode.ConfigurationTarget.Global): void {
    if (!target?.provider || !target?.id) {
      piWarn("saveDefaultModel() called but no model is active — ignoring");
      return;
    }
    const cfg = vscode.workspace.getConfiguration("pi-code-gui");
    cfg.update("defaultModelProvider", target.provider, scope);
    cfg.update("defaultModelId", target.id, scope);
  }

  /** Save the current thinking level as the default for future sessions. */
  saveDefaultThinking(): void {
    const cfg = vscode.workspace.getConfiguration("pi-code-gui");
    cfg.update("defaultThinkingLevel", this._thinkingLevel, vscode.ConfigurationTarget.Global);
  }

  /** Get the configured default model (if any). */
  getDefaultModel(): { provider: string; id: string } | null {
    const cfg = vscode.workspace.getConfiguration("pi-code-gui");
    const provider = cfg.get<string>("defaultModelProvider");
    const id = cfg.get<string>("defaultModelId");
    return (provider && id) ? { provider, id } : null;
  }

  /** Get the configured default thinking level. */
  getDefaultThinking(): string {
    return vscode.workspace.getConfiguration("pi-code-gui").get<string>("defaultThinkingLevel") ?? "off";
  }

  /** Get the current context budget (0 = model default). */
  getContextBudget(): number {
    return vscode.workspace.getConfiguration("pi-code-gui").get<number>("contextBudget") ?? 0;
  }

  /** Save context budget setting (requires restart to take effect). */
  async setContextBudget(budget: number): Promise<void> {
    const cfg = vscode.workspace.getConfiguration("pi-code-gui");
    await cfg.update("contextBudget", budget, vscode.ConfigurationTarget.Global);
    this.reportStatus();
  }

  // ── Settings, models, scoped models ──────────────────

  get autoCompactionEnabled(): boolean { return this._autoCompactionEnabled; }
  get autoRetryEnabled(): boolean { return this._autoRetryEnabled; }
  get showImages(): boolean { return this._showImages; }
  get userMessages(): Array<{ id: string; text: string; timestamp?: number }> { return this._userMessages; }

  /** Get available models from the model runtime (for dynamic model pickers). */
  async getAvailableModels(): Promise<Array<{ provider: string; id: string; name?: string; cost?: { input: number; output: number }; contextWindow?: number }>> {
    // Delegated to the backend (the SDK's ModelRuntime.getAvailable).
    return (await this.backend?.getAvailableModels()) ?? [];
  }

  /** Open a QuickPick to choose a model, set it on this session, and optionally save as default.
   *  The choice list + item labelling is pure + tested (model-picker.ts); this owns the vscode
   *  glue and the setModel/save-default side effects. */
  async pickModel(): Promise<boolean> {
    // getAvailableModels() delegates to the backend (the SDK's ModelRuntime); the bundled
    // catalog is the fallback when it returns nothing.
    let models: ModelChoice[] = [];
    try {
      const available = await this.getAvailableModels();
      if (available.length > 0) { models = toModelChoices(available); }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      piWarn(`pickModel: getAvailableModels failed (${e.message}), using static fallback`);
    }
    if (models.length === 0) { models = resolveFallbackModels(this.catalogProviders); }

    const items = buildModelPickerItems(models, this.model?.id, this.getDefaultModel());
    const picked = await vscode.window.showQuickPick(items, { placeHolder: "Select model (\u2605 = default)", matchOnDetail: true });
    if (!picked) { return false; }

    await this.setModel(picked.provider, picked.modelId);

    // Offer to save as default if not already. BOTH answers are rows: a single-item QuickPick
    // left "no" to be expressed by dismissing it, which is not a visible option.
    if (!picked.isDefault) {
      const def = this.getDefaultModel();
      const choice = await vscode.window.showQuickPick(
        buildDefaultChoiceItems(picked.modelId, def ? def.id : null),
        { placeHolder: "Default model for future sessions" },
      );
      if (choice?.save) { this.saveDefaultModel(); }
    }

    return true;
  }

  /** The model catalog — the authoritative capability and price source of record (each model
   *  owner's published spec; e.g. DeepSeek documents reasoning_effort = high|max with
   *  low/medium→high and xhigh→max, encoded as a model's thinkingLevelMap). It is the bundled
   *  registry (model-registry.generated.json), generated from pi-ai. */
  private get catalogProviders(): CatalogProviders {
    return (bundledRegistry as unknown as { providers: CatalogProviders }).providers;
  }

  /** The full pi-ai model object for the active model (carries reasoning +
   *  thinkingLevelMap), or null when it can't be resolved. */
  private currentFullModel(): ThinkingModel | null {
    const id = this._model?.id; const provider = this._model?.provider;
    if (!id || !provider) { return null; }
    // Resolve the live pi-ai model from the registry, then reconcile it against the model
    // catalog so a custom ~/.pi/agent/models.json that omits `reasoning` can't downgrade a
    // known-reasoning model (shared with the init clamp).
    if (this.modelRuntime) {
      try {
        const m = this.modelRuntime.getModel(provider, id) as ThinkingModel | undefined;
        if (m) { return reconcileThinkingCapability(this.catalogProviders, provider, id, m); }
      } catch { /* fall through to the model catalog */ }
    }
    // Registry miss: use the model catalog.
    return findCatalogThinkingModel(this.catalogProviders, provider, id);
  }

  /** Thinking levels meaningful for the active model (per pi-ai metadata), lowest→
   *  highest. Falls back to the full graded range when the model isn't resolvable,
   *  so we only ever narrow the choices when we have real metadata to narrow by. */
  supportedThinkingLevels(): string[] {
    const full = this.currentFullModel();
    // When the model is fully unknown, offer the graded range speculatively — but NOT `max`:
    // an unresolved model gives us no evidence the backend supports it (getSupportedThinkingLevels
    // surfaces max only from an explicit per-model mapping, which this fallback has none of).
    return full ? getSupportedThinkingLevels(full) : THINKING_LEVELS.filter((l) => l !== "max");
  }

  /** Open a QuickPick to choose a thinking level, set it on this session, and optionally save as default. */
  async pickThinkingLevel(): Promise<boolean> {
    // off + the reasoning tiers this model honors, from the authoritative catalog
    // (currentFullModel) — e.g. DeepSeek collapses to off/high/xhigh.
    const supported = this.supportedThinkingLevels();
    const onLevels = supported.filter((l) => l !== "off");
    if (onLevels.length === 0) {
      // Genuinely non-reasoning per the catalog — there's no reasoning to adjust.
      vscode.window.showInformationMessage(`${this._model?.id ?? "This model"} doesn't use reasoning, so there's nothing to adjust.`);
      return false;
    }
    // Row assembly (Off + separator + supported levels, with marks) is pure + tested
    // (buildThinkingPickerRows); map its neutral rows to vscode QuickPick items here.
    type Item = vscode.QuickPickItem & { level?: string; isDefault?: boolean };
    const items: Item[] = buildThinkingPickerRows(onLevels, this.thinkingLevel, this.getDefaultThinking()).map((r) =>
      r.separator
        ? { label: r.label, kind: vscode.QuickPickItemKind.Separator }
        : { label: r.label, description: r.description, level: r.level, isDefault: r.isDefault },
    );

    const picked = await vscode.window.showQuickPick(items, { placeHolder: "Thinking & reasoning (\u2605 = default)" });
    if (!picked || picked.level === undefined) { return false; }

    await this.setThinkingLevel(picked.level);

    // Offer to save as default if not already
    if (!picked.isDefault) {
      const save = await vscode.window.showQuickPick(
        [{ label: "\u2605 Save as default", description: "Use this thinking level for future sessions" }],
        { placeHolder: `Use "${picked.level}" thinking as the default?` },
      );
      if (save) { this.saveDefaultThinking(); }
    }

    return true;
  }

  /** Get scoped models from the session */

  emitSettings(): void {
    this.emit({
      type: "settings-update",
      data: { autoCompaction: this._autoCompactionEnabled, autoRetry: this._autoRetryEnabled, showImages: this._showImages },
    });
  }

  async toggleAutoCompaction(): Promise<boolean> {
    const next = !this._autoCompactionEnabled;
    // The SDK applies the setting in-process, so flip eagerly (keeps the UI responsive), then
    // push it to the session through the backend primitive.
    this._autoCompactionEnabled = next;
    await this.backend?.setAutoCompaction(next);
    this.emitSettings();
    return this._autoCompactionEnabled;
  }

  async toggleAutoRetry(): Promise<boolean> {
    const next = !this._autoRetryEnabled;
    // Same eager flip as auto-compaction.
    this._autoRetryEnabled = next;
    await this.backend?.setAutoRetry(next);
    this.emitSettings();
    return this._autoRetryEnabled;
  }

  async toggleShowImages(): Promise<boolean> {
    this._showImages = !this._showImages;
    this.emitSettings();
    return this._showImages;
  }


  /** A ModelRuntime for side-calls (tab summary, /login): the SDK session's own when a session
   *  is up, else a lazily-created one (e.g. /login before a session could start). Cached. Null
   *  when the SDK can't be resolved, so the caller falls back. ModelRuntime.create() resolves
   *  auth from env/auth.json itself, so no key plumbing is needed. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _sharedRuntime: any = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async sharedModelRuntime(): Promise<any> {
    if (this.modelRuntime) { return this.modelRuntime; }      // reuse the session's runtime
    if (this._sharedRuntime) { return this._sharedRuntime; }  // cached lazy one
    try {
      const SDK = await importWithRetry(path.join(resolvePiPackagePath(), "dist/index.js"), 2, 300);
      this._sharedRuntime = await SDK.ModelRuntime.create();
      return this._sharedRuntime;
    } catch (e: unknown) {
      piWarn(`Tab summary: no ModelRuntime available (${e instanceof Error ? e.message : String(e)}) — keeping the raw first message.`);
      return null;
    }
  }

  /** Generate a short 3-word tab-title summary for the first user input, via a lightweight
   *  side-call on a ModelRuntime (the same model the session uses). */
  async generateTabSummary(userInput: string): Promise<string | null> {
    if (!this._model) { return null; }
    try {
      const rt = await this.sharedModelRuntime();
      if (!rt) { return null; }
      const model = rt.getModel(this._model.provider, this._model.id);
      if (!model) { return null; }

      // maxTokens caps output so a reasoning model can't burn tokens on a 3-word title;
      // completeSimple resolves auth from the runtime (no explicit key). Prompt/context build
      // + the reply cleaning are pure + tested (tab-summary.ts).
      const result = await rt.completeSimple(model, buildSummaryContext(userInput, Date.now()), { maxTokens: 20 });
      return cleanTabSummary(extractMessageText(result.content));
    } catch (e: unknown) {
      piWarn(`Tab summary generation failed: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
  }

  /** Set a runtime API key (not persisted to disk). Async on the new SDK. */
  async setRuntimeApiKey(provider: string, key: string): Promise<void> {
    if (this.modelRuntime && typeof this.modelRuntime.setRuntimeApiKey === "function") {
      await this.modelRuntime.setRuntimeApiKey(provider, key);
    }
  }

  // ── Usage / token stats ──────────────────────────────

  /** Per-million-token cost rates for the active model, from the model catalog, or
   *  null when we have no rate info (→ the status bar shows "$??" rather than $0). */
  private activeCostRates(): { input: number; output: number; cacheRead: number; cacheWrite: number } | null {
    const p = this._model?.provider; const id = this._model?.id;
    // Withhold rates we know cannot be right rather than pricing with them.
    if (catalogRatesAreUnexpressible(p, id)) { return null; }
    return (p && id) ? findCatalogModelCost(this.catalogProviders, p, id) : null;
  }

  getUsageStats(): UsageStats {
    // Raw token counts + context come from the backend primitive (SdkService sums its session
    // entries). The cost policy is the pure, tested computeUsageStats (src/usage-stats.ts).
    const u = this.backend?.getUsage() ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextPercent: null, contextWindow: 0 };
    return computeUsageStats(u, this.activeCostRates(),
      costWithheldReason(this._model?.provider, this._model?.id));
  }

  // ── Getters ────────────────────────────────────────────

  get isStreaming(): boolean { return this.backend?.isStreaming() ?? false; }
  get model(): { id?: string; name?: string; provider?: string } | null { return this._model; }
  /** The effective thinking level for the current model (stored level clamped to
   *  what the model honors) — so the status bar, picker, and cycle all show what's
   *  real, not a level the model silently ignores. */
  get thinkingLevel(): string { return this.realThinkingLevel(); }

  /** Promote a follow-up message to a steering message. Delegated to the backend: the SDK
   *  re-queues its steers then appends. */
  async promoteToSteer(text: string): Promise<void> {
    this.backend?.promoteToSteer(text);
  }

  /** Clear all queued messages (the SDK clears the session queue). */
  async clearQueue(): Promise<void> {
    await this.backend?.clearQueue();
  }
  get sdkRoot(): string | null { return this._piRoot; }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  get sessionManagerInstance(): any { return this.sessionManager; }
  /** The file path of the session file on disk (for persistence across reloads). */
  get sessionFilePath(): string | null {
    return this.sessionManager?.getSessionFile?.() ?? null;
  }
  get sessionIdValue(): string | null { return this.sessionId; }
  get initialized(): boolean { return this.session !== null; }

  /** Reload context files / extensions / skills in-session. False when the session has no
   *  in-session reload, so callers can explain instead of reaching for a raw session.
   *  Replaces the former `rawSession: any` getter that let extension.ts call .reload() straight
   *  through the PiBackend seam. */
  async reloadContext(): Promise<boolean> {
    return (await this.backend?.reloadContext()) ?? false;
  }
  /** Expose the model runtime for dynamic model pickers in the webview */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  get modelRuntimeInstance(): any { return this.modelRuntime; }

  /** The session display name (the SDK's SessionManager). */
  get sessionName(): string | undefined {
    return this.sessionManager?.getSessionName?.();
  }

  /** Persist a display name so it survives tab close AND shows in the Past Sessions tree. The
   *  SDK writes the entry through the seam. */
  setSessionName(name: string): void {
    void this.backend?.setSessionName(name).then((ok) => {
      if (!ok) { piWarn(`Session name "${name}" was not persisted by the session.`); }
    });
  }

  
  
  // ── Tools ───────────────────────────────────────────────

  /** Get all configured tools available for selection. */
  getAllTools(): Array<{ name: string; description: string; source: string }> {
    if (!this.session || typeof this.session.getAllTools !== "function") { return []; }
    return mapSessionTools(this.session.getAllTools());
  }

  /** Get names of currently active tools. */
  getActiveToolNames(): string[] {
    if (!this.session || typeof this.session.getActiveToolNames !== "function") { return []; }
    return this.session.getActiveToolNames();
  }

  /** Set which tools are active for the next agent turn. */
  setActiveTools(toolNames: string[]): void {
    if (!this.session || typeof this.session.setActiveToolsByName !== "function") {
      piWarn("setActiveTools: session not initialized or method unavailable");
      return;
    }
    this.session.setActiveToolsByName(toolNames);
    // Verify the update took effect
    const actualNames = this.session.getActiveToolNames();
    piDebug(`setActiveTools: requested ${toolNames.length}, actual ${actualNames.length} — ${actualNames.join(", ") || "(none)"}`);
    // Force-persist the tool selection so it survives session close/reopen
    this._forcePersistEntry({
      type: "tools_active_change",
      id: `pi-ext-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      parentId: null,
      timestamp: new Date().toISOString(),
      toolNames,
    });
    piDebug(`setActiveTools: ${toolNames.length} tools active`);
  }

  /** Walk session entries in reverse to find and apply the last tools_active_change. */
  private _restoreActiveToolsFromSession(): void {
    const toolNames = findLastActiveTools(this.sessionManager?.getEntries?.() ?? []);
    if (toolNames) {
      this.session.setActiveToolsByName(toolNames);
      piDebug(`Restored active tools from session: ${toolNames.join(", ")}`);
    }
  }

  /** Open a QuickPick to select which tools are active for this session. */
  async pickActiveTools(): Promise<boolean> {
    if (!this.session) {
      vscode.window.showWarningMessage("Pi session not ready yet.");
      return false;
    }

    const allTools = this.getAllTools();
    if (allTools.length === 0) {
      vscode.window.showInformationMessage("No tools available.");
      return false;
    }

    const activeNames = new Set(this.getActiveToolNames());
    piDebug(`pickActiveTools: ${activeNames.size} active tools — ${[...activeNames].join(", ") || "(none)"}`);

    // Grouping / picked-state is pure + tested (buildToolPickerRows); map its neutral rows to
    // vscode QuickPick items here.
    const items: vscode.QuickPickItem[] = buildToolPickerRows(allTools, activeNames).map((r) =>
      r.separator
        ? { label: `$(${r.icon}) ${r.label}`, kind: vscode.QuickPickItemKind.Separator }
        : { label: r.name, description: r.description, detail: r.source, picked: r.picked },
    );

    const picked = await vscode.window.showQuickPick(items, {
      canPickMany: true,
      placeHolder: `Select tools (${activeNames.size} active)`,
      matchOnDescription: true,
    });

    if (!picked) { return false; }

    const selectedNames = picked
      .filter((p) => p.kind !== vscode.QuickPickItemKind.Separator)
      .map((p) => p.label);

    this.setActiveTools(selectedNames);
    vscode.window.showInformationMessage(summarizeToolSelection(activeNames, selectedNames).summary);

    return true;
  }

  // ── Login / Logout ─────────────────────────────────────

  /**
   * Provider login (pi-coding-agent >= 0.80.8). The provider-owned flow is driven by
   * `ModelRuntime.login(providerId, "api_key"|"oauth", interaction)`, where `interaction`
   * is a pi-ai `AuthInteraction` — a unified `{ prompt, notify }` pair serving both the
   * API-key and OAuth flows. We adapt those callbacks to VS Code UI (input boxes / quick
   * picks / browser-open) via makeAuthInteraction. Replaces the removed AuthStorage flow.
   */
  async login(): Promise<void> { return runLogin(await this.makeAuthFlowDeps()); }

  async logout(): Promise<void> { return runLogout(await this.makeAuthFlowDeps()); }

  /** Real (vscode-backed) deps for the extracted, headlessly-tested login/logout flow. */
  private async makeAuthFlowDeps(): Promise<AuthFlowDeps> {
    return {
      // NOT this.modelRuntime — that is the SDK session's runtime and is null before a session
      // starts, so runLogin would throw "Pi session not initialized" before showing a single
      // prompt. sharedModelRuntime() falls back to a lazily built runtime.
      modelRuntime: await this.sharedModelRuntime(),
      getActiveModel: () => this._model,
      setModel: (provider, id) => this.setModel(provider, id),
      ui: {
        // The AbortSignal becomes a CancellationToken so a prompt left open when the flow
        // finishes by another route is actually dismissed (see AuthUI).
        quickPick: (items, opts, signal) => Promise.resolve(vscode.window.showQuickPick(items, opts, tokenFor(signal))),
        inputBox: (opts, signal) => Promise.resolve(vscode.window.showInputBox(opts, tokenFor(signal))),
        withProgress: (title, task) => Promise.resolve(vscode.window.withProgress(
          { location: vscode.ProgressLocation.Notification, title, cancellable: true },
          async (progress, token) => {
            const controller = new AbortController();
            token.onCancellationRequested(() => controller.abort());
            try {
              await task((message) => progress.report({ message }), controller.signal);
            } finally {
              // Abort on SUCCESS too, not just cancellation: that is what closes a prompt the
              // flow never consumed (e.g. the manual-code box when the browser callback won).
              controller.abort();
            }
          },
        )),
        openExternal: (url) => { void vscode.env.openExternal(vscode.Uri.parse(url)); },
        info: (message) => { void vscode.window.showInformationMessage(message); },
        error: (message) => { void vscode.window.showErrorMessage(message); },
      },
    };
  }

  // ── Cleanup ────────────────────────────────────────────

  dispose(): void {
    // Resolve any in-flight interactive dialogs with undefined so awaiting SDK
    // coroutines unblock and fall back to text prompts instead of hanging forever.
    for (const { resolve } of this._pendingDialogs.values()) {
      try { resolve(undefined); } catch { /* listener already gone */ }
    }
    this._pendingDialogs.clear();


    // Force-flush the session file to disk before tearing down.
    // The SDK defers all disk writes until the first assistant message
    // arrives, so if the model is slow or the user closes the tab early,
    // entries (including session_info with the tab name) exist only in
    // memory and would be lost.  _rewriteFile bypasses the deferral.

    const sm = this.sessionManager;
    if (sm && !sm.flushed && typeof sm._rewriteFile === "function") {
      try { sm._rewriteFile(); } catch (e: unknown) { piWarn(`Best-effort failure: ${e instanceof Error ? e.message : String(e)}`); }
    } else if (sm && !sm.flushed) {
      // _rewriteFile is a private SDK member reached through an `any` cast. If it's
      // gone, the SDK internals changed under us — warn loudly (a rename canary),
      // since an unflushed session may then silently fail to persist on dispose.
      piWarn("SessionManager._rewriteFile is missing — the private Pi SDK API may have changed; unflushed session entries could be lost on dispose.");
    }
    // Kill any running bash processes before tearing down the session.
    // Without this, processes orphaned by session close survive as zombies.
    try { this.session?.abortBash?.(); } catch (e: unknown) { piWarn(`Best-effort failure: ${e instanceof Error ? e.message : String(e)}`); }
    this._uiBridge?.dispose(); this._uiBridge = null;
    this.unsubscribe?.();
    this.session?.dispose();
    this.unsubscribe = null;
    // Drop all SDK references (session, managers, modules) in one place.
    this._sdk?.dispose();
    this._sdk = null;
  }
}
