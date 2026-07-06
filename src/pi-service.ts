import * as path from "node:path";
import * as fs from "node:fs";
import * as vscode from "vscode";

import { assertNever, type PiServiceEvent, type Runtime, validateExtensionToWebview } from "./types.js";
import { piDebug, piWarn } from "./logger.js";
import { humanizeProviderError } from "./extension-errors.js";
import { RUST_RPC, type RustResponse } from "./rust-process.js";

import { RustService, type RustHost, type RustDeps } from "./rust-service.js";
import { detectRustBinary, shouldDisableRustExtensions, rustExtensionsMode } from "./rust-resolver.js";
import { setupRustModels } from "./rust-models.js";
import { resolveRustSessionDir } from "./rust-sessions.js";
import { rustExportHtml } from "./rust-packages.js";
import { thinkingLevelIsLive, getSupportedThinkingLevels, clampThinkingLevel, findCatalogThinkingModel, findCatalogModelCost, computeTokenCost, reconcileThinkingCapability, THINKING_LEVELS, type ThinkingModel } from "./model-catalog.js";
import bundledRegistry from "./model-registry.generated.json";
import { buildPiPackageCandidates, pickPiPackagePath } from "./pi-package-path.js";


import { resolveWorkspaceCwd } from "./workspace.js";
import { translateAgentEvent, extractToolCalls, normalizeToolArgs, extractMessageText } from "./agent-events.js";
import { SdkService, importWithRetry, type PiSdk, type PiAi, type SdkDeps } from "./sdk-service.js";
import { createBridgeTools } from "./bridge-tools.js";
import { detectMissingRustTools, installCommandForPlatform } from "./rust-deps.js";
import type { BackendCapabilities, PiBackend } from "./pi-backend.js";

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

export class PiService {
  /** The TypeScript SDK runtime (module loading, auth, registry, session manager,
   *  agent session) — the TS-path counterpart of `_rust`. The legacy field names
   *  (session, SDK, AI, …) are kept as thin getters over this service so the
   *  class's many read sites stay unchanged and runtime-agnostic. */
  private _sdk: SdkService | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get session(): any { return this._sdk?.session ?? null; }
  private unsubscribe: (() => void) | null = null;
  private listeners: EventListener[] = [];
  private _model: { id?: string; name?: string; provider?: string; api?: string; reasoning?: boolean } | null = null;
  private _thinkingLevel = "off";
  /** Last non-"off" thinking level chosen, so turning Thinking back on restores the
   *  user's prior Reasoning level (falls back to the model's highest). */
  private _lastReasoningLevel: string | undefined;
  private _isStreaming = false;
  /** Guards against rust-pi emitting agent_end twice for one run (observed on
   *  the abort/error path); the duplicate would double-emit agent-end and
   *  double-refresh state. Set on agent_start, cleared on the first agent_end. */
  private _agentRunActive = false;
  /** Event types already logged as unhandled, so upstream protocol drift is
   *  surfaced once in the output channel rather than flooding it per event. */
  private _warnedUnknownEvents = new Set<string>();
  private sessionId: string | null = null;

  // ── Runtime selection: in-process TypeScript SDK vs out-of-process Rust ──
  private _backendKind: Runtime = "typescript";
  /** The out-of-process Rust runtime (process lifecycle, RPC handshake, event
   *  translation, synthetic queue, usage/entries). Non-null only for a Rust
   *  session; PiService delegates the Rust branch of each backend-aware method
   *  here. See src/rust-service.ts (and the RustHost contract it consumes). */
  private _rust: RustService | null = null;

  /** The active runtime as a PiBackend (in-process SDK or out-of-process Rust), or
   *  null before init / after a failed init. PiService delegates the primitive,
   *  runtime-divergent operations (sendPrompt, abort, compact, setModel, …) here
   *  instead of branching on `_backendKind` at each call site. Orchestration and UI
   *  (pickers, slash dispatch, status/cost formatting) stay in PiService. */
  private get backend(): PiBackend | null {
    return this._backendKind === "rust" ? this._rust : this._sdk;
  }

  // SDK state — owned by SdkService; exposed under the legacy names as getters.
  private get _piRoot(): string | null { return this._sdk?.piRoot ?? null; }
  /* eslint-disable @typescript-eslint/no-explicit-any -- SDK objects are dynamically typed */
  private get SDK(): PiSdk | null { return this._sdk?.SDK ?? null; }
  private get AI(): PiAi | null { return this._sdk?.AI ?? null; }
  private get authStorage(): any { return this._sdk?.authStorage ?? null; }
  private get modelRegistry(): any { return this._sdk?.modelRegistry ?? null; }
  private get settingsManager(): any { return this._sdk?.settingsManager ?? null; }
  private get sessionManager(): any { return this._sdk?.sessionManager ?? null; }
  private get resourceLoader(): any { return this._sdk?.resourceLoader ?? null; }

  // Model cycling state (populated dynamically from registry)
  private cycleModels: Array<{ provider: string; id: string; name?: string; cost?: { input: number; output: number }; contextWindow?: number }> = [];
  private cycleIndex = 0;

  // Track current assistant message content (for toolCall stubs during message_update)
  private currentAssistantToolCalls: Map<string, { toolName: string; toolCallId: string; args: any; lastPreviewEmit?: number }> = new Map();

  // Widget activity timer (cleared on dispose to prevent leaks)
  private _widgetTimer: ReturnType<typeof setInterval> | null = null;

  /* eslint-enable @typescript-eslint/no-explicit-any */

  // Pending interactive dialogs (select/confirm/input).  Maps dialog ID → Promise resolve.
  private _pendingDialogs = new Map<string, { resolve: (v: unknown) => void }>();

  // Turn tracking (like AgentSession._turnIndex in the SDK)
  private turnIndex = 0;

  // User message history for the resend/reuse feature (#2)
  private _userMessages: Array<{ id: string; text: string; timestamp?: number }> = [];

  // Settings state (#3)
  private _autoCompactionEnabled = true;
  private _autoRetryEnabled = true;
  private _showImages = true;

  constructor() {}

  // ── Public API ─────────────────────────────────────────

  onEvent(listener: EventListener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  private emit(event: PiServiceEvent): void {
    // ── Layer 1: Runtime protocol validation ───────────────
    // Validates every outgoing message against the Zod schema.
    // If validation fails, we STILL emit to avoid breaking existing
    // functionality, but log the error and show a diagnostic notification.
    const result = validateExtensionToWebview(event);
    if (!result.success) {
      piWarn(`[protocol] emit validation failed for type "${(event as Record<string, unknown>).type}": ${result.error}`);
      // Emit a visible diagnostic so the user (and us) can see the issue
      this.emitSafe({
        type: "custom-message",
        data: {
          customType: "pi-gui-diagnostic",
          content: `Protocol validation error (type: ${(event as Record<string, unknown>).type}): ${result.error.substring(0, 200)}`,
          display: false,
        },
      });
    }
    // Dispatch to listeners (always, even on validation failures for backward compat)
    for (const l of this.listeners) {
// eslint-disable-next-line @typescript-eslint/no-explicit-any
      try { l(event); } catch (e: any) {
        piWarn(`emit listener threw for type "${(event as Record<string, unknown>).type}": ${e?.message ?? e}`);
      }
    }
  }

  /** Emit without validation (used internally to avoid recursive validation on diagnostics). */
  private emitSafe(event: PiServiceEvent): void {
    for (const l of this.listeners) {
// eslint-disable-next-line @typescript-eslint/no-explicit-any
      try { l(event); } catch (e: any) {
        piWarn(`emitSafe listener threw for type "${(event as Record<string, unknown>).type}": ${e?.message ?? e}`);
      }
    }
  }

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

  async initialize(opts?: { fresh?: boolean; openPath?: string; runtime?: Runtime }): Promise<{ success: boolean; error?: string; errorKind?: string; warning?: string }> {
    const fresh = opts?.fresh ?? false;
    const openPath = opts?.openPath ?? null;

    // ── Runtime branch: Rust runs out-of-process via the RPC subprocess ──
    const runtime = opts?.runtime ?? this._backendKind;
    if (runtime === "rust") {
      return this.initializeRust({ fresh, openPath: openPath ?? undefined });
    }
    if (runtime !== "typescript") { assertNever(runtime, "runtime"); }
    this._backendKind = "typescript";
    // Re-init replaces any prior session: drop the stale reference NOW so a failed
    // init reports `initialized === false` instead of pointing at the abandoned
    // session (the getter can't otherwise distinguish "init succeeded" from
    // "stale leftover"). A live Rust runtime here is unexpected (runtimes never
    // hot-swap within a session window) — dispose it rather than leak the subprocess.
    // Re-init replaces any prior runtime state. A live Rust runtime here is
    // unexpected (runtimes never hot-swap within a session window) — dispose it
    // rather than leak the subprocess. Constructing a fresh SdkService below drops
    // any stale session reference, so a failed init reports `initialized === false`
    // instead of pointing at the abandoned session.
    if (this._rust) {
      piWarn("TypeScript init found a live Rust runtime on this service (unexpected) — disposing it");
      this._rust.dispose();
      this._rust = null;
    }

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
      return { success: false, error: init.error ?? "SDK initialization produced no session.", errorKind: init.errorKind, warning: init.warning };
    }
    this._model = init.model ?? null;
    this.cycleModels = init.cycleModels ?? [];
    this._thinkingLevel = init.thinkingLevel ?? "off";
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

    this.reportStatus();
    try {
      this.emitScopedModels();
      this.emitSettings();
      this.emitSlashCommands();
    } catch (e: unknown) {
      piWarn(`Post-init emissions failed: ${e instanceof Error ? e.message : String(e)}`);
    }

    return { success: true };
  }

  // ── Rust runtime (out-of-process RPC) ──────────────────

  /**
   * Initialize a session backed by the Rust Pi binary (`pi --mode rpc`).
   * The subprocess owns persistence and tool execution; we drive it over the
   * line-delimited JSON RPC protocol and route its events through the existing
   * handleAgentEvent path (the event shapes mirror the TS SDK's).
   */
  private async initializeRust(opts: { fresh?: boolean; openPath?: string }): Promise<{ success: boolean; error?: string; errorKind?: string; warning?: string }> {
    this._backendKind = "rust";
    this._rust = new RustService(this.makeRustHost(), this.makeRustDeps());
    const result = await this._rust.initialize(opts);
    // Mirror the pre-extraction contract: a failed init nulls the live runtime
    // (the old code nulled `this.rust`), so `initialized` reports false.
    // INVARIANT: `_backendKind` deliberately STAYS "rust" on failure (not reset to
    // "typescript") so a retry — e.g. the user reopening the session — re-enters
    // this Rust path rather than silently switching the session to the TS SDK.
    if (!result.success) { this._rust = null; }
    return result;
  }

  /** Real (vscode-backed) implementations of RustService's environment deps.
   *  RustService itself is vscode-free so its init/handshake sequence can be
   *  driven headlessly in unit tests with stubbed deps (see rust-service.test.ts). */
  private makeRustDeps(): RustDeps {
    return {
      detectBinary: () => detectRustBinary(),
      shouldDisableExtensions: (cwd) => shouldDisableRustExtensions(cwd),
      extensionsMode: () => rustExtensionsMode(),
      setupModels: () => setupRustModels(),
      sessionDir: () => resolveRustSessionDir(),
      workspaceCwd: () => resolveWorkspaceCwd(),
      config: () => {
        const cfg = vscode.workspace.getConfiguration("pi-code-gui");
        return {
          defaultModelProvider: cfg.get<string>("defaultModelProvider"),
          defaultModelId: cfg.get<string>("defaultModelId"),
          defaultThinkingLevel: cfg.get<string>("defaultThinkingLevel")?.trim() || "off",
          rustExtensionPolicy: cfg.get<string>("rustExtensionPolicy")?.trim() || "balanced",
          anthropicApiKey: cfg.get<string>("anthropicApiKey"),
          openaiApiKey: cfg.get<string>("openaiApiKey"),
          contextBudget: cfg.get<number>("contextBudget") ?? 0,
        };
      },
      showError: (message) => { void vscode.window.showErrorMessage(message); },
      exportHtml: (sessionFile, outputPath) => rustExportHtml(sessionFile, outputPath),
      detectMissingTools: async () => {
        const missing = await detectMissingRustTools();
        if (missing.length === 0) { return null; }
        return { names: missing.map((m) => m.cmds[0]), installHint: installCommandForPlatform(missing, process.platform) };
      },
      offerReopen: (sessionFile) => {
        // The session JSONL persists on disk; offer one-click recovery into a fresh
        // window via the existing resume flow — avoids in-place re-init (which would
        // replay history into the dead tab) and crash-loops (user-initiated).
        void vscode.window
          .showWarningMessage("Rust Pi exited unexpectedly.", "Reopen session")
          .then((choice) => {
            if (choice === "Reopen session") {
              void vscode.commands.executeCommand("pi-code-gui.resumePastSession", sessionFile);
            }
          });
      },
    };
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
          anthropicApiKey: cfg.get<string>("anthropicApiKey"),
          openaiApiKey: cfg.get<string>("openaiApiKey"),
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
      catalogProviders: () => this.bundledProviders,
      notifyOutdatedPiAi: (installed, supported) => {
        const UPDATE = "Update";
        void vscode.window.showWarningMessage(
          `The installed Pi (TypeScript) SDK is outdated: pi-ai ${installed}, but this extension targets ${supported}+. It still works, but update for full compatibility.`,
          UPDATE,
        ).then((choice) => {
          if (choice === UPDATE) {
            const term = vscode.window.createTerminal("Update Pi SDK");
            term.show();
            // Typed, not executed — the user reviews and runs it (modifies global npm).
            term.sendText("npm install -g @earendil-works/pi-coding-agent", false);
          }
        });
      },
    };
  }

  /** Build the RustHost callback surface RustService writes through — the explicit
   *  contract for the shared PiService state and capabilities the Rust subsystem
   *  needs (see src/rust-service.ts). Created fresh per Rust session. */
  private makeRustHost(): RustHost {
    return {
      emit: (e) => this.emit(e),
      handleAgentEvent: (e) => this.handleAgentEvent(e),
      reportStatus: () => this.reportStatus(),
      sendInitialMessages: (entries) => this.sendInitialMessages(entries),
      emitPostInitState: () => { this.emitScopedModels(); this.emitSettings(); this.emitSlashCommands(); },
      showDialog: (type, prompt, extras) => this._showDialog(type, prompt, extras),
      getAgentRunActive: () => this._agentRunActive,
      setAgentRunActive: (v) => { this._agentRunActive = v; },
      setStreaming: (v) => { this._isStreaming = v; },
      getModel: () => this._model,
      setModel: (m) => { this._model = m; },
      getThinkingLevel: () => this._thinkingLevel,
      setThinkingLevel: (level) => { this._thinkingLevel = level; this.rememberReasoning(); },
      setSessionId: (id) => { this.sessionId = id; },
      getCycleModels: () => this.cycleModels,
      setCycleModels: (list) => { this.cycleModels = list; },
      setAutoCompactionEnabled: (v) => { this._autoCompactionEnabled = v; },
      setAutoRetryEnabled: (v) => { this._autoRetryEnabled = v; },
    };
  }

  /** Runtime-agnostic session entries for the Open Sessions tree. The TS SDK
   *  exposes them via sessionManager.getEntries(); the out-of-process Rust
   *  runtime supplies them through the cached get_messages reply. */
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

    const emit = (event: PiServiceEvent): void => this.emit(event);

    // Active widgets keyed by widget key (rendered text per widget)
    const widgetTexts = new Map<string, string>();
    const widgetLastUpdate = new Map<string, number>();
    // Periodically check for stale widgets (not updated in 30s) and clear them.
    // This prevents orphaned animations from running forever when extensions
    // forget to call stopWidgetAnimation (e.g. pi-subagents async jobs).
    const MAX_WIDGET_IDLE_MS = 30_000;
    this._widgetTimer = setInterval(() => {
      const now = Date.now();
      for (const [key, lastUpdate] of widgetLastUpdate) {
        if (now - lastUpdate > MAX_WIDGET_IDLE_MS) {
          widgetTexts.delete(key);
          widgetLastUpdate.delete(key);
          emit({ type: "widget-update", data: { key, content: null } });
        }
      }
    }, 10_000);
    if (this._widgetTimer.unref) { this._widgetTimer.unref(); }

    // Base uiContext with the methods we explicitly support.
    // Wrapped in a Proxy so any unknown method calls (e.g. from TUI-only
    // extensions) silently no-op instead of throwing "is not a function".
    const baseUIContext = {
      notify: (message: string, level: "info" | "error") => {
        if (level === "error") {
          piWarn(`ui.notify(error): ${message.substring(0, 120)}`);
        }
        emit({
          type: "custom-message",
          data: {
            customType: level === "error" ? "error" : "extension-notify",
            content: message,
            timestamp: Date.now(),
          },
        });
      },
      setWidget: (key: string, factory: unknown) => {
        if (factory === undefined || factory === null) {
          // Clear widget
          widgetTexts.delete(key);
          widgetLastUpdate.delete(key);
          emit({
            type: "widget-update",
            data: { key, content: null },
          });
          return;
        }

        if (typeof factory !== "function") {
          piWarn(`setWidget("${key}"): factory is not a function (got ${typeof factory})`);
          return;
        }

        try {
          // Minimal Theme stub: fg returns text without ANSI codes.
          // Widgets render in an HTML webview so ANSI colors are unnecessary.
          const theme = {
            fg: (_role: string, text: string) => text,
          };
          // Minimal TUI stub — extensions that need tui methods won't work,
          // but pi-tldr and similar widgets only use theme.
          const tui = {};

          const component = (factory)(tui, theme) as {
            render?: (width: number) => string[];
          };
          if (!component || typeof component.render !== "function") {
            piWarn(`setWidget("${key}"): component.render is not a function`);
            return;
          }

          const lines = component.render(80);
          if (!Array.isArray(lines)) {
            piWarn(`setWidget("${key}"): render() did not return an array`);
            return;
          }

          // Strip any remaining ANSI escape codes (just in case)
          const ansiRegex = /\x1b\[[0-9;]*m|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[_][^\x07\x1b]*(?:\x07|\x1b\\)/g;
          const cleanLines = lines.map((l: string) => l.replace(ansiRegex, ""));
          const content = cleanLines.join("\n");

          // Skip if unchanged
          if (widgetTexts.get(key) === content) { return; }
          widgetTexts.set(key, content);
          widgetLastUpdate.set(key, Date.now());

          emit({
            type: "widget-update",
            data: { key, content },
          });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
          // Widget rendering is best-effort; don't crash the session.
          piWarn(`setWidget("${key}"): render error: ${e?.message ?? e}`);
        }
      },
      // Interactive methods — return Promises that resolve when the user
      // dismisses the dialog in the webview.  Falls back to undefined if
      // no webview panel is active (e.g. during tests).
      select: (prompt: string, options: string[]) => {
        return this._showDialog("select", prompt, { options });
      },
      confirm: (prompt: string) => {
        return this._showDialog("confirm", prompt, {});
      },
      input: (prompt: string, defaultValue?: string) => {
        return this._showDialog("input", prompt, { defaultValue });
      },
      custom: () => undefined,

      // TUI compatibility stubs discovered via the Proxy at runtime
      setToolsExpanded: (_expanded: boolean) => { /* stub — TUI widget expand/collapse */ },
      getToolsExpanded: () => false,
      requestRender: () => { /* stub — TUI repaint, not needed in webview */ },
      onTerminalInput: (_handler: unknown) => { /* stub */ },
      setStatus: (key: string, status: string | null) => {
        // Show as a widget card so status is visible in VS Code
        if (status === null || status === undefined) {
          widgetTexts.delete(`status-${key}`);
          emit({ type: "widget-update", data: { key: `status-${key}`, content: null } });
        } else {
          const content = `**${key}** ${status}`;
          widgetTexts.set(`status-${key}`, content);
          emit({ type: "widget-update", data: { key: `status-${key}`, content } });
        }
      },
    };

    // Proxy: log unknown method calls so we can see what TUI methods
    // extensions expect, then no-op gracefully instead of crashing.
    const uiContext = new Proxy(baseUIContext, {
      get(target, prop) {
// eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (prop in target) { return (target as any)[prop]; }
        if (typeof prop === "string" && !prop.startsWith("_")) {
          return (...args: unknown[]) => {
            piWarn(`ui.${prop}() called by extension but not implemented — args: ${JSON.stringify(args).substring(0, 200)}`);
          };
        }
        return undefined;
      },
    });

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
    const result: Array<{ cmd: string; desc: string; source: string }> = [];
    const isRust = this._backendKind === "rust";

    // ── Agent-provided commands (per runtime) ───────
    // These come from whichever agent is actually running this session, so each
    // runtime advertises only the commands it can service.
    if (isRust) {
      // The Rust runtime reports its own extensions / templates / skills over RPC.
      result.push(...(this._rust?.getSlashCommands() ?? []));
    } else {
      // TypeScript SDK: extension-registered commands + builtin prompt templates.
      try {
        const rawSession = (this.session);
        const runner = rawSession?._extensionRunner;
        if (runner && typeof runner.getRegisteredCommands === "function") {
          const commands = runner.getRegisteredCommands();
          if (commands && commands.length > 0) {
            for (const c of commands) {
              const source = c?.sourceInfo?.source
                ? `extension (${c.sourceInfo.source})`
                : "extension";
              result.push({ cmd: `/${c.invocationName}`, desc: c.description ?? "", source });
            }
          }
        }
      } catch (e: unknown) { piWarn(`Best-effort failure: ${e instanceof Error ? e.message : String(e)}`); }

      // Builtin prompt templates are TypeScript-SDK-registered (Rust supplies its
      // own via get_commands above), so they only apply to the TS runtime.
      result.push(
        { cmd: "/fix-diagnostics", desc: "Fix all diagnostics in open file", source: "builtin" },
        { cmd: "/explain-code", desc: "Explain the code at current cursor position", source: "builtin" },
        { cmd: "/refactor", desc: "Refactor the selected code", source: "builtin" },
      );
    }

    // ── GUI-orchestrated session commands (both runtimes) ───
    // The extension services these directly (pickers, session ops), branching
    // internally on the runtime, so they work from chat regardless of backend.
    result.push(
      { cmd: "/model", desc: "Switch model", source: "builtin" },
      { cmd: "/new", desc: "Start new session", source: "builtin" },
      { cmd: "/compact", desc: "Compact context", source: "builtin" },
      { cmd: "/settings", desc: "Open settings", source: "builtin" },
      { cmd: "/login", desc: "Configure provider authentication", source: "builtin" },
      { cmd: "/logout", desc: "Remove provider authentication", source: "builtin" },
      { cmd: "/debug", desc: "Dump webview state for troubleshooting", source: "builtin" },
    );

    // ── Capability-gated commands ───────────────────
    // Advertised only where the backend can service them (data flags, not a runtime
    // conditional). Rust's RPC can't run these from chat — use the Sessions view/palette.
    const caps = this.capabilities;
    if (caps.fork) { result.push({ cmd: "/resume", desc: "Resume a previous session", source: "builtin" }); }
    if (caps.fork) { result.push({ cmd: "/fork", desc: "Fork session from message", source: "builtin" }); }
    if (caps.exportHtml && caps.kind === "typescript") { result.push({ cmd: "/export", desc: "Export session to HTML", source: "builtin" }); }
    if (caps.toolsPicker) { result.push({ cmd: "/tools", desc: "Select which tools are active", source: "builtin" }); }

    return result;
  }

  /** Map a Rust `get_commands` reply into slash-command entries (tolerant of field naming). */
  /** Emit all registered slash commands to the webview for autocomplete. */
  emitSlashCommands(): void {
    const all = this.getAllSlashCommands();
    this.emit({
      type: "slash-commands-update",
      data: { commands: all },
    });
  }

  /** Send existing session messages to the webview on initial load (or after reload). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  async sendInitialMessages(providedEntries?: any[]): Promise<void> {
    // Build session context from the session manager, or from caller-provided
    // entries (the Rust runtime supplies these from its `get_messages` reply).
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

    // Pre-index tool results by call ID (O(n) instead of O(n²) .find() per entry)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    const toolResultsById = new Map<string, any>();
    for (const e of entries) {
      if (e.type === "message" && e.message?.role === "toolResult") {
        toolResultsById.set(e.message.toolCallId, e);
      }
    }

    // Replay entries top-down (oldest first), yielding to the event loop
    // between each entry.  This guarantees correct visual order (oldest at
    // top, newest at bottom) and prevents the synchronous DOM flood that
    // would crash the extension host on large sessions.
    const yieldTick = (): Promise<void> => new Promise((r) => setTimeout(r, 0));

    for (let i = 0; i < entries.length; i++) {
      const entry = entries[i];
      if (entry.type === "message" && entry.message) {
        const msg = entry.message;
        if (msg.role === "user") {
          const text = this.extractTextFromContent(msg.content);
          if (text) {
            this._userMessages.push({ id: msg.id ?? `user-${Date.now()}`, text, timestamp: msg.timestamp });
            if (this._userMessages.length > 50) { this._userMessages.shift(); }
            this.emit({ type: "chat-message", data: { role: "user", content: text, entryId: entry.id } });
          }
        } else if (msg.role === "assistant") {
          const text = this.extractTextFromContent(msg.content);
          const thinking = this.extractThinkingFromContent(msg.content);
          const toolCalls = this.extractToolCallsFromContent(msg.content);
          

          // Always emit assistant messages — even tool-only ones with no text.
          // Skipping them makes tool executions invisible on reload/resume.
          this.emit({ type: "assistant-start", data: { messageId: msg.id, entryId: entry.id } });
          // Emit thinking content first, then text
          if (thinking) {
            this.emit({ type: "thinking-delta", data: { delta: thinking } });
            this.emit({ type: "thinking-delta", data: { delta: "", done: true } });
          }
          if (text) {
            this.emit({ type: "stream-delta", data: { delta: text } });
          }
          this.emit({
            type: "assistant-end",
            data: {
              stopReason: msg.stopReason,
              errorMessage: msg.errorMessage,
              toolCalls: toolCalls.map((tc) => tc.id),
            },
          });

          for (const tc of toolCalls) {
            const toolResultEntry = toolResultsById.get(tc.id);
            if (tc.name === "bash" || tc.name === "exec") {
              this.emit({ type: "bash-start", data: { toolCallId: tc.id, command: tc.arguments?.command ?? "", entryId: toolResultEntry?.id } });
              const outputText = toolResultEntry?.message
                ? this.extractTextFromContent(toolResultEntry.message.content)
                : "";
              this.emit({
                type: "bash-end",
                data: { toolCallId: tc.id, command: tc.arguments?.command ?? "", exitCode: 0, cancelled: false, output: outputText, isError: false, entryId: toolResultEntry?.id },
              });
            } else {
              this.emit({ type: "tool-start", data: { toolCallId: tc.id, toolName: tc.name, args: normalizeToolArgs(tc.arguments), fromMessage: true, entryId: toolResultEntry?.id } });
              if (toolResultEntry?.message) {
                this.emit({ type: "tool-end", data: { toolCallId: tc.id, toolName: tc.name, result: toolResultEntry.message, isError: false, entryId: toolResultEntry?.id } });
              } else {
                this.emit({ type: "tool-end", data: { toolCallId: tc.id, toolName: tc.name, result: { content: [{ type: "text", text: "(completed)" }] }, isError: false, entryId: toolResultEntry?.id } });
              }
            }
          }
        } else if (msg.role === "custom") {
          this.emit({ type: "custom-message", data: { customType: msg.customType, content: msg.content, display: msg.display, details: msg.details, timestamp: msg.timestamp, entryId: entry.id } });
        } else if (msg.role === "bashExecution") {
          const bashEntryId = entry.id ?? `bash-${Date.now()}`;
          this.emit({ type: "bash-start", data: { toolCallId: bashEntryId, command: msg.command ?? "", entryId: entry.id } });
          this.emit({ type: "bash-end", data: { toolCallId: bashEntryId, command: msg.command ?? "", exitCode: msg.exitCode, cancelled: msg.cancelled, output: msg.output ?? "", isError: msg.exitCode !== 0 && msg.exitCode !== null, entryId: entry.id } });
        }
      } else if (entry.type === "compaction") {
        this.emit({
          type: "compaction-summary-message",
          data: { summary: entry.summary ?? "", tokensBefore: entry.tokensBefore ?? 0, timestamp: this._toTimestamp(entry.timestamp), entryId: entry.id },
        });
      }

      // Yield after every entry so the webview paints incrementally.
      await yieldTick();
    }
  }

  // ── Agent event → PiServiceEvent translation ────────────

  /** SDK entries store timestamps as ISO strings; protocol expects numbers. */
  private _toTimestamp(ts: unknown): number {
    if (typeof ts === "number") { return ts; }
    if (ts) { return Date.parse(String(ts)); }
    return Date.now();
  }

  /** Extract plain text from a message content (string or array) */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractTextFromContent(content: any): string {
    return extractMessageText(content);
  }

  /** Extract thinking content blocks from an assistant message content array */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractThinkingFromContent(content: any): string {
    if (!content) { return ""; }
    if (Array.isArray(content)) {
      return content
// eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((c: any) => c.type === "thinking")
// eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((c: any) => c.thinking)
        .join("\n");
    }
    return "";
  }

  /** Extract tool call content blocks from an assistant message. Delegates to
   *  the shared pure helper (single source of truth with translateAgentEvent). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  private extractToolCallsFromContent(content: any[]): Array<{ name: string; id: string; arguments: any }> {
    return extractToolCalls(content);
  }

  /** Get entries once per event, plus pre-built lookups to avoid O(n²) scans. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  private getEntriesWithLookups(): { entries: any[]; byMessageId: Map<string, any>; byToolCallId: Map<string, any> } {
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    const entries: any[] = this.sessionManager?.getEntries?.() ?? [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    const byMessageId = new Map<string, any>();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    const byToolCallId = new Map<string, any>();
    for (const e of entries) {
      if (e.type === "message") {
        if (e.message?.id) { byMessageId.set(e.message.id, e); }
        if (e.message?.role === "toolResult" && e.message?.toolCallId) {
          byToolCallId.set(e.message.toolCallId, e);
        }
      }
    }
    return { entries, byMessageId, byToolCallId };
  }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleAgentEvent(event: any): void {
    // The decision logic lives in the pure, unit-tested translateAgentEvent
    // (src/agent-events.ts). This shell builds the state snapshot, applies the
    // returned mutations, emits the events, then runs the trailing effects in
    // the original order: Rust subprocess effects before the data emits
    // (rust queue-clear emits its own queue-update first; captureContext feeds
    // the % reportStatus emits), and reportStatus after, reflecting post-event state.
    const r = translateAgentEvent(event, {
      backendKind: this._backendKind,
      agentRunActive: this._agentRunActive,
      lookups: this.getEntriesWithLookups(),
      userMessages: this._userMessages,
      toolCalls: this.currentAssistantToolCalls,
      now: Date.now(),
      prepareArgs: (toolName, args) => this._prepareToolArgs(toolName, args),
    });

    if (r.setAgentRunActive !== undefined) { this._agentRunActive = r.setAgentRunActive; }
    if (r.setStreaming !== undefined) { this._isStreaming = r.setStreaming; }
    if (r.setThinkingLevel !== undefined) { this._thinkingLevel = r.setThinkingLevel; }
    if (r.turnIndex === "reset") { this.turnIndex = 0; }
    else if (r.turnIndex === "increment") { this.turnIndex++; }
    if (r.clearToolCalls) { this.currentAssistantToolCalls.clear(); }

    if (r.effects.rustClearQueue) { this._rust?.clearQueueIfAny(); }
    if (r.effects.captureContext) { this._rust?.captureContext(r.effects.captureUsage); }

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
   * args unchanged when there is no matching tool def (e.g. under Rust).
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

  /** The composed Thinking/Reasoning status for the single status-bar chip, and
   *  whether it's an actionable (clickable) control. Thinking and Reasoning are two
   *  axes of ONE dial: "off" disables thinking; any other level enables it at that
   *  reasoning effort (mirrors the wire's `thinking.type` + `reasoning_effort`/`effort`
   *  fields). A Rust transport that can't transmit the level degrades to a read-only
   *  "reasoning: on/off" badge — the only real axis there. */
  thinkingStatus(): { text: string; clickable: boolean } {
    if (this._backendKind === "rust" && !thinkingLevelIsLive(this._model?.api)) {
      return { text: `reasoning: ${this._model?.reasoning ? "on" : "off"}`, clickable: false };
    }
    const level = this.realThinkingLevel();
    if (level === "off") { return { text: "thinking: off", clickable: true }; }
    return { text: `thinking: on · reasoning: ${level}`, clickable: true };
  }

  /** Remember the active reasoning level so toggling Thinking off→on can restore it. */
  private rememberReasoning(): void {
    if (this._thinkingLevel !== "off") { this._lastReasoningLevel = this._thinkingLevel; }
  }

  /** The reasoning level to apply when Thinking is turned on with no explicit choice:
   *  the last one used, else the model's highest supported level. */
  private defaultReasoningLevel(): string {
    const on = this.supportedThinkingLevels().filter((l) => l !== "off");
    if (this._lastReasoningLevel && on.includes(this._lastReasoningLevel)) { return this._lastReasoningLevel; }
    return on[on.length - 1] ?? "high";
  }

  /** Toggle Thinking on/off (the Thinking axis of the one dial). Off→on restores the
   *  last reasoning level (defaultReasoningLevel); on→off goes to "off". Returns false
   *  (after an honest notice) when there is nothing to toggle — a non-reasoning model
   *  or a Rust transport that can't transmit the level — so callers don't claim success. */
  async toggleThinking(): Promise<boolean> {
    const onLevels = this.supportedThinkingLevels().filter((l) => l !== "off");
    if (onLevels.length === 0) {
      vscode.window.showInformationMessage(`${this._model?.id ?? "This model"} doesn't use reasoning, so there's nothing to toggle.`);
      return false;
    }
    if (this._backendKind === "rust" && !thinkingLevelIsLive(this._model?.api)) {
      const on = this._model?.reasoning ?? false;
      vscode.window.showInformationMessage(`${this._model?.provider ?? "This provider"} self-allocates reasoning (currently ${on ? "on" : "off"}) — reasoning depth isn't adjustable for ${this._model?.id ?? "this model"}.`);
      return false;
    }
    const target = this.realThinkingLevel() === "off" ? this.defaultReasoningLevel() : "off";
    await this.setThinkingLevel(target);
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
        // Composed Thinking/Reasoning chip text + whether it's clickable (a no-op
        // Rust transport renders a read-only reasoning on/off badge). See thinkingStatus.
        thinkingDisplay: thinking.text,
        thinkingClickable: thinking.clickable,
        // Whether the active transport actually transmits the thinking level. Under
        // Rust this depends on the provider api (openai-completions = no-op); the TS
        // SDK handles thinking per-provider in-process, so keep it "live" there.
        thinkingLive: this._backendKind === "rust" ? thinkingLevelIsLive(this._model?.api) : true,
        reasoning: this._model?.reasoning,
        isStreaming: this._isStreaming,
        sessionId: this.sessionId ?? undefined,
        // On-disk session file (null until the first write). The webview persists this
        // into VS Code's webview state so deserializeWebviewPanel can re-attach the
        // session after a window reload.
        sessionFile: this.sessionFilePath ?? undefined,
        usage: stats,
        contextBudget: budget,
        runtime: this._backendKind,
      },
    });
  }

  // ── User actions ───────────────────────────────────────

// eslint-disable-next-line @typescript-eslint/no-explicit-any
  async sendPrompt(text: string, images?: any[], mode?: string): Promise<void> {
    if (this._backendKind === "rust") {
      if (!this._rust) { throw new Error("Rust Pi session not initialized"); }
      return this._rust.sendPrompt(text, images, mode);
    }
    if (!this.session) { throw new Error("Pi session not initialized"); }

    // Handle slash commands at the PiService level before forwarding to
    // session.prompt(). Builtin commands (from the SDK's BUILTIN_SLASH_COMMANDS
    // list) map to PiService methods.
    //
    // IMPORTANT: unhandled slash commands (extension commands like /tldr,
    // and unknown commands) MUST go through session.prompt() even during
    // streaming.  The SDK executes extension commands immediately regardless
    // of agent state, while steer()/followUp() explicitly reject them
    // ("extension commands cannot be queued").
    if (text.startsWith("/")) {
      const handled = await this.tryHandleCommand(text);
      if (handled) { return; }
      // Extension command or unknown slash — execute immediately via prompt(),
      // bypassing the steer/queue path below.
      await this.session.prompt(text);
      return;
    }

    if (mode === "steer" || mode === "queue") {
      if (images && images.length > 0) {
        throw new Error("Cannot attach images while agent is streaming");
      }
      try {
        if (mode === "queue") {
          await this.session.followUp(text);
        } else {
          await this.session.steer(text);
        }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (e: any) {
        // steer/followUp reject extension commands and prompt templates
        // during streaming — surface the error rather than swallowing it.
        const msg = e?.message ?? String(e);
        piWarn(`sendPrompt ${mode} failed: ${msg}`);
        const friendly = humanizeProviderError(msg);
        this.emit({
          type: "custom-message",
          data: {
            customType: "error",
            content: friendly ?? `${mode === "steer" ? "Steer" : "Queue"} failed: ${msg}`,
            timestamp: Date.now(),
          },
        });
      }
    } else {
// eslint-disable-next-line @typescript-eslint/no-explicit-any
      const opts: any = {};
      if (images && images.length > 0) {
        // Check if current model supports images; if not, try to auto-switch
        if (!this.activeModelSupportsImages()) {
          const visionModel = this.findVisionModel();
          if (visionModel) {
            // Auto-switch to a vision-capable model
            await this.setModel(visionModel.provider, visionModel.id);
            this.emit({
              type: "custom-message",
              data: {
                customType: "info",
                content: `Auto-switched to ${visionModel.id} (vision-capable) for image support.`,
                timestamp: Date.now(),
              },
            });
          } else {
            throw new Error(
              `Cannot send images: no vision-capable model available. ` +
              "Add an API key for Claude, GPT-4o, or Gemini to use images."
            );
          }
        }
        opts.images = images;
      }
      await this.session.prompt(text, opts);
    }
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
    const spaceIndex = text.indexOf(" ");
    const cmdName = spaceIndex === -1 ? text.slice(1) : text.slice(1, spaceIndex);

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
        const name = text.slice(6).trim();
        if (name) { this.session.setSessionName(name); }
        return true;
      }

      case "tree":
        await vscode.commands.executeCommand("pi-code-gui.sessions.focus");
        return true;

      case "compact": {
        const compactArgs = text.startsWith("/compact ") ? text.slice(9).trim() : undefined;
        await this.session.compact(compactArgs);
        return true;
      }

      case "export": {
        // Parse optional output path from text
        const exportArgs = text.startsWith("/export ") ? text.slice(8).trim() : undefined;
        const outputPath = exportArgs || vscode.Uri.joinPath(
          vscode.Uri.file(resolveWorkspaceCwd()),
          `pi-session-${this.sessionId?.slice(0, 8) ?? "export"}.html`
        ).fsPath;
        const result = await this.session.exportToHtml(outputPath);
        vscode.window.showInformationMessage(`Session exported to: ${result}`);
        return true;
      }

      case "reload": {
        await this.session.reload();
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
    // Both backends kill any running bash before stopping the LLM turn (agent.abort
    // alone would orphan child processes). See SdkService.abort / RustService.abort.
    // Both impls are synchronous (send / local calls); the union return is voided.
    void this.backend?.abort();
  }

  /**
   * Compact the conversation context. Delegated to the active backend: the Rust RPC
   * has an explicit `compact` command (with the auto-compaction-gate explanation);
   * the SDK path calls the in-process session (same call as the command-palette
   * `pi-code-gui.compact`). PiService no longer branches.
   */
  async compact(): Promise<void> {
    piDebug(`compact() invoked (backend=${this._backendKind})`);
    await this.backend?.compact();
  }

  /**
   * Export the conversation to HTML at `outputPath`. Runtime-aware: the
   * TypeScript SDK session exports directly; Rust shells out to `pi --export`
   * (rawSession is null under Rust). Returns the written path.
   */
  async exportToHtml(outputPath: string): Promise<string> {
    // Delegated to the active backend (PiBackend.exportToHtml): Rust shells out to
    // `pi --export`, the SDK exports the in-process session — PiService no longer branches.
    const backend = this._backendKind === "rust" ? this._rust : this._sdk;
    if (!backend) { throw new Error("No active session to export."); }
    return backend.exportToHtml(outputPath);
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
    if (this.listeners.length === 0) {
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
      piWarn("newSession() called but session not initialized — creating fresh");
      this.dispose();
      await this.initialize({ fresh: true });
      return;
    }
    // Kill running bash before waiting for idle (otherwise waitForIdle hangs).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    try { this.session.abortBash?.(); } catch (e: any) { piWarn(`abortBash() failed: ${e?.message ?? e}`); }
    await this.session.agent.waitForIdle();
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

  /** Run a Rust RPC for a user action, surfacing any failure — an RPC rejection
   *  (timeout / process exit) OR a {success:false} reply — as a one-line chat
   *  error prefixed with `label`, and returning null so the caller bails. Dedupes
   *  the identical error handling across setModel/cycleModel/setThinkingLevel.
   *  request() (correlated by id), not send(): the binary returns the outcome only
   *  in the response, which RustProcess drops if nothing awaits the id. */
  private async rustRequestOrError(command: string, payload: Record<string, unknown>, label: string): Promise<RustResponse | null> {
    if (!this._rust) { return null; }
    const fail = (m: string): null => { this.emit({ type: "custom-message", data: { customType: "error", content: `${label}: ${m}`, timestamp: Date.now() } }); return null; };
    const resp = await this._rust.request(command, payload, 15000)
      .catch((e: unknown) => fail(e instanceof Error ? e.message : String(e)));
    if (!resp) { return null; }
    if (!resp.success) { return fail(resp.error ?? "unknown error"); }
    return resp;
  }

  async setModel(provider: string, modelId: string): Promise<void> {
    if (this._backendKind === "rust") {
      // Apply the reply so a bad switch surfaces and the budget clamp / context-%
      // reflect the new model (with its real contextWindow) immediately.
      const resp = await this.rustRequestOrError(RUST_RPC.setModel, { provider, modelId }, `Could not switch model to ${modelId}`);
      if (!resp) { return; }
      this._rust?.applyState({ model: resp.data });
      this.cycleIndex = this.cycleModels.findIndex((m) => m.provider === provider && m.id === modelId);
      if (this.cycleIndex === -1) { this.cycleIndex = 0; }
      this.reportStatus();
      return;
    }
    if (!this.session || !this.AI) {
      piWarn(`setModel("${provider}/${modelId}") ignored: session not initialized`);
      return;
    }
    // Try registry first, then fall back to getModel
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    let model: any = null;
    if (this.modelRegistry) {
      model = this.modelRegistry.find(provider, modelId);
    }
    if (!model) {
      model = this.AI.getModel(provider, modelId);
    }
    if (model) {
      await this.session.setModel(model);
      this._model = { id: modelId, provider };
      this.cycleIndex = this.cycleModels.findIndex((m) => m.provider === provider && m.id === modelId);
      if (this.cycleIndex === -1) { this.cycleIndex = 0; }
      // No force-persist here: session.setModel() already records a model_change via
      // the SDK's appendModelChange (deferred, flushed with the session header on the
      // first assistant message). A direct write would duplicate it AND create the
      // file early, breaking the SDK's exclusive-create flush (EEXIST on first prompt).
      this.reportStatus();
    }
  }

  async cycleModel(): Promise<void> {
    if (this._backendKind === "rust") {
      if (this.cycleModels.length === 0) {
        vscode.window.showWarningMessage("No models available. Configure an API key first.");
        return;
      }
      this.cycleIndex = (this.cycleIndex + 1) % this.cycleModels.length;
      const next = this.cycleModels[this.cycleIndex];
      const resp = await this.rustRequestOrError(RUST_RPC.setModel, { provider: next.provider, modelId: next.id }, `Could not switch model to ${next.id}`);
      if (!resp) { return; }
      this._rust?.applyState({ model: resp.data });
      vscode.window.showInformationMessage(`Model: ${next.id}`);
      this.reportStatus();
      return;
    }
    if (!this.session || !this.AI) {
      vscode.window.showWarningMessage("Pi session not ready yet.");
      return;
    }
    if (this.cycleModels.length === 0) {
      vscode.window.showWarningMessage("No models available. Configure an API key first.");
      return;
    }
    this.cycleIndex = (this.cycleIndex + 1) % this.cycleModels.length;
    const next = this.cycleModels[this.cycleIndex];
    const model = this.AI.getModel(next.provider, next.id);
    if (model) {
      const prevId = this._model?.id ?? "?";
      await this.session.setModel(model);
      this._model = { id: next.id, provider: next.provider };
      if (this.cycleModels.length <= 1) {
        vscode.window.showInformationMessage(`Only ${next.id} configured. Click the model name in the status bar to add more.`);
      } else {
        vscode.window.showInformationMessage(`Model: ${prevId} → ${next.id}`);
      }
      this.reportStatus();
    }
  }

  async setThinkingLevel(level: string): Promise<void> {
    if (this._backendKind === "rust") {
      // Some provider transports (mistral-conversations and any unverified/unknown
      // api) never serialize the thinking level on the wire, so changing it would
      // be a silent no-op the binary still reports as success. Don't pretend:
      // reasoning is a fixed on/off property of the model there, not an adjustable
      // depth. (openai-completions/DeepSeek now DOES transmit it — see
      // thinkingLevelIsLive — so this guard no longer fires for it.)
      if (!thinkingLevelIsLive(this._model?.api)) {
        const on = this._model?.reasoning ?? false;
        vscode.window.showInformationMessage(`${this._model?.provider ?? "This provider"} self-allocates reasoning (currently ${on ? "on" : "off"}) — thinking depth isn't adjustable for ${this._model?.id ?? "this model"}.`);
        return;
      }
      const resp = await this.rustRequestOrError(RUST_RPC.setThinkingLevel, { level }, "Could not set thinking level");
      if (!resp) { return; }
      // The binary clamps the level to the model's capability (a non-reasoning
      // model forces "off") and returns no value, so re-read state to reflect
      // what was actually applied rather than what was requested.
      this._thinkingLevel = level;
      try {
        const st = await this._rust?.request(RUST_RPC.getState, {}, 8000);
        if (st?.success) { this._rust?.applyState(st.data); }
      } catch { /* keep optimistic level */ }
      // The binary clamps thinking to "off" for non-reasoning models. We override
      // its model list with the Pi catalog (correct reasoning flags), so a clamp
      // now means the model genuinely doesn't support thinking — say so rather than
      // leaving the switch a silent no-op.
      if (this._thinkingLevel !== level) {
        vscode.window.showInformationMessage(`${this._model?.id ?? "This model"} doesn't support thinking levels — staying at "${this._thinkingLevel}".`);
      }
      this.rememberReasoning();
      this.reportStatus();
      return;
    }
    if (!this.session) {
      piWarn(`setThinkingLevel("${level}") ignored: session not initialized`);
      return;
    }
    this.session.setThinkingLevel(level);
    this._thinkingLevel = level;
    this.rememberReasoning();
    this.reportStatus();
    // No force-persist here: session.setThinkingLevel() already records a
    // thinking_level_change via the SDK's appendThinkingLevelChange (deferred, and
    // with the CLAMPED effective level — more correct than the raw level). A direct
    // write would duplicate it AND create the file early (EEXIST on first prompt).
  }

  // ── Default model / thinking persistence ──────────────

  /** Save the current model as the default for future sessions. */
  saveDefaultModel(): void {
    if (!this._model?.provider || !this._model?.id) {
      piWarn("saveDefaultModel() called but no model is active — ignoring");
      return;
    }
    const cfg = vscode.workspace.getConfiguration("pi-code-gui");
    cfg.update("defaultModelProvider", this._model.provider, vscode.ConfigurationTarget.Global);
    cfg.update("defaultModelId", this._model.id, vscode.ConfigurationTarget.Global);
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

  /** Get available models from the model registry (for dynamic model pickers). */
  async getAvailableModels(): Promise<Array<{ provider: string; id: string; name?: string; cost?: { input: number; output: number }; contextWindow?: number }>> {
    if (!this.modelRegistry) { return []; }
    try {
      const available = await this.modelRegistry.getAvailable();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
      return available.map((m: any) => ({
        provider: m.provider,
        id: m.id,
        name: m.name,
        cost: m.cost ? { input: m.cost.input, output: m.cost.output } : undefined,
        contextWindow: m.contextWindow ?? undefined,
      }));
    } catch {
      return [];
    }
  }

  /** Format model specs (pricing + context window) for QuickPick detail. Returns empty string if no data. */
  static formatModelDetail(cost?: { input: number; output: number }, contextWindow?: number): string {
    const parts: string[] = [];
    if (cost) {
      parts.push(`$${cost.input}/$${cost.output} per M tokens`);
    }
    if (contextWindow) {
      parts.push(`${Math.round(contextWindow / 1000)}K context`);
    }
    return parts.join(" · ");
  }

  /** Open a QuickPick to choose a model, set it on this session, and optionally save as default. */
  async pickModel(): Promise<boolean> {
    interface ModelItem { label: string; provider: string; modelId: string; cost?: { input: number; output: number }; contextWindow?: number }
    let models: ModelItem[] = [];

    if (this._backendKind === "rust") {
      // Rust reports its own catalog via get_available_models (cached in
      // cycleModels) — which INCLUDES custom models.json entries. getAvailableModels()
      // is the TypeScript SDK registry (always empty under Rust), so it would hide
      // custom models and fall back to the static list.
      models = this.cycleModels.map((m) => ({
        label: m.name || m.id, provider: m.provider, modelId: m.id, cost: m.cost, contextWindow: m.contextWindow,
      }));
    } else {
      try {
        const available = await this.getAvailableModels();
        if (available.length > 0) {
          models = available.map((m) => ({
            label: m.name || m.id,
            provider: m.provider,
            modelId: m.id,
            cost: m.cost,
            contextWindow: m.contextWindow,
          }));
        }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (e: any) {
        piWarn(`pickModel: getAvailableModels failed (${e.message}), using static fallback`);
      }
    }

    // Fallback: static list of common models (no pricing — only SDK-reported pricing is shown)
    if (models.length === 0) {
      models = [
        { label: "Claude Sonnet 4.5", provider: "anthropic", modelId: "claude-sonnet-4-5" },
        { label: "Claude Haiku 4.5", provider: "anthropic", modelId: "claude-haiku-4-5" },
        { label: "Claude Opus 4.5", provider: "anthropic", modelId: "claude-opus-4-5" },
        { label: "GPT 4o", provider: "openai", modelId: "gpt-4o" },
        { label: "Gemini 2.5 Pro", provider: "google", modelId: "gemini-2.5-pro" },
        { label: "DeepSeek V3", provider: "deepseek", modelId: "deepseek-chat" },
      ];
    }

    const currentId = this.model?.id;
    const defModel = this.getDefaultModel();
    const items = models.map((m) => {
      const isDefault = defModel && m.provider === defModel.provider && m.modelId === defModel.id;
      return {
        label: `${m.label}${m.modelId === currentId ? " $(check)" : ""}${isDefault ? " \u2605" : ""}`,
        description: m.provider,
        detail: PiService.formatModelDetail(m.cost, m.contextWindow),
        provider: m.provider,
        modelId: m.modelId,
        isDefault,
      };
    });

    const picked = await vscode.window.showQuickPick(items, { placeHolder: "Select model (\u2605 = default)", matchOnDetail: true });
    if (!picked) { return false; }

    await this.setModel(picked.provider, picked.modelId);

    // Offer to save as default if not already
    if (!picked.isDefault) {
      const save = await vscode.window.showQuickPick(
        [{ label: "\u2605 Save as default", description: "Use this model for future sessions" }],
        { placeHolder: `Use as default?` },
      );
      if (save) { this.saveDefaultModel(); }
    }

    return true;
  }

  /** The full pi-ai model object for the active model (carries reasoning +
   *  thinkingLevelMap), or null when it can't be resolved from the registry. */
  /** The bundled pi-ai catalog providers map — the authoritative capability source of
   *  record (each model owner's published spec; e.g. DeepSeek documents reasoning_effort
   *  = high|max with low/medium→high and xhigh→max, encoded as a model's thinkingLevelMap). */
  private get bundledProviders(): Record<string, { models: Array<ThinkingModel & { id: string; cost?: { input: number; output: number; cacheRead: number; cacheWrite: number } }> }> | undefined {
    return (bundledRegistry as { providers?: Record<string, { models: Array<ThinkingModel & { id: string; cost?: { input: number; output: number; cacheRead: number; cacheWrite: number } }> }> }).providers;
  }

  private currentFullModel(): ThinkingModel | null {
    const id = this._model?.id; const provider = this._model?.provider;
    if (!id || !provider) { return null; }
    // TS SDK path: resolve the live pi-ai model from the registry, then reconcile it
    // against the bundled catalog so a custom ~/.pi/agent/models.json that omits
    // `reasoning` can't downgrade a known-reasoning model (shared with the init clamp).
    if (this.modelRegistry) {
      try {
        const m = this.modelRegistry.find(provider, id) as ThinkingModel | undefined;
        if (m) { return reconcileThinkingCapability(this.bundledProviders, provider, id, m); }
      } catch { /* fall through to the bundled catalog */ }
    }
    // Rust path (no SDK ModelRegistry — see initializeRust) or registry miss: use the
    // bundled catalog. NOT rust-pi's get_state.reasoning, which is only the executor's
    // heuristic and has classified models wrongly before.
    const bundled = findCatalogThinkingModel(this.bundledProviders, provider, id);
    if (bundled) { return bundled; }
    // Absent from the bundled catalog: last resort, rust-pi's reported reasoning flag —
    // only to avoid offering a graded picker the runtime would no-op. A fallback
    // heuristic, not an authoritative capability source.
    if (this._model?.reasoning === undefined) { return null; }
    return { reasoning: this._model.reasoning };
  }

  /** Thinking levels meaningful for the active model (per pi-ai metadata), lowest→
   *  highest. Falls back to the full graded range when the model isn't resolvable,
   *  so we only ever narrow the choices when we have real metadata to narrow by. */
  supportedThinkingLevels(): string[] {
    const full = this.currentFullModel();
    return full ? getSupportedThinkingLevels(full) : [...THINKING_LEVELS];
  }

  /** Open a QuickPick to choose a thinking level, set it on this session, and optionally save as default. */
  async pickThinkingLevel(): Promise<boolean> {
    // Under Rust on a transport that doesn't transmit the level, a graded picker
    // would be a no-op — surface the honest reasoning on/off state instead.
    if (this._backendKind === "rust" && !thinkingLevelIsLive(this._model?.api)) {
      const on = this._model?.reasoning ?? false;
      vscode.window.showInformationMessage(`${this._model?.provider ?? "This provider"} self-allocates reasoning (currently ${on ? "on" : "off"}) — thinking depth isn't adjustable for ${this._model?.id ?? "this model"}.`);
      return false;
    }
    // off + the reasoning tiers this model honors, from the authoritative catalog
    // (currentFullModel) — e.g. DeepSeek collapses to off/high/xhigh.
    const supported = this.supportedThinkingLevels();
    const onLevels = supported.filter((l) => l !== "off");
    if (onLevels.length === 0) {
      // Genuinely non-reasoning per the catalog — there's no reasoning to adjust.
      vscode.window.showInformationMessage(`${this._model?.id ?? "This model"} doesn't use reasoning, so there's nothing to adjust.`);
      return false;
    }
    const REASONING_DESCR: Record<string, string> = {
      minimal: "minimal reasoning", low: "brief reasoning", medium: "balanced reasoning",
      high: "extended reasoning", xhigh: "maximum reasoning",
    };
    const current = this.thinkingLevel;
    const defLevel = this.getDefaultThinking();
    const fmt = (lvl: string, label: string): string =>
      `${lvl === current ? "$(check) " : ""}${label}${lvl === defLevel ? " ★" : ""}`;
    type Item = vscode.QuickPickItem & { level?: string; isDefault?: boolean };
    const items: Item[] = [
      { label: fmt("off", "Off"), description: "thinking off", level: "off", isDefault: defLevel === "off" },
      { label: "Reasoning level", kind: vscode.QuickPickItemKind.Separator },
      ...onLevels.map((l) => ({ label: fmt(l, l), description: REASONING_DESCR[l] ?? "reasoning", level: l, isDefault: l === defLevel })),
    ];

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
  getScopedModels(): Array<{ provider: string; id: string; thinkingLevel: string }> {
    if (!this.session || !this.session.scopedModels) { return []; }
    return this.session.scopedModels
      .filter((s: Record<string, unknown>) => s.model !== null && s.model !== undefined)
      .map((s: Record<string, unknown>) => ({
        provider: (s.model as Record<string, unknown>).provider as string,
        id: (s.model as Record<string, unknown>).id as string,
        thinkingLevel: (s.thinkingLevel as string) ?? "off",
      }));
  }

  emitScopedModels(): void {
    this.emit({ type: "scoped-models-update", data: { models: this.getScopedModels() } });
  }

  emitSettings(): void {
    this.emit({
      type: "settings-update",
      data: { autoCompaction: this._autoCompactionEnabled, autoRetry: this._autoRetryEnabled, showImages: this._showImages },
    });
  }

  async toggleAutoCompaction(): Promise<boolean> {
    const next = !this._autoCompactionEnabled;
    // State-flip policy is the one genuine divergence: the Rust RPC flips PiService
    // state via the RustHost callback only on success (optimistic-safe); the SDK
    // flips eagerly then pushes to the session. The wire call itself is now the
    // backend primitive (setAutoCompaction), not inline RPC/session plumbing.
    if (this._backendKind !== "rust") { this._autoCompactionEnabled = next; }
    await this.backend?.setAutoCompaction(next);
    this.emitSettings();
    return this._autoCompactionEnabled;
  }

  async toggleAutoRetry(): Promise<boolean> {
    const next = !this._autoRetryEnabled;
    // Same flip policy as auto-compaction. setAutoRetry is a no-op on the SDK (no
    // session toggle); Rust applies it over RPC and echoes state via the host callback.
    if (this._backendKind !== "rust") { this._autoRetryEnabled = next; }
    await this.backend?.setAutoRetry(next);
    this.emitSettings();
    return this._autoRetryEnabled;
  }

  async toggleShowImages(): Promise<boolean> {
    this._showImages = !this._showImages;
    this.emitSettings();
    return this._showImages;
  }


  /** Generate a short 3-word tab title summary for the first user input in a session. */
  async generateTabSummary(userInput: string): Promise<string | null> {
    if (!this.AI || !this._model) { return null; }

    try {
      const model = this.AI.getModel(this._model.provider, this._model.id);
      if (!model) { return null; }

      const apiKey = this.authStorage
        ? await this.authStorage.getApiKey(this._model.provider!)
        : undefined;

      const context = {
        systemPrompt: "Generate a concise 3-word summary of the following user request. Respond with ONLY the three words, lowercase, no punctuation, no quotes, no explanation.",
        messages: [
          { role: "user", content: userInput, timestamp: Date.now() },
        ],
      };

      const result = await this.AI.complete(model, context, {
        maxTokens: 20,
        apiKey,
      });

      const text = this.extractTextFromContent(result.content);
      if (text) {
        // Clean up: take first line, trim, limit to ~40 chars
        return text.split("\n")[0].trim().replace(/^["']|["']$/g, "").slice(0, 40);
      }
      return null;
    } catch {
      return null;
    }
  }

  /** Set a runtime API key (not persisted to disk) */
  setRuntimeApiKey(provider: string, key: string): void {
    if (this.authStorage && typeof this.authStorage.setRuntimeApiKey === "function") {
      this.authStorage.setRuntimeApiKey(provider, key);
    }
  }

  // ── Usage / token stats ──────────────────────────────

  /** Per-million-token cost rates for the active model, from the bundled catalog, or
   *  null when we have no rate info (→ the status bar shows "$??" rather than $0). */
  private activeCostRates(): { input: number; output: number; cacheRead: number; cacheWrite: number } | null {
    const p = this._model?.provider; const id = this._model?.id;
    return (p && id) ? findCatalogModelCost(this.bundledProviders, p, id) : null;
  }

  getUsageStats(): {
    input: number;
    output: number;
    cacheRead: number;
    cacheWrite: number;
    cost: number;
    /** False when we have no cost rates for the model → render "$??", not "$0". */
    costKnown: boolean;
    contextPercent: number | null;
    contextWindow: number;
  } {
    // Raw token counts + context come from the active backend primitive
    // (SdkService sums its session entries; RustService caches get_session_stats).
    // The COST POLICY is the genuine runtime divergence kept here: the Rust binary
    // reports cost:0 (it doesn't compute cost), so we derive it from tokens × the
    // catalog's published rates; the SDK computes its own per-turn cost (u.cost).
    const u = this.backend?.getUsage() ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextPercent: null, contextWindow: 0 };
    const rates = this.activeCostRates();
    if (this._backendKind === "rust") {
      return { ...u, cost: rates ? computeTokenCost(u, rates) : 0, costKnown: rates !== null };
    }
    // Known when the SDK actually computed a cost, or we hold rates for the model
    // (a rates-bearing model with no turns yet legitimately shows $0.00, not $??).
    const costKnown = u.cost > 0 || rates !== null;
    return { ...u, costKnown };
  }

  // ── Getters ────────────────────────────────────────────

  get isStreaming(): boolean { return this._isStreaming; }
  get model(): { id?: string; name?: string; provider?: string } | null { return this._model; }
  /** The effective thinking level for the current model (stored level clamped to
   *  what the model honors) — so the status bar, picker, and cycle all show what's
   *  real, not a level the model silently ignores. */
  get thinkingLevel(): string { return this.realThinkingLevel(); }
  /** Which runtime backs this session: "typescript" (in-process SDK) or "rust" (RPC subprocess). */
  get runtime(): Runtime { return this._backendKind; }

  /** The active backend's capability flags — the data-driven replacement for scattered
   *  `_backendKind === "rust"` feature gates. Falls back to a runtime-appropriate default
   *  when the service isn't live yet (e.g. mid-init or after a failed init). */
  get capabilities(): BackendCapabilities {
    const active = this._backendKind === "rust" ? this._rust : this._sdk;
    if (active) { return active.capabilities; }
    // No live service: minimal defaults keyed off the attempted runtime.
    const rust = this._backendKind === "rust";
    return {
      kind: this._backendKind, bridgeTools: !rust, customCards: !rust, toolsPicker: !rust,
      fork: !rust, reloadContext: !rust, exportHtml: true, rename: !rust,
      interceptSlashCommands: !rust, thinkingLevelLive: () => !rust,
    };
  }

  /** Promote a follow-up message to a steering message. Delegated to the backend:
   *  the SDK re-queues its steers then appends; Rust moves it in the synthetic queue
   *  and re-sends over the steer channel (it auto-processes steers). */
  async promoteToSteer(text: string): Promise<void> {
    this.backend?.promoteToSteer(text);
  }

  /** Clear all queued messages. The SDK clears the session queue; Rust clears only
   *  its local pending indicator (rust-pi has already accepted/auto-processed them). */
  async clearQueue(): Promise<void> {
    await this.backend?.clearQueue();
  }
  get sdkRoot(): string | null { return this._piRoot; }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  get sessionManagerInstance(): any { return this.sessionManager; }
  /** The file path of the session file on disk (for persistence across reloads). */
  get sessionFilePath(): string | null {
    return this.sessionManager?.getSessionFile?.() ?? this._rust?.getSessionPath() ?? null;
  }
  get sessionIdValue(): string | null { return this.sessionId; }
  get initialized(): boolean { return this.session !== null || this._rust !== null; }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  get rawSession(): any { return this.session; }
  /** Expose the model registry for dynamic model pickers in the webview */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  get modelRegistryInstance(): any { return this.modelRegistry; }

  /** Get the session display name from the session manager, if set. */
  get sessionName(): string | undefined {
    return this.sessionManager?.getSessionName?.();
  }

  /** Persist a display name to the session file so it survives tab close. */
  setSessionName(name: string): void {
    this.session?.setSessionName?.(name);
  }

  // ── Tools ───────────────────────────────────────────────

  /** Get all configured tools available for selection. */
  getAllTools(): Array<{ name: string; description: string; source: string }> {
    if (!this.session || typeof this.session.getAllTools !== "function") { return []; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.session.getAllTools().map((t: any) => ({
      name: t.name,
      description: t.description ?? "",
      source: t.sourceInfo?.source ?? "sdk",
    }));
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
    const entries = this.sessionManager?.getEntries?.() ?? [];
    if (!entries.length) { return; }
    for (let i = entries.length - 1; i >= 0; i--) {
      const e = entries[i];
      if (e.type === "tools_active_change" && Array.isArray(e.toolNames) && e.toolNames.length > 0) {
        this.session.setActiveToolsByName(e.toolNames);
        piDebug(`Restored active tools from session: ${e.toolNames.join(", ")}`);
        return;
      }
    }
  }

  /** Open a QuickPick to select which tools are active for this session. */
  async pickActiveTools(): Promise<boolean> {
    if (this._backendKind === "rust") {
      vscode.window.showInformationMessage("Per-session tool selection isn't available for Rust sessions — Rust uses its full built-in tool set.");
      return false;
    }
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

    // Group by source for a cleaner pick list
    const builtinTools = allTools.filter((t) => t.source === "builtin");
    const bridgeTools = allTools.filter((t) => t.source === "sdk" && t.name.startsWith("vscode_"));
    const extensionTools = allTools.filter((t) => t.source !== "builtin" && !t.name.startsWith("vscode_"));

    const items: vscode.QuickPickItem[] = [];

    const addGroup = (label: string, tools: typeof allTools): void => {
      if (tools.length === 0) { return; }
      const icon = label === "Built-in" ? "tools" : label === "VS Code Bridge" ? "extensions" : "symbol-misc";
      items.push({ label: `$(${icon}) ${label}`, kind: vscode.QuickPickItemKind.Separator });
      for (const t of tools) {
        items.push({
          label: t.name,
          description: t.description,
          detail: t.source,
          picked: activeNames.has(t.name),
        });
      }
    };

    addGroup("Built-in", builtinTools);
    addGroup("VS Code Bridge", bridgeTools);
    addGroup("Extension", extensionTools);

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

    const added = selectedNames.filter((n) => !activeNames.has(n)).length;
    const removed = activeNames.size - selectedNames.filter((n) => activeNames.has(n)).length;
    const parts: string[] = [];
    if (added > 0) { parts.push(`+${added}`); }
    if (removed > 0) { parts.push(`-${removed}`); }
    vscode.window.showInformationMessage(
      `Tools updated: ${selectedNames.length} active${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`,
    );

    return true;
  }

  // ── Login / Logout ─────────────────────────────────────

  /**
   * Show the login flow for a provider.
   * Mirrors the pi CLI's /login command:
   * 1. Select auth type (subscription/OAuth vs API key)
   * 2. Select provider
   * 3. For OAuth: open browser and complete OAuth flow
   * 4. For API key: prompt for key and save it
   */
  async login(): Promise<void> {
    if (!this.authStorage || !this.modelRegistry) {
      throw new Error("Pi session not initialized");
    }

    // ── Step 1: Auth type selector ─────────────────────
    const authType = await this.pickAuthType();
    if (!authType) { return; } // cancelled

    // ── Step 2: Provider selector ───────────────────────
    const providerChoice = await this.pickLoginProvider(authType);
    if (!providerChoice) { return; } // cancelled

    // ── Step 3: Execute login ───────────────────────────
    if (providerChoice.authType === "oauth") {
      await this.doOAuthLogin(providerChoice.id, providerChoice.name);
    } else if (providerChoice.id === "amazon-bedrock") {
      await this.showInfoMessage(
        "Amazon Bedrock uses AWS credentials. Configure an AWS profile, IAM keys, or role-based credentials.",
      );
    } else {
      await this.doApiKeyLogin(providerChoice.id, providerChoice.name);
    }
  }

  /** Show the auth type picker: Subscription (OAuth) vs API Key */
  private async pickAuthType(): Promise<"oauth" | "api_key" | undefined> {
    const ITEMS = [
      { label: "Use a subscription", authType: "oauth" as const, description: "OAuth login for Anthropic, GitHub Copilot, OpenAI Codex" },
      { label: "Use an API key", authType: "api_key" as const, description: "Enter an API key for any provider" },
    ];
    const pick = await this.showQuickPick(ITEMS, "Select authentication method:");
    return pick?.authType;
  }

  /** Show provider picker for a given auth type */
  private async pickLoginProvider(
    authType: "oauth" | "api_key",
  ): Promise<{ id: string; name: string; authType: string } | undefined> {
    const options = this.getLoginProviderOptions(authType);
    if (options.length === 0) {
      const label = authType === "oauth" ? "No subscription providers available." : "No API key providers available.";
      await this.showInfoMessage(label);
      return undefined;
    }
    const pick = await this.showQuickPick(options, `Select ${authType === "oauth" ? "subscription" : "API key"} provider:`);
    return pick;
  }

  /** Build the list of provider options for login */
  private getLoginProviderOptions(
    authType: "oauth" | "api_key",
  ): Array<{ id: string; name: string; authType: string; label: string; description: string }> {
    const oauthProviders = this.authStorage.getOAuthProviders();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    const oauthProviderIds = new Set(oauthProviders.map((p: any) => p.id));
    const options: Array<{ id: string; name: string; authType: string; label: string; description: string }> = [];

    if (authType === "oauth") {
      // OAuth providers
      for (const provider of oauthProviders) {
        const authStatus = this.modelRegistry.getProviderAuthStatus(provider.id);
        options.push({
          id: provider.id,
          name: provider.name,
          authType: "oauth",
          label: provider.name,
          description: authStatus?.configured ? "$(check) Already configured" : "",
        });
      }
    } else {
      // API key providers — all model providers that aren't OAuth-only
      const allModels = this.modelRegistry.getAll();
      const seenProviders = new Set<string>();
      for (const model of allModels) {
        const providerId = model.provider;
        if (seenProviders.has(providerId)) { continue; }
        seenProviders.add(providerId);
        // Skip providers that only support OAuth
        if (oauthProviderIds.has(providerId)) { continue; }
        const displayName = this.modelRegistry.getProviderDisplayName(providerId);
        const authStatus = this.modelRegistry.getProviderAuthStatus(providerId);
        options.push({
          id: providerId,
          name: displayName,
          authType: "api_key",
          label: displayName,
          description: authStatus?.configured
            ? `$(check) Already configured (${authStatus.source})`
            : "",
        });
      }
    }

    return options.sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Show a VS Code quick pick (wraps showQuickPick since it's async and returns proper type) */
  private async showQuickPick<T extends { label: string; description?: string }>(
    items: T[],
    placeHolder: string,
  ): Promise<T | undefined> {
    const vscode = await import("vscode");
    const picked = await vscode.window.showQuickPick(items, { placeHolder, matchOnDescription: true });
    return picked;
  }

  /** Show an info message */
  private async showInfoMessage(message: string): Promise<void> {
    const vscode = await import("vscode");
    await vscode.window.showInformationMessage(message);
  }

  /** Show an error message */
  private async showErrorMessage(message: string): Promise<void> {
    const vscode = await import("vscode");
    await vscode.window.showErrorMessage(message);
  }

  /**
   * Execute OAuth login flow for a provider.
   * Opens the browser, handles callbacks, and waits for completion.
   */
  private async doOAuthLogin(providerId: string, providerName: string): Promise<void> {
    const vscode = await import("vscode");
    const previousModel = this._model;

    try {
      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `Logging in to ${providerName}...`,
          cancellable: true,
        },
        async (progress, token) => {
          const abortController = new AbortController();
          token.onCancellationRequested(() => abortController.abort());

          await this.authStorage.login(providerId, {
            onAuth: (info: { url: string; instructions?: string }) => {
              // Open the URL in the browser
              vscode.env.openExternal(vscode.Uri.parse(info.url));
              if (info.instructions) {
                progress.report({ message: info.instructions });
              }
            },
            onPrompt: async (prompt: { message: string; placeholder?: string }) => {
              // Show an input box for the response
              return vscode.window.showInputBox({
                prompt: prompt.message,
                placeHolder: prompt.placeholder,
                password: true,
                ignoreFocusOut: true,
              }) ?? "";
            },
            onProgress: (message: string) => {
              progress.report({ message });
            },
            onManualCodeInput: () => {
              // For callback-server providers, prompt for manual paste
              return new Promise<string>((resolve, reject) => {
                token.onCancellationRequested(() => reject(new Error("Login cancelled")));
                vscode.window
                  .showInputBox({
                    prompt: "Paste redirect URL below, or complete login in browser:",
                    ignoreFocusOut: true,
                  })
                  .then((value) => {
                    if (value) { resolve(value); }
                    else { reject(new Error("Login cancelled")); }
                  });
              });
            },
            signal: abortController.signal,
          });

          progress.report({ message: "Login successful!" });
        },
      );

      // Refresh model registry and try to select a model for the provider
      this.modelRegistry.refresh();
      await this.completeLogin(providerId, providerName, "oauth", previousModel);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      if (error.message !== "Login cancelled") {
        await this.showErrorMessage(`Failed to login to ${providerName}: ${error.message ?? error}`);
      }
    }
  }

  /**
   * Execute API key login flow for a provider.
   */
  private async doApiKeyLogin(providerId: string, providerName: string): Promise<void> {
    const vscode = await import("vscode");
    const previousModel = this._model;

    try {
      const apiKey = await vscode.window.showInputBox({
        prompt: `Enter API key for ${providerName}:`,
        password: true,
        placeHolder: "sk-...",
        validateInput: (value) => (value.trim() ? undefined : "API key required"),
        ignoreFocusOut: true,
      });

      if (!apiKey || !apiKey.trim()) {
        return; // cancelled
      }

      this.authStorage.set(providerId, { type: "api_key", key: apiKey.trim() });
      this.modelRegistry.refresh();
      await this.completeLogin(providerId, providerName, "api_key", previousModel);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      if (error.message !== "Login cancelled") {
        await this.showErrorMessage(`Failed to save API key for ${providerName}: ${error.message ?? error}`);
      }
    }
  }

  /** After login, try to select a default model for the provider */
  private async completeLogin(
    providerId: string,
    providerName: string,
    authType: string,
    previousModel: { id?: string; provider?: string } | null,
  ): Promise<void> {
    const actionLabel = authType === "oauth" ? `Logged in to ${providerName}` : `Saved API key for ${providerName}`;

    // Try to select a default model for the provider if the current model is "unknown"
    if (this.AI && (!previousModel || previousModel.provider === "unknown")) {
      const availableModels = this.modelRegistry.getAvailable();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
      const providerModels = availableModels.filter((m: any) => m.provider === providerId);
      if (providerModels.length > 0) {
        try {
          await this.setModel(providerId, providerModels[0].id);
          await this.showInfoMessage(`${actionLabel}. Selected ${providerModels[0].id}.`);
        } catch {
          await this.showInfoMessage(`${actionLabel}.`);
        }
        return;
      }
    }

    await this.showInfoMessage(`${actionLabel}.`);
  }

  /**
   * Show the logout flow for a provider.
   * Mirrors the pi CLI's /logout command.
   */
  async logout(): Promise<void> {
    if (!this.authStorage || !this.modelRegistry) {
      throw new Error("Pi session not initialized");
    }

    // Build list of providers that have credentials saved
    const options: Array<{ id: string; name: string; label: string; description: string }> = [];
    for (const providerId of this.authStorage.list()) {
      const credential = this.authStorage.get(providerId);
      if (!credential) { continue; }
      const displayName = this.modelRegistry.getProviderDisplayName(providerId);
      options.push({
        id: providerId,
        name: displayName,
        label: displayName,
        description: credential.type === "oauth" ? "OAuth subscription" : "API key",
      });
    }

    if (options.length === 0) {
      await this.showInfoMessage(
        "No stored credentials to remove. /logout only removes credentials saved by /login; environment variables and models.json config are unchanged.",
      );
      return;
    }

    const pick = await this.showQuickPick(
      options.sort((a, b) => a.name.localeCompare(b.name)),
      "Select provider to logout:",
    );
    if (!pick) { return; }

    try {
      this.authStorage.logout(pick.id);
      this.modelRegistry.refresh();
      const message =
        pick.description === "OAuth subscription"
          ? `Logged out of ${pick.name}`
          : `Removed stored API key for ${pick.name}. Environment variables and models.json config are unchanged.`;
      await this.showInfoMessage(message);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (error: any) {
      await this.showErrorMessage(`Logout failed: ${error.message ?? error}`);
    }
  }

  // ── Cleanup ────────────────────────────────────────────

  dispose(): void {
    // Resolve any in-flight interactive dialogs with undefined so awaiting SDK
    // coroutines unblock and fall back to text prompts instead of hanging forever.
    for (const { resolve } of this._pendingDialogs.values()) {
      try { resolve(undefined); } catch { /* listener already gone */ }
    }
    this._pendingDialogs.clear();

    // Rust runtime: tear down the subprocess (it owns its own persistence).
    if (this._backendKind === "rust") {
      if (this._widgetTimer) { clearInterval(this._widgetTimer); this._widgetTimer = null; }
      this._rust?.dispose();
      this._rust = null;
      return;
    }

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
    if (this._widgetTimer) { clearInterval(this._widgetTimer); this._widgetTimer = null; }
    this.unsubscribe?.();
    this.session?.dispose();
    this.unsubscribe = null;
    // Drop all SDK references (session, managers, modules) in one place.
    this._sdk?.dispose();
    this._sdk = null;
  }
}
