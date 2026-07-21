import * as vscode from "vscode";
import * as fs from "node:fs";
import * as path from "node:path";
import { PiService } from "./pi-service.js";
import { resolveWorkspaceCwd } from "./workspace.js";
import { PiWebviewPanel } from "./webview-panel.js";
import { PiPackageService } from "./pi-package-service.js";
import { PiPackagesTreeProvider } from "./pi-packages-tree-provider.js";
import { initLogger, disposeLogger, piLog, piDebug, piWarn, redactSecrets } from "./logger.js";
import { initSecrets } from "./secrets.js";
import { initRustModels } from "./rust-models.js";
import { registerPhase3Commands } from "./phase3-commands.js";
import { registerPhase4Commands } from "./phase4-commands.js";
import type { SessionSummary, Runtime } from "./types.js";
import { planPanelRestore } from "./panel-restore.js";
import { cachedRuntimes, resolveEffectiveDefaultRuntime, refreshRuntimeContext } from "./runtime-detection.js";
import { detectRustBinary } from "./rust-resolver.js";
import { isRustSessionPath, listRustSessions } from "./rust-sessions.js";
import { isRustSessionHeader } from "./session-format.js";
import { installRustInteractive } from "./rust-install.js";
import pinnedRust from "./rust-pi-version.json";
// The tree-view label extractor is the SAME operation as the event translator's — import the
// one implementation instead of a second copy (this file's copy also threw on a null content
// item and could join `undefined` into the label).
import { extractMessageText as extractText } from "./agent-events.js";

// ── Session window management ──────────────────────────

interface SessionWindow {
  id: string;
  piService: PiService;
  webviewPanel: PiWebviewPanel;
  initialized: boolean;
  isStreaming: boolean;
  /** Cached display label derived from session name or tab summary */
  label: string;
  /** Intended runtime for this window (known before init completes). */
  runtime: Runtime;
}

const sessions: SessionWindow[] = [];
let sessionCounter = 0;
/** Cached extension context — set once in activate(), used throughout. */
let extContext: vscode.ExtensionContext | null = null;

// NOTE: open-session restore across reload is owned by VS Code's webview panel
// serializer (see registerWebviewPanelSerializer in activate). The webview persists
// {sessionFilePath, runtime} via setState on every status-update; VS Code revives the
// panels and deserializeWebviewPanel re-attaches sessions. The old workspaceState
// snapshot ("openSessionPaths"/"activeSessionPath") duplicated that and raced it
// (double-restored windows) — it is intentionally gone. Only the session→runtime
// origin index below remains in workspaceState (it serves Past Sessions, not reload).

// ── Session ↔ runtime origin tracking ──────────────────
//
// Resume-follows-origin: a session is always reopened with the runtime that
// created it. The authoritative source is a workspaceState index (path →
// runtime); for sessions created outside the extension we fall back to the
// storage location (the Rust pool lives in its own directory) and finally to
// the effective default runtime. Never throws.

const RUNTIME_INDEX_KEY = "pi-code-gui.sessionRuntimeIndex";

async function recordSessionRuntime(p: string, runtime: Runtime): Promise<void> {
  if (!extContext) { return; }
  const map = extContext.workspaceState.get<Record<string, Runtime>>(RUNTIME_INDEX_KEY) ?? {};
  if (map[p] === runtime) { return; }
  map[p] = runtime;
  await extContext.workspaceState.update(RUNTIME_INDEX_KEY, map);
}

function lookupSessionRuntime(p: string): Runtime {
  const map = extContext?.workspaceState.get<Record<string, Runtime>>(RUNTIME_INDEX_KEY) ?? {};
  if (map[p] === "rust" || map[p] === "typescript") { return map[p]; }
  // Inferred fallback: the Rust pool lives in its own storage directory.
  if (isRustSessionPath(p)) { return "rust"; }
  // Last resort: inspect the file header. Catches Rust sessions created via the
  // CLI, moved, or under a custom sessionDir, where the path prefix no longer
  // applies (only upgrades to "rust" on a clear header signal — never downgrades).
  if (isRustSessionHeader(p)) { return "rust"; }
  return "typescript";
}

/** The most recently focused (active) session window. */
let activeSessionWindow: SessionWindow | null = null;

/** Phase 3/4 commands are global; register them once per host lifetime. */
let phaseCommandsRegistered = false;

function setActiveSession(sw: SessionWindow | null): void {
  activeSessionWindow = sw;
  // The Packages view reflects the focused session's runtime (available vs active).
  const rt: Runtime = sw?.runtime ?? primarySession()?.runtime ?? "typescript";
  void packagesTreeProvider?.setFocusedRuntime(rt);
}
let sessionTreeProvider: MultiSessionTreeProvider | null = null;
let sessionTreeView: vscode.TreeView<SessionTreeItem> | null = null;

let packagesTreeProvider: PiPackagesTreeProvider | null = null;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let packagesTreeView: vscode.TreeView<any> | null = null;
let packageService: PiPackageService | null = null;

/** The primary (first) session — used for status bar and tree provider */
function primarySession(): SessionWindow | undefined {
  return sessions[0];
}

/** Create a new session window pair */
function createSessionWindow(context: vscode.ExtensionContext, runtime: Runtime = "typescript"): SessionWindow {
  const id = `session-${++sessionCounter}`;
  const piService = new PiService();
  const webviewPanel = new PiWebviewPanel(context, piService);
  const sw: SessionWindow = {
    id, piService, webviewPanel,
    initialized: false, isStreaming: false,
    label: getGenericSessionLabel(id),
    runtime,
  };

  // Track when this panel becomes active
  webviewPanel.onActivate = () => setActiveSession(sw);

  // When the webview panel is closed (tab closed):
  // 1. Save the session to disk
  // 2. Remove it from open sessions
  // If saved successfully, it will appear in Past Sessions on next refresh.
  webviewPanel.onDispose = handlePanelDispose(sw);

  sessions.push(sw);
  updateHadOpenPanels();
  return sw;
}

/** Generate a generic "Session N" label from the internal id. */
function getGenericSessionLabel(id: string): string {
  const num = id.replace("session-", "");
  return `Session ${num}`;
}

/** Build a dispose handler that saves and removes a session when its panel closes. */
function handlePanelDispose(sw: SessionWindow): (piService: PiService) => void {
  return () => {
    // Record the session's origin runtime while the path is still readable (dispose
    // tears the service down) — this is what lets Past Sessions reopen it on the
    // runtime that created it (resume-follows-origin).
    const fp = sw.piService.sessionFilePath;
    if (fp) { void recordSessionRuntime(fp, sw.piService.runtime); }
    // The SessionManager auto-persists entries as they are written during
    // conversation, so the session file already exists on disk.  We just
    // need to clean up and remove it from the open-sessions list so it
    // appears under Past Sessions.
    sw.piService.dispose();
    removeSession(sw);

    // Refresh past sessions list from disk so the closed session appears
    // under Past Sessions immediately.
    void refreshPastSessionsList();
  };
}

/**
 * True for VS Code's own cancellation rejections (CancellationError / "Canceled"),
 * which it fires when disposing or terminating the extension host (e.g. during a
 * remote reconnect). They are benign and not ours — logging them floods the
 * console with identical stacks.
 */
function isBenignCancellation(e: unknown): boolean {
  const name = (e as { name?: string })?.name;
  if (name === "Canceled" || name === "CanceledError" || name === "CancellationError") { return true; }
  const msg = e instanceof Error ? e.message : String(e);
  return msg === "Canceled" || msg === "Canceled: Canceled" || /^Canceled\b/.test(msg);
}

/** Warn once if a user-supplied Rust binary differs from the version this
 *  extension is built/tested against. The managed build (globalStorage/rust-pi)
 *  is pinned to that version, so it never warns. API keys aside, a mismatched
 *  binary can drift in event/RPC shape — surface it instead of failing silently. */
async function warnIfUntestedRustBinary(context: vscode.ExtensionContext): Promise<void> {
  const status = cachedRuntimes()?.rustStatus;
  if (!status?.installed || !status.version || !status.binaryPath) { return; }
  const detected = status.version.match(/\d+\.\d+\.\d+/)?.[0];
  const pinnedVersion = pinnedRust.tag.replace(/^v/, "");
  if (!detected || detected === pinnedVersion) { return; }
  // The managed build is pinned, so never warn about it.
  const managedDir = path.resolve(path.join(context.globalStorageUri.fsPath, "rust-pi"));
  try { if (path.resolve(status.binaryPath).startsWith(managedDir)) { return; } } catch { /* ignore */ }
  // One notification per distinct version, so we don't nag every launch.
  if (context.globalState.get<string>("rustVersionWarned") === detected) { return; }
  await context.globalState.update("rustVersionWarned", detected);
  void vscode.window.showWarningMessage(
    `Rust Pi ${detected} is installed, but this extension is tested against ${pinnedVersion}. ` +
    "If you hit odd behaviour, run “PiGui: Install Pi” for the managed build, or update the extension.",
  );
}

// ── Activate ───────────────────────────────────────────

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  extContext = context;

  // Create output channel for diagnostics (View → Output → Pi Code Gui)
  const outputChannel = vscode.window.createOutputChannel("Pi Code Gui", { log: true });
  context.subscriptions.push(outputChannel);
  initLogger(outputChannel);
  initRustModels(context);
  // Load API keys from SecretStorage, migrating any still sitting in plaintext settings. Awaited
  // because the config seam that serves them (SdkDeps/RustDeps.config()) is synchronous; it is a
  // keychain read, not I/O that can hang on a user prompt.
  await initSecrets(
    context.secrets,
    (setting) => vscode.workspace.getConfiguration("pi-code-gui").get<string>(setting),
    async (setting) => {
      const cfg = vscode.workspace.getConfiguration("pi-code-gui");
      // Clear every scope the value could have been written to before the settings were scoped.
      await cfg.update(setting, undefined, vscode.ConfigurationTarget.Global);
      try { await cfg.update(setting, undefined, vscode.ConfigurationTarget.Workspace); } catch { /* no workspace */ }
    },
  );
  piLog(`Pi Code Gui v${context.extension.packageJSON.version} starting... (dev=${context.extensionMode === vscode.ExtensionMode.Development})`);

  // After extension host restart, workspace folders may not be available yet.
  // Without this guard, we fall back to process.cwd() which on remote servers
  // is the server root, loading sessions from the wrong project.
  if (!vscode.workspace.workspaceFolders?.length) {
    piDebug("Waiting for workspace folders...");
    await new Promise<void>((resolve) => {
      let settled = false;
      let sub: vscode.Disposable | undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const finish = (): void => {
        if (settled) { return; }
        settled = true;
        sub?.dispose();
        if (timer) { clearTimeout(timer); }
        resolve();
      };
      sub = vscode.workspace.onDidChangeWorkspaceFolders(() => {
        if (vscode.workspace.workspaceFolders?.length) { finish(); }
      });
      // Never block activation forever: a window opened WITH a folder doesn't
      // emit a change event (the folder was there from the start), and a window
      // with no folder never will. resolveWorkspaceCwd() covers the no-folder
      // case (home dir + warning), so just proceed after a short grace period.
      timer = setTimeout(finish, 2500);
      // Race guard: folders may have populated between the check and this point.
      if (vscode.workspace.workspaceFolders?.length) { finish(); }
    });
    piDebug(`Workspace ready: ${vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? "(none — using fallback cwd)"}`);
  }

  // Catch unhandled rejections/exceptions so we can see what crashes the
  // extension host before it restarts. VS Code restarts the host on
  // unhandled rejections, which orphans webviews and resets tree providers.
  // It also fires its OWN benign cancellations (CancellationError, "Canceled")
  // when disposing/terminating during a reconnect — those are not ours and not
  // crashes, so we drop them to avoid flooding the log with hundreds of lines.
  process.on("unhandledRejection", (reason: unknown) => {
    if (isBenignCancellation(reason)) { return; }
    piWarn(`UNHANDLED REJECTION: ${reason instanceof Error ? reason.stack ?? reason.message : String(reason)}`);
  });
  process.on("uncaughtException", (err: Error) => {
    if (isBenignCancellation(err)) { return; }
    piWarn(`UNCAUGHT EXCEPTION: ${err.stack ?? err.message}`);
  });

  // ── Session restore: WebviewPanelSerializer ──────────
  // VS Code owns open-panel persistence: it revives each pi-code-gui.session panel
  // across reload (position, order, active tab) and hands us the state the webview
  // persisted via setState ({sessionFilePath, runtime} — written on every
  // status-update). We re-attach a live session to the revived panel. This replaces
  // the old workspaceState-based restore, which duplicated what VS Code already does
  // and raced it (double-restored windows). Note: VS Code defers deserialization of
  // a BACKGROUND restored tab until it is first focused — sessions attach lazily.
  context.subscriptions.push(
    vscode.window.registerWebviewPanelSerializer("pi-code-gui.session", {
      async deserializeWebviewPanel(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
        const plan = planPanelRestore(state, (p) => fs.existsSync(p), defaultRuntimeForNewSession());
        piDebug(`[serializer] revived panel → ${plan.action}${plan.openPath ? ` (${plan.openPath.split("/").pop()})` : ""} on ${plan.runtime}`);
        if (plan.action === "dispose") {
          // The session file is gone — closing the shell beats resurrecting an empty one.
          panel.dispose();
          return;
        }
        const sw = createSessionWindow(context, plan.runtime);
        sw.webviewPanel.adoptPanel(panel);
        if (panel.active) { setActiveSession(sw); }
        void initSessionInBackground(context, sw,
          plan.action === "open" ? { openPath: plan.openPath, runtime: plan.runtime } : { fresh: true, runtime: plan.runtime });
      },
    }),
  );

  // ── Step 1: Register ALL commands immediately ──────────

  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.codeAgent", () => {
      const primary = primarySession();
      if (primary) {
        setActiveSession(primary);
        void primary.webviewPanel.show();
      } else {
        addSession(context);
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.addSession", () => {
      addSession(context);
    }),
  );

  // ── Runtime selection commands ──
  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.addSessionTypescript", () => addSession(context, "typescript")),
    vscode.commands.registerCommand("pi-code-gui.addSessionRust", () => addSession(context, "rust")),
    vscode.commands.registerCommand("pi-code-gui.addSessionWithRuntime", async () => {
      const rt = await pickRuntime();
      if (rt) { addSession(context, rt); }
    }),
    vscode.commands.registerCommand("pi-code-gui.setDefaultRuntime", async () => {
      const rt = await pickRuntime("Set the default runtime for new sessions");
      if (!rt) { return; }
      await vscode.workspace.getConfiguration("pi-code-gui").update("defaultRuntime", rt, vscode.ConfigurationTarget.Global);
      vscode.window.showInformationMessage(`Default runtime for new sessions: ${rt === "rust" ? "Rust Pi" : "TypeScript Pi"}.`);
    }),
    vscode.commands.registerCommand("pi-code-gui.switchRuntime", async (sessionId?: string) => {
      const sw = typeof sessionId === "string" ? sessions.find((s) => s.id === sessionId) : (activeSessionWindow ?? primarySession());
      if (!sw || !sw.initialized) { vscode.window.showWarningMessage("No active Pi session to switch."); return; }
      const target: Runtime = sw.piService.runtime === "rust" ? "typescript" : "rust";
      const targetName = target === "rust" ? "Rust Pi" : "TypeScript Pi";
      const action = `New session on ${targetName}`;
      const choice = await vscode.window.showInformationMessage(
        `Runtimes can't hot-swap a live session. "${action}" opens a NEW ${targetName} session; this one stays open and saved.`,
        action,
        "Cancel",
      );
      if (choice === action) { addSession(context, target); }
    }),
    vscode.commands.registerCommand("pi-code-gui.installRust", async () => {
      await installRustInteractive(context);
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.focusSession", (sessionId: string) => {
      const sw = sessions.find((s) => s.id === sessionId);
      if (sw) {
        setActiveSession(sw);
        void sw.webviewPanel.show();
      }
    }),
  );

  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.abort", async () => {
      const primary = primarySession();
      if (primary) { await primary.piService.abort(); }
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.sendSlashCommand", (cmd: string) => {
      const primary = primarySession();
      if (primary) { primary.webviewPanel.postCommand(cmd); }
    }),
  );
  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.referenceFile", (fp: string) => {
      const primary = primarySession();
      if (primary) { primary.webviewPanel.postCommand(`@${fp}`); }
    }),
  );

  // Reveal a specific session entry — shows the session webview so the user
  // can see the entry in the conversation history.
  // Accepts explicit (sessionId, entryId) args from TreeItem.command click,
  // or falls back to reading the selected tree item from the session tree view
  // (for right-click context menu usage where args are not auto-populated).
  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.revealEntry", (sessionId?: string | SessionTreeItem, entryId?: string, toolCallId?: string) => {
      let sw: SessionWindow | undefined;
      let id = entryId;
      let tcId = toolCallId;

      // Handle context menu: VS Code passes the tree item as first arg
      if (sessionId instanceof SessionTreeItem) {
        const cmdArgs = sessionId.command?.arguments;
        if (cmdArgs && cmdArgs.length >= 2) {
          sw = sessions.find((s) => s.id === cmdArgs[0]);
          id = cmdArgs[1] as string;
          tcId = cmdArgs.length >= 3 ? cmdArgs[2] as string : undefined;
        }
      } else if (typeof sessionId === "string") {
        sw = sessions.find((s) => s.id === sessionId);
      }

      // Fallback: read from tree view selection (used by context menu)
      if (!sw || !id) {
        const selection = sessionTreeView?.selection;
        if (selection && selection.length > 0) {
          const item = selection[0];
          if (item.contextValue === "sessionEntry" || item.contextValue?.startsWith("sessionEntry")) {
            const cmdArgs = item.command?.arguments;
            if (cmdArgs && cmdArgs.length >= 2) {
              sw = sessions.find((s) => s.id === cmdArgs[0])!;
              id = cmdArgs[1] as string;
              tcId = cmdArgs.length >= 3 ? cmdArgs[2] as string : undefined;
            }
          }
        }
      }

      if (sw && id) {
        void sw.webviewPanel.show();
        sw.webviewPanel.postMessage({ type: "revealEntry", entryId: id, toolCallId: tcId || "" });
      }
    }),
  );

  // Copy the text content of a selected entry from the Sessions tree
  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.copyEntryText", async (treeItem?: SessionTreeItem) => {
      var item: SessionTreeItem | undefined = treeItem;
      // Fallback: read from tree view selection
      if (!item || (item.contextValue !== "sessionEntry" && !item.contextValue?.startsWith("sessionEntry"))) {
        const selection = sessionTreeView?.selection;
        if (selection && selection.length > 0) {
          item = selection[0];
        }
      }
      if (!item || (item.contextValue !== "sessionEntry" && !item.contextValue?.startsWith("sessionEntry"))) { return; }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
      var text = (item as any)._fullText;
      if (!text) {
        text = typeof item.tooltip === "string"
          ? item.tooltip
          : (item.tooltip as vscode.MarkdownString)?.value ?? "";
      }
      if (text) {
        await vscode.env.clipboard.writeText(text);
        vscode.window.showInformationMessage("Entry text copied to clipboard");
      }
    }),
  );

  // ── Fork helpers ─────────────────────────────────────

  /** Fork at a specific entry within an already-open session. */
  async function doForkFromOpenEntry(sessionId: string, entryId: string): Promise<void> {
    const srcSw = sessions.find((s) => s.id === sessionId);
    // Fork/branch is a TypeScript-SDK SessionManager operation (getLeafId /
    // createBranchedSession); the out-of-process Rust runtime doesn't expose it.
    if (srcSw?.piService.runtime === "rust") {
      throw new Error("Forking isn't supported for Rust sessions yet.");
    }
    if (!srcSw || !srcSw.piService.sessionManagerInstance) {
      throw new Error(`Source session not found (id=${sessionId}).`);
    }

    // Get the source file path — we open a fresh SessionManager to branch
    // so the source session is not mutated.
    const sourcePath = srcSw.piService.sessionFilePath;
    if (!sourcePath) {
      throw new Error("Source session has no persisted file.");
    }

    // Open a temporary PiService to get an isolated SessionManager for branching
    const tempPi = new PiService();
    let forkedPath: string;
    try {
      const result = await tempPi.initialize({ openPath: sourcePath });
      if (!result.success) {
        throw new Error(`Cannot open source session: ${result.error}`);
      }
      const srcSm = tempPi.sessionManagerInstance;
      if (!srcSm) { throw new Error("Source session has no session manager."); }

      const entry = srcSm.getEntry(entryId);
      if (!entry) { throw new Error("Entry not found in source session."); }

      const isUserMsg = entry.type === "message" && entry.message?.role === "user";
      const isAssistantMsg = entry.type === "message" && entry.message?.role === "assistant";
      const isCustomMsg = entry.type === "custom_message";
      if (!isUserMsg && !isAssistantMsg && !isCustomMsg) {
        throw new Error("Fork only works on user, assistant, or custom messages. Selected entry type: " + (entry.type ?? "unknown"));
      }

      // Fork at the selected entry (include it in the branch)
      const targetLeafId = entryId;
      forkedPath = srcSm.createBranchedSession(targetLeafId);
      if (!forkedPath) {
        throw new Error("Failed to create forked session file.");
      }
    } finally {
      tempPi.dispose();
    }

    piDebug(`doForkFromOpenEntry: forked to ${forkedPath}`);
    await openForkedSession(forkedPath);
  }

  /** Fork a past session at its current leaf (opens the session, then forks). */
  async function doForkFromPastSession(sessionPath: string): Promise<void> {
    // Rust sessions can't be opened by the TS SDK (and fork is a TS-SDK op), so
    // refuse clearly instead of failing with a cryptic "Cannot open past session".
    if (lookupSessionRuntime(sessionPath) === "rust") {
      throw new Error("Forking isn't supported for Rust sessions yet.");
    }
    // Initialize a new PiService to load the session and get leaf ID
    const tempPi = new PiService();
    const result = await tempPi.initialize({ openPath: sessionPath });
    if (!result.success) {
      throw new Error(`Cannot open past session: ${result.error}`);
    }
    const sm = tempPi.sessionManagerInstance;
    if (!sm) {
      tempPi.dispose();
      throw new Error("Past session has no session manager.");
    }
    const leafId = sm.getLeafId();
    if (!leafId) {
      tempPi.dispose();
      throw new Error("Past session has no entries to fork from.");
    }

    // Fork at the leaf (clone the session at its current tip)
    let forkedPath: string | null = null;
    try {
      forkedPath = sm.createBranchedSession(leafId);
    } catch {
      // If branching fails, just use the original file
    }
    tempPi.dispose();

    await openForkedSession(forkedPath ?? sessionPath);
  }

  /** Create a new session window initialized from a forked session file. */
  async function openForkedSession(forkedPath: string): Promise<void> {
    const originRuntime = lookupSessionRuntime(forkedPath);
    const newSw = createSessionWindow(context, originRuntime);
    setActiveSession(newSw);
    void newSw.webviewPanel.show();
    sessionTreeProvider?.refresh();

    await initSessionInBackground(context, newSw, { openPath: forkedPath, runtime: originRuntime });

    if (!newSw.initialized) {
      removeSession(newSw);
      throw new Error("Failed to initialize forked session.");
    }

    // sendInitialMessages() is already called during initialize() inside the
    // batch-start/batch-end wrapper — no need for a second call here.
    sessionTreeProvider?.refresh();
    vscode.window.showInformationMessage("Session forked to new tab.");
  }

  // Fork session from a selected entry — creates a NEW session window branched
  // from the fork point. The original session is untouched.
  // Supports two entry points:
  //   1. sessionEntry inside an open session → fork at that entry
  //   2. pastSessionEntry → resume the session, pick a message, fork there
  context.subscriptions.push(
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    vscode.commands.registerCommand("pi-code-gui.forkSession", async (...rawArgs: any[]) => {
      // VS Code passes the TreeItem as the first argument when invoked from
      // a context menu. The tree item's command.arguments contain the actual
      // payload: [sessionId, entryId] for sessionEntry, [path] for pastSessionEntry.
      let cmdArgs = rawArgs;
      if (cmdArgs.length > 0 && cmdArgs[0] instanceof SessionTreeItem) {
        cmdArgs = cmdArgs[0].command?.arguments ?? [];
      }

      if (!cmdArgs || cmdArgs.length === 0) {
        vscode.window.showErrorMessage("Cannot fork: no entry selected.");
        return;
      }

      try {
        if (cmdArgs.length >= 2) {
          await doForkFromOpenEntry(cmdArgs[0] as string, cmdArgs[1] as string);
        } else {
          await doForkFromPastSession(cmdArgs[0] as string);
        }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (e: any) {
        vscode.window.showErrorMessage(`Fork failed: ${e.message ?? e}`);
      }
    }),
  );

  // ── Clone session (fork at current leaf) ────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.cloneSession", async () => {
      const sw = activeSessionWindow ?? primarySession();
      if (!sw || !sw.initialized) {
        vscode.window.showErrorMessage("Cannot clone: no active Pi session.");
        return;
      }
      if (sw.piService.runtime === "rust") {
        vscode.window.showErrorMessage("Cloning isn't supported for Rust sessions yet.");
        return;
      }
      const sm = sw.piService.sessionManagerInstance;
      if (!sm) {
        vscode.window.showErrorMessage("Cannot clone: session has no manager.");
        return;
      }
      const leafId = sm.getLeafId();
      if (!leafId) {
        vscode.window.showErrorMessage("Cannot clone: session has no entries.");
        return;
      }
      try {
        await doForkFromOpenEntry(sw.id, leafId);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (e: any) {
        vscode.window.showErrorMessage(`Clone failed: ${e.message ?? e}`);
      }
    }),
  );

  // ── Compact session context ────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.compact", async () => {
      const sw = activeSessionWindow ?? primarySession();
      if (!sw || !sw.initialized) {
        vscode.window.showWarningMessage("No active Pi session.");
        return;
      }
      try {
        if (sw.piService.isStreaming) { await sw.piService.abort(); }
        vscode.window.showInformationMessage("Compacting context...");
        // Runtime-aware: there is no in-process session under Rust (RPC `compact` instead).
        await sw.piService.compact();
        vscode.window.showInformationMessage("Context compacted.");
        sessionTreeProvider?.refresh();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (e: any) {
        vscode.window.showErrorMessage(`Compact failed: ${e.message ?? e}`);
      }
    }),
  );

  // ── Export session to HTML ─────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.exportSession", async () => {
      const sw = activeSessionWindow ?? primarySession();
      if (!sw || !sw.initialized) {
        vscode.window.showWarningMessage("No active Pi session.");
        return;
      }
      // Rust exports via `pi --export`, which needs the session written to disk.
      if (sw.piService.runtime === "rust" && !sw.piService.sessionFilePath) {
        vscode.window.showWarningMessage("This Rust session hasn't been saved yet — send a message first, then export.");
        return;
      }
      try {
        const defaultPath = vscode.Uri.joinPath(
          vscode.Uri.file(resolveWorkspaceCwd()),
          `pi-session-${sw.id}.html`
        );
        const uri = await vscode.window.showSaveDialog({
          defaultUri: defaultPath,
          filters: { "HTML": ["html"] },
        });
        if (!uri) { return; }
        const result = await sw.piService.exportToHtml(uri.fsPath);
        vscode.window.showInformationMessage(`Session exported to: ${result}`);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (e: any) {
        vscode.window.showErrorMessage(`Export failed: ${e.message ?? e}`);
      }
    }),
  );

  // ── Reload context (extensions, keybindings, skills) ─
  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.reloadContext", async () => {
      const sw = activeSessionWindow ?? primarySession();
      if (!sw || !sw.initialized) {
        vscode.window.showWarningMessage("No active Pi session.");
        return;
      }
      try {
        // Goes through the PiBackend seam. A runtime with no in-session reload (Rust loads
        // extensions/skills at startup) reports false rather than exposing a raw session.
        if (!(await sw.piService.reloadContext())) {
          vscode.window.showInformationMessage("Reload context is available for TypeScript Pi sessions; start a new Rust session to reload its extensions and skills.");
          return;
        }
        await sw.piService.sendInitialMessages();
        // Push updated slash commands after extension reload
        sw.piService.emitSlashCommands();
        vscode.window.showInformationMessage("Extensions, skills, and keybindings reloaded.");
// eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (e: any) {
        vscode.window.showErrorMessage(`Reload failed: ${e.message ?? e}`);
      }
    }),
  );

  // ── Resume a past session from the tree view ─────
  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.resumePastSession", async (filePath?: SessionTreeItem | string) => {
      let resolved: string | undefined;
      // When triggered from a context menu, VS Code passes the tree item as the first arg.
      if (filePath instanceof SessionTreeItem) {
// eslint-disable-next-line @typescript-eslint/no-explicit-any
        resolved = (filePath as any).command?.arguments?.[0];
      } else if (typeof filePath === "string") {
        resolved = filePath;
      }
      if (!resolved) {
        const sel = sessionTreeView?.selection?.[0];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (sel && (sel as any).contextValue === "pastSessionEntry" && (sel as any).command?.arguments) {
// eslint-disable-next-line @typescript-eslint/no-explicit-any
          const arg = (sel as any).command.arguments[0];
          if (typeof arg === "string") { resolved = arg; }
        }
      }
      if (!resolved) {
        vscode.window.showErrorMessage("Cannot resume: missing session file path.");
        return;
      }
      try {
        // Create a new session tab (like Add Pi Session) and resume into it,
        // on the runtime that originally created the session.
        const originRuntime = lookupSessionRuntime(resolved);
        const sw = createSessionWindow(context, originRuntime);
        setActiveSession(sw);
        void sw.webviewPanel.show();
        sessionTreeProvider?.refresh();
        void initSessionInBackground(context, sw, { openPath: resolved, runtime: originRuntime });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (e: any) {
        vscode.window.showErrorMessage(`Resume failed: ${e.message ?? e}`);
      }
    }),
  );

  // ── Delete a past session from the tree view ──────
  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.deletePastSession", async (filePath?: SessionTreeItem | string) => {
      let resolved: string | undefined;
      // When triggered from a context menu, VS Code passes the tree item as the first arg.
      if (filePath instanceof SessionTreeItem) {
// eslint-disable-next-line @typescript-eslint/no-explicit-any
        resolved = (filePath as any).command?.arguments?.[0];
      } else if (typeof filePath === "string") {
        resolved = filePath;
      }
      if (!resolved) {
        const sel = sessionTreeView?.selection?.[0];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
        if (sel && (sel as any).contextValue === "pastSessionEntry" && (sel as any).command?.arguments) {
// eslint-disable-next-line @typescript-eslint/no-explicit-any
          const arg = (sel as any).command.arguments[0];
          if (typeof arg === "string") { resolved = arg; }
        }
      }
      if (!resolved) {
        vscode.window.showErrorMessage("Cannot delete: missing session file path.");
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        "Delete this session permanently?",
        { modal: true },
        "Delete",
      );
      if (confirm !== "Delete") { return; }
      try {
        await PiService.deleteSessionFile(resolved);
        await refreshPastSessionsList();
        sessionTreeProvider?.refreshPastOnly();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (e: any) {
        vscode.window.showErrorMessage(`Delete failed: ${e.message ?? e}`);
      }
    }),
  );

  // ── Delete all past sessions ────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.deleteAllPastSessions", async () => {
      const past = sessionTreeProvider?.pastSessions ?? [];
      if (past.length === 0) {
        vscode.window.showInformationMessage("No past sessions to delete.");
        return;
      }
      const confirm = await vscode.window.showWarningMessage(
        `Delete all ${past.length} past sessions permanently?`,
        { modal: true },
        "Delete All",
      );
      if (confirm !== "Delete All") { return; }
      try {
        for (const s of past) {
          await PiService.deleteSessionFile(s.path);
        }
        await refreshPastSessionsList();
        sessionTreeProvider?.refresh();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (e: any) {
        vscode.window.showErrorMessage(`Delete all failed: ${e.message ?? e}`);
      }
    }),
  );

  // ── Filter past sessions ────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.filterPastSessions", async () => {
      const currentFilter = sessionTreeProvider?.pastFilter ?? "";
      const filter = await vscode.window.showInputBox({
        prompt: "Filter past sessions by title or content",
        placeHolder: "Type to filter...",
        value: currentFilter,
      });
      if (filter === undefined) { return; } // cancelled
      if (sessionTreeProvider) {
        sessionTreeProvider.pastFilter = filter;
        sessionTreeProvider.refresh();
      }
    }),
  );

  // Per-session model picker
  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.pickSessionModel", async (sessionId?: string) => {
      const sw = sessionId ? sessions.find((s) => s.id === sessionId) : primarySession();
      if (!sw || !sw.initialized) {
        piWarn(`pickSessionModel: session not initialized (sessionId=${sessionId})`);
        return;
      }
      if (await sw.piService.pickModel()) {
        sessionTreeProvider?.refresh();
      }
    }),
  );

  // Per-session thinking level picker
  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.pickSessionThinking", async (sessionId?: string) => {
      const sw = sessionId ? sessions.find((s) => s.id === sessionId) : primarySession();
      if (!sw || !sw.initialized) {
        piWarn(`pickSessionThinking: session not initialized (sessionId=${sessionId})`);
        return;
      }
      if (await sw.piService.pickThinkingLevel()) {
        sessionTreeProvider?.refresh();
      }
    }),
  );

  // Active-session model picker
  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.pickModel", async () => {
      const sw = activeSessionWindow;
      if (!sw || !sw.initialized) {
        vscode.window.showWarningMessage("No active Pi session.");
        return;
      }
      void sw.webviewPanel.show();
      if (await sw.piService.pickModel()) {
        sessionTreeProvider?.refresh();
      }
    }),
  );

  // Active-session thinking picker
  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.pickThinking", async () => {
      const sw = activeSessionWindow;
      if (!sw || !sw.initialized) {
        vscode.window.showWarningMessage("No active Pi session.");
        return;
      }
      void sw.webviewPanel.show();
      if (await sw.piService.pickThinkingLevel()) {
        sessionTreeProvider?.refresh();
      }
    }),
  );


  // Active-session context budget picker
  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.pickContextBudget", async () => {
      const sw = activeSessionWindow;
      if (!sw || !sw.initialized) {
        vscode.window.showWarningMessage("No active Pi session.");
        return;
      }
      void sw.webviewPanel.show();
      await sw.webviewPanel.triggerContextBudgetPicker();
    }),
  );

  // ── Step 3b: Register SDK-independent commands ─────
  // These must be registered synchronously so keybindings
  // (Cmd+/, Cmd+L, etc.) work immediately — the async SDK
  // init chain in initSessionInBackground can take seconds.
  registerEarlyCommands(context);

  // ── Step 3c: Detect installed runtimes and set menu context keys ──
  // Runs before session restore so runtime-aware UI settles correctly.
  await refreshRuntimeContext(true);

  // If neither runtime is installed, let the user choose one to install.
  const detectedAtStartup = cachedRuntimes();
  if (detectedAtStartup && !detectedAtStartup.ts && !detectedAtStartup.rust) {
    await offerInitialRuntimeChoice(context);
    await refreshRuntimeContext(true);
  }

  // Warn (once) if a user-supplied Rust binary differs from the version we test
  // against. The managed build is pinned to that version, so it never warns.
  await warnIfUntestedRustBinary(context);

  // ── Step 4: Create a fresh session only when VS Code has no panels to revive ──
  // Reopening previous sessions is owned by the WebviewPanelSerializer: VS Code
  // revives each persisted pi-code-gui.session panel itself (correct column, order,
  // active tab — including panels in background tabs, which deserialize lazily on
  // first focus). So activate() must NOT reconstruct them; it only auto-opens a
  // fresh session for a genuinely session-less window. "Will VS Code revive
  // panels?" isn't directly queryable, so we keep one workspaceState hint — a
  // boolean updated whenever the open-panel count changes. A stale hint degrades
  // gracefully: worst case no auto-open (click the Pi icon), never a duplicate.
  const hadOpenPanels = context.workspaceState.get<boolean>("pi-code-gui.hadOpenPanels") ?? false;
  const autoOpen = vscode.workspace.getConfiguration("pi-code-gui").get<boolean>("autoOpenOnStart", true);
  // One-time migration: drop the retired workspaceState-restore keys.
  void context.workspaceState.update("pi-code-gui.openSessionPaths", undefined);
  void context.workspaceState.update("pi-code-gui.activeSessionPath", undefined);
  void context.workspaceState.update("pi-code-gui.sessionCounter", undefined);

  if (!hadOpenPanels && sessions.length === 0) {
    const sw = createSessionWindow(context, defaultRuntimeForNewSession());
    setActiveSession(sw);
    if (autoOpen) { void sw.webviewPanel.show(); }
    void initSessionInBackground(context, sw, { fresh: true });
  } else {
    piDebug(`[serializer] activate: hadOpenPanels=${hadOpenPanels}, sessions=${sessions.length} — leaving restore to VS Code's panel revival`);
  }

  // ── Step 5: Initialize packages view ────────────────
  initPackagesViewDelayed(context);
}

// ── Packages view ───────────────────────────────────

/**
 * Try to init packages view immediately.  If the SDK isn't available yet,
 * poll every 2 s until a session initialises (max 30 s).
 */
function initPackagesViewDelayed(context: vscode.ExtensionContext): void {
  initPackagesView(context).catch(() => {
    // SDK not ready yet — poll until a session comes up
    const interval = setInterval(() => {
      const primary = primarySession();
      if (primary?.initialized) {
        clearInterval(interval);
        void initPackagesView(context);
      }
    }, 2000);
    setTimeout(() => clearInterval(interval), 30_000);
  });
}

async function initPackagesView(context: vscode.ExtensionContext): Promise<void> {
  if (packagesTreeProvider) { return; } // already initialized

  packageService = new PiPackageService();
  const result = await packageService.initialize();

  // Create the tree view even if init failed — it will show a helpful
  // placeholder so the user knows the view exists.
  packagesTreeProvider = new PiPackagesTreeProvider(packageService);
  packagesTreeView = vscode.window.createTreeView("pi-code-gui.packages", {
    treeDataProvider: packagesTreeProvider,
  });
  context.subscriptions.push(packagesTreeView);

  if (!result.success) {
    piWarn(`Packages view: package service init failed: ${result.error}`);
    // Show the error in the tree view itself (init only fails when neither
    // runtime is available — the SDK and the Rust binary are both absent).
    packagesTreeProvider.showError(result.error ?? "No Pi runtime available for package management.");
    return;
  }

  // Initial load
  await packagesTreeProvider.refreshAll();
  // Reflect the runtime of whatever session is focused on first load.
  const initialRt: Runtime = activeSessionWindow?.runtime ?? primarySession()?.runtime ?? "typescript";
  void packagesTreeProvider.setFocusedRuntime(initialRt);

  // ── Register package commands ────────────────

  // Install a package from the marketplace
  context.subscriptions.push(
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    vscode.commands.registerCommand("pi-code-gui.installPackage", async (item?: any) => {
      const treeItem = resolvePackageTreeItem(item);
      let marketPkg = treeItem?.marketData;

      if (!marketPkg) {
        // May be called without args from command palette
        const name = await vscode.window.showInputBox({
          prompt: "Enter npm package name to install",
          placeHolder: "pi-subagents",
        });
        if (!name) { return; }
        await doInstallPackage(name);
        return;
      }

      const source = `npm:${marketPkg.npmPackage}`;

      // Ask user vs project scope
      const scope = await pickScope();
      if (!scope) { return; }

      await doInstallPackage(source, scope);
    }),
  );

  // Uninstall a package
  context.subscriptions.push(
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    vscode.commands.registerCommand("pi-code-gui.uninstallPackage", async (item?: any) => {
      const treeItem = resolvePackageTreeItem(item);
      const pkg = treeItem?.installedData;
      if (!pkg) {
        vscode.window.showErrorMessage("Cannot uninstall: no package selected.");
        return;
      }

      const label = pkg.source.startsWith("npm:") ? pkg.source.slice(4) : pkg.source;

      const confirm = await vscode.window.showWarningMessage(
        `Uninstall "${label}"?`,
        { modal: true },
        "Uninstall",
      );
      if (confirm !== "Uninstall") { return; }

      await doUninstallPackage(pkg.source, pkg.scope);
    }),
  );

  // Search packages
  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.searchPackages", async () => {
      const query = await vscode.window.showInputBox({
        prompt: "Search Pi packages on the marketplace",
        placeHolder: "e.g. web, subagent, mcp — or leave empty for popular",
// eslint-disable-next-line @typescript-eslint/no-explicit-any
        value: (packagesTreeProvider as any)?.searchQuery ?? "",
      });
      if (query === undefined) { return; } // cancelled
      await packagesTreeProvider?.refreshAll(query ?? "");
    }),
  );

  // Refresh packages view
  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.refreshPackages", async () => {
      await packagesTreeProvider?.refreshAll();
    }),
  );

  // Update a single package
  context.subscriptions.push(
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    vscode.commands.registerCommand("pi-code-gui.updatePackage", async (item?: any) => {
      const treeItem = resolvePackageTreeItem(item);
      const pkg = treeItem?.installedData;
      if (!pkg) {
        vscode.window.showErrorMessage("Cannot update: no package selected.");
        return;
      }
      await doUpdatePackage(pkg.source);
    }),
  );

  // Update all packages
  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.updateAllPackages", async () => {
      // The Rust CLI has no dry-run, so checkForUpdates() returns [] under it —
      // reporting "all up to date" would be a lie. Be honest: tell the user we
      // can't pre-check and offer to update everything anyway.
      const isRust = packageService?.backend === "rust";
      if (!isRust) {
        const updates = await packageService?.checkForUpdates();
        if (!updates || updates.length === 0) {
          vscode.window.showInformationMessage("All packages are up to date.");
          return;
        }
        const confirm = await vscode.window.showInformationMessage(
          `${updates.length} package(s) have updates available. Update all?`,
          "Update All",
        );
        if (confirm !== "Update All") { return; }
      } else {
        const confirm = await vscode.window.showInformationMessage(
          "Rust Pi can't pre-check which packages have updates. Update all installed packages now?",
          "Update All",
        );
        if (confirm !== "Update All") { return; }
      }

      try {
        await packageService!.update();
        vscode.window.showInformationMessage("All packages updated.");
        await packagesTreeProvider?.refreshAll();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (e: any) {
        vscode.window.showErrorMessage(`Update failed: ${e.message ?? e}`);
      }
    }),
  );

  // Open a URL in the default browser (used by link items in tree view)
  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.openUrl", (url: string) => {
      if (url) {
        // Normalize git URLs (git+https://, git://, git@...) to plain https://
        let normalized = url;
        if (normalized.startsWith("git+")) { normalized = normalized.slice(4); }
        if (normalized.startsWith("git://")) { normalized = "https://" + normalized.slice(6); }
        const scpMatch = normalized.match(/^git@([^:]+):(.+)$/);
        if (scpMatch) { normalized = "https://" + scpMatch[1] + "/" + scpMatch[2]; }
        normalized = normalized.replace(/\.git$/, "");
        vscode.env.openExternal(vscode.Uri.parse(normalized));
      }
    }),
  );

  // Open pi.dev marketplace in browser
  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.openPiDevMarketplace", () => {
      vscode.env.openExternal(vscode.Uri.parse("https://pi.dev/packages"));
    }),
  );

  piDebug("Packages view ready");
}

/** Resolve a tree item from either a direct argument or the tree view selection. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- VS Code tree item types are dynamic
function resolvePackageTreeItem(item: any): any {
  // Direct argument from TreeItem.command click
  if (item && (item.marketData || item.installedData)) {
    return item;
  }

  // From tree selection — walk up to parent if we're on an action child
  const selection = packagesTreeView?.selection;
  if (selection && selection.length > 0) {
    const sel = selection[0];
    // If clicked on an action or overview child, walk up to the parent package item
    if (sel.installedData || sel.marketData) {
      return sel;
    }
  }
  return null;
}

async function pickScope(): Promise<"user" | "project" | undefined> {
  const pick = await vscode.window.showQuickPick(
    [
      { label: "User (global)", description: "Available in all projects", scope: "user" as const },
      { label: "Project (local)", description: "Only in this workspace", scope: "project" as const },
    ],
    { placeHolder: "Install scope" },
  );
  return pick?.scope;
}

async function doInstallPackage(source: string, scope: "user" | "project" = "user"): Promise<void> {
  if (!packageService) { return; }

  const label = source.startsWith("npm:") ? source.slice(4) : source;
  let installed = false;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Installing ${label}...` },
    async () => {
      const result = await packageService!.install(source, scope);
      if (result.success) {
        installed = true;
        vscode.window.showInformationMessage(`Installed ${label} (${scope})`);
        await packagesTreeProvider?.refreshAll();
      } else {
        vscode.window.showErrorMessage(`Install failed: ${result.error}`);
      }
    },
  );
  if (installed) { await warnIfRustWontLoad(source, label); }
}

/**
 * After installing a package while a Rust session is focused, warn if the Rust
 * runtime won't actually load it (packages are shared, but a TypeScript-format
 * extension may be installed yet inert under Rust). Points at `rustExtensions`.
 */
async function warnIfRustWontLoad(source: string, label: string): Promise<void> {
  if (!packageService) { return; }
  const focusedRt: Runtime = activeSessionWindow?.runtime ?? primarySession()?.runtime ?? "typescript";
  if (focusedRt !== "rust") { return; }
  const verdict = await packageService.checkRustLoadability(source);
  if (verdict.loads) { return; }

  const OPEN = "Open Setting";
  const LEARN = "Learn More";
  const msg = verdict.reason === "disabled"
    ? `${label} is installed, but Rust extension discovery is disabled for this workspace — Rust sessions won't load it.`
    : `${label} is installed, but the Rust runtime can't load it (incompatible extension format). It still works under TypeScript Pi.`;
  const actions = verdict.reason === "disabled" ? [OPEN, LEARN] : [LEARN];
  const action = await vscode.window.showWarningMessage(msg, ...actions);
  if (action === OPEN) {
    await vscode.commands.executeCommand("workbench.action.openSettings", "pi-code-gui.rustExtensions");
  } else if (action === LEARN) {
    vscode.env.openExternal(vscode.Uri.parse("https://github.com/Dicklesworthstone/pi_agent_rust"));
  }
}

async function doUninstallPackage(source: string, scope: "user" | "project"): Promise<void> {
  if (!packageService) { return; }

  const label = source.startsWith("npm:") ? source.slice(4) : source;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Removing ${label}...` },
    async () => {
      const result = await packageService!.uninstall(source, scope);
      if (result.success) {
        vscode.window.showInformationMessage(`Removed ${label}`);
        await packagesTreeProvider?.refreshAll();
      } else {
        vscode.window.showErrorMessage(`Remove failed: ${result.error}`);
      }
    },
  );
}

async function doUpdatePackage(source: string): Promise<void> {
  if (!packageService) { return; }

  const label = source.startsWith("npm:") ? source.slice(4) : source;
  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Updating ${label}...` },
    async () => {
      try {
        await packageService!.update(source);
        vscode.window.showInformationMessage(`Updated ${label}`);
        await packagesTreeProvider?.refreshAll();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
      } catch (e: any) {
        vscode.window.showErrorMessage(`Update failed: ${e.message ?? e}`);
      }
    },
  );
}

// ── Add a new session window ──────────────────────────

function addSession(context: vscode.ExtensionContext, runtime?: Runtime): void {
  const rt = runtime ?? defaultRuntimeForNewSession();
  const sw = createSessionWindow(context, rt);
  setActiveSession(sw);
  void sw.webviewPanel.show();
  sessionTreeProvider?.refresh();
  void initSessionInBackground(context, sw, { fresh: true, runtime: rt });
}

/** The runtime a new session should use, from the cached detection + persisted default. */
function defaultRuntimeForNewSession(): Runtime {
  const detected = cachedRuntimes();
  if (detected) {
    const r = resolveEffectiveDefaultRuntime(detected);
    if (r) { return r; }
  }
  return "typescript";
}

/** Short badge for a runtime, shown in tree items and chips. */
function runtimeBadge(rt: Runtime): string {
  return rt === "rust" ? "Rust" : "TS";
}

/** When neither runtime is installed at startup, let the user choose one to install. */
async function offerInitialRuntimeChoice(context: vscode.ExtensionContext): Promise<void> {
  const items: Array<vscode.QuickPickItem & { id: "typescript" | "rust" | "learn" }> = [
    { label: "$(symbol-method) TypeScript Pi", detail: "In-process. Full editor bridge + interactive cards. Requires Node.js + npm.", id: "typescript" },
    { label: "$(rocket) Rust Pi", detail: "Out-of-process single binary. Fast, lean, no Node. No VS Code bridge tools; markdown-only cards.", id: "rust" },
    { label: "$(link-external) Learn More", detail: "Compare the two runtimes", id: "learn" },
  ];
  const pick = await vscode.window.showQuickPick(items, { placeHolder: "Pi is not installed. Choose a runtime to install.", ignoreFocusOut: true });
  if (!pick) { return; }
  if (pick.id === "learn") { void vscode.env.openExternal(vscode.Uri.parse("https://pi.dev")); return; }
  if (pick.id === "rust") {
    const ok = await installRustInteractive(context);
    if (ok) { await vscode.workspace.getConfiguration("pi-code-gui").update("defaultRuntime", "rust", vscode.ConfigurationTarget.Global); }
  } else {
    await installPi();
  }
}

/** Quick-pick to choose a runtime. Returns undefined if dismissed. */
async function pickRuntime(placeHolder = "Choose a runtime for the new Pi session"): Promise<Runtime | undefined> {
  const items: Array<vscode.QuickPickItem & { runtime: Runtime }> = [
    { label: "$(symbol-method) TypeScript Pi", description: "In-process · full editor bridge · interactive cards", runtime: "typescript" },
    { label: "$(rocket) Rust Pi", description: "Out-of-process · fast & lean · markdown-only cards", runtime: "rust" },
  ];
  const pick = await vscode.window.showQuickPick(items, { placeHolder });
  return pick?.runtime;
}

// ── Early command registration (SDK-independent) ───────
//
// These commands are registered synchronously in activate()
// so keybindings (Cmd+/, Cmd+@, etc.) work immediately.
// The async SDK init chain in initSessionInBackground can
// take seconds on slow startup — without this guard, VS Code
// sees the keybinding mapped but the command missing.

function registerEarlyCommands(context: vscode.ExtensionContext): void {
  // ── pickCommand (Cmd+/) ─────────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.pickCommand", async () => {
      // Resolve the current piService at invocation time so
      // the command works regardless of which session is active.
      const active = activeSessionWindow ?? primarySession();
      const pi = active?.piService;
      const allCommands = pi?.getAllSlashCommands() ?? [];

      // Build grouped quick-pick items
      const items: vscode.QuickPickItem[] = [];
      const grouped: Record<string, Array<{ cmd: string; desc: string; source: string }>> = {};
      for (const c of allCommands) {
        const group = c.source || "other";
        if (!grouped[group]) { grouped[group] = []; }
        grouped[group].push(c);
      }

      const groupOrder = ["builtin"];
      for (const g of Object.keys(grouped).sort()) {
        if (g !== "builtin") { groupOrder.push(g); }
      }

      for (const group of groupOrder) {
        const cmds = grouped[group];
        if (!cmds || cmds.length === 0) { continue; }
        items.push({
          label: `\u2014 ${group} \u2014`,
          kind: vscode.QuickPickItemKind.Separator,
        });
        for (const c of cmds) {
          items.push({ label: c.cmd, description: c.desc || `(${group})` });
        }
      }

      if (items.length === 0) {
        items.push(
          { label: "/model", description: "Switch model" },
          { label: "/new", description: "Start new session" },
          { label: "/resume", description: "Resume a previous session" },
          { label: "/fork", description: "Fork session from message" },
        );
      }

      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: "Slash command (/)",
        matchOnDescription: true,
      });
      if (picked && typeof picked !== "string" && (picked).kind !== vscode.QuickPickItemKind.Separator) {
        vscode.commands.executeCommand("pi-code-gui.sendSlashCommand", picked.label);
      }
    }),
  );

  // ── pickFile (Cmd+Shift+@) ──────────────────────────
  context.subscriptions.push(
    vscode.commands.registerCommand("pi-code-gui.pickFile", async () => {
      const files = await vscode.workspace.findFiles("**/*", "**/node_modules/**", 200);
      const items = files.map((u) => ({
        label: vscode.workspace.asRelativePath(u),
        uri: u,
      }));
      const picked = await vscode.window.showQuickPick(items, {
        placeHolder: "Pick a file (@)",
      });
      if (picked && typeof picked !== "string") {
        vscode.commands.executeCommand(
          "pi-code-gui.referenceFile",
// eslint-disable-next-line @typescript-eslint/no-explicit-any
          vscode.workspace.asRelativePath((picked as any).uri),
        );
      }
    }),
  );
}

// ── Initialize a single session ───────────────────────

function ensureTreeProvider(context: vscode.ExtensionContext): void {
  if (!sessionTreeProvider) {
    sessionTreeProvider = new MultiSessionTreeProvider(sessions, context);
    sessionTreeView = vscode.window.createTreeView("pi-code-gui.sessions", {
      treeDataProvider: sessionTreeProvider,
    });
    context.subscriptions.push(sessionTreeView);

    // Track expand/collapse of entries headers to preserve state across refreshes
    sessionTreeView.onDidExpandElement((e) => {
      if (e.element.contextValue === "entries-header") {
        sessionTreeProvider!.setEntryHeaderExpanded(e.element.sessionId!, true);
      }
      if (e.element.contextValue === "past-sessions-header") {
        sessionTreeProvider!.pastSessionsExpanded = true;
      }
    });
    sessionTreeView.onDidCollapseElement((e) => {
      if (e.element.contextValue === "entries-header") {
        sessionTreeProvider!.setEntryHeaderExpanded(e.element.sessionId!, false);
      }
      if (e.element.contextValue === "past-sessions-header") {
        sessionTreeProvider!.pastSessionsExpanded = false;
      }
    });

    // We rely on TreeItem.command for single-click navigation (standard VS Code
    // pattern).  Context menus also work because VS Code passes the TreeItem's
    // command arguments to the action handler automatically.
  }
}

/**
 * Refresh the past-sessions list from disk.  Called on activation and after
 * delete / resume operations that change the pool of saved sessions.
 */
async function refreshPastSessionsList(): Promise<void> {
  // Must match how sessions are CREATED (PiService.resolveWorkspaceCwd) — under a
  // no-folder workspace that resolves to the home dir, not process.cwd() (the
  // extension-host server dir). Using process.cwd() here filtered out Rust
  // sessions, since listRustSessions drops entries whose recorded cwd != target.
  const cwd = resolveWorkspaceCwd();
  if (!sessionTreeProvider) {
    piWarn("refreshPastSessionsList: sessionTreeProvider is null, skipping");
    return;
  }
  piDebug(`refreshPastSessionsList: loading past sessions for cwd=${cwd}`);
  await sessionTreeProvider.refreshPastSessions(cwd);
  piDebug(`refreshPastSessionsList: done, found ${sessionTreeProvider.pastSessions.length} past sessions`);
}

async function initSessionInBackground(context: vscode.ExtensionContext, sw: SessionWindow, opts?: { fresh?: boolean; openPath?: string; runtime?: Runtime }): Promise<void> {
  const fresh = opts?.fresh ?? false;
  const openPath = opts?.openPath;
  // Resume-follows-origin: a resumed session uses the runtime that created it.
  const runtime: Runtime = opts?.runtime ?? (openPath ? lookupSessionRuntime(openPath) : sw.runtime);
  sw.runtime = runtime;
  // Ensure tree provider exists ASAP so the tree view shows something
  ensureTreeProvider(context);

  // Start loading past sessions immediately — runs in parallel with SDK init.
  // This prevents the tree from showing an empty "Past Sessions" header
  // while the SDK loads on slow projects.
  const pastSessionsPromise = sw === primarySession()
    ? refreshPastSessionsList().catch((e: unknown) => { piWarn(`Early past-session load failed: ${e instanceof Error ? e.message : String(e)}`); })
    : Promise.resolve();

  // ── Per-runtime install gate ──
  if (runtime === "rust") {
    const rust = detectRustBinary();
    if (!rust.installed) {
      sw.webviewPanel.postMessage({
        type: "status",
        data: { model: "not installed", thinkingLevel: "off", ready: false, runtime },
      });
      sw.webviewPanel.postMessage({
        type: "error",
        data: { message: 'Rust Pi is not installed. Run "PiGui: Install Rust Pi" to install it.' },
      });
      if (!primarySession() || primarySession() === sw) {
        const action = await vscode.window.showErrorMessage(
          "Rust Pi is not installed.",
          "Install Rust Pi",
          "Learn More",
        );
        if (action === "Install Rust Pi") {
          await vscode.commands.executeCommand("pi-code-gui.installRust");
        } else if (action === "Learn More") {
          vscode.env.openExternal(vscode.Uri.parse("https://github.com/Dicklesworthstone/pi_agent_rust"));
        }
      }
      sessionTreeProvider?.refresh();
      return;
    }
  } else {
    const status = await PiService.checkInstall();
    if (!status.installed) {
      sw.webviewPanel.postMessage({
        type: "status",
        data: { model: "not installed", thinkingLevel: "off", ready: false, runtime },
      });
      sw.webviewPanel.postMessage({
        type: "error",
        data: {
          message:
            "Pi coding agent SDK is not installed. " +
            'Click "Install Pi" below or run: npm install -g @earendil-works/pi-coding-agent',
        },
      });

      if (!primarySession() || primarySession() === sw) {
        const action = await vscode.window.showErrorMessage(
          "Pi coding agent SDK is not installed.",
          "Install Pi",
          "Learn More",
        );
        if (action === "Install Pi") {
          await installPi();
        } else if (action === "Learn More") {
          vscode.env.openExternal(vscode.Uri.parse("https://pi.dev"));
        }
      }
      sessionTreeProvider?.refresh();
      return;
    }
  }

  let result: { success: boolean; error?: string; errorKind?: string; warning?: string };
  try {
    result = await sw.piService.initialize(openPath ? { openPath, runtime } : { fresh, runtime });
  } catch (e: unknown) {
    result = { success: false, error: e instanceof Error ? e.message : String(e) };
  }

  if (!result.success) {
    sw.webviewPanel.postMessage({
      type: "status",
      data: { model: "init failed", thinkingLevel: "off", ready: false },
    });

    // Rust + TypeScript-format `.pi/` extensions don't mix: the Rust runtime
    // can't parse them and aborts startup. Point the user at the one setting
    // that resolves it (auto-recovery already ran in "auto" mode).
    if (result.errorKind === "rust-extension-conflict") {
      const base = "Rust Pi couldn't start: this workspace has TypeScript-format Pi extensions (.pi) the Rust runtime can't load.";
      sw.webviewPanel.postMessage({
        type: "error",
        data: { message: `${base} Set "pi-code-gui.rustExtensions" to "disabled" to run Rust here without them.` },
      });
      if (!primarySession() || primarySession() === sw) {
        const DISABLE = "Disable for Rust";
        const OPEN = "Open Setting";
        const LEARN = "Learn More";
        const action = await vscode.window.showErrorMessage(
          `${base} Disable extension discovery for Rust sessions in this workspace?`,
          DISABLE, OPEN, LEARN,
        );
        if (action === DISABLE) {
          await vscode.workspace.getConfiguration("pi-code-gui")
            .update("rustExtensions", "disabled", vscode.ConfigurationTarget.Workspace);
          sw.piService.dispose();
          removeSession(sw);
          addSession(context, runtime);
        } else if (action === OPEN) {
          await vscode.commands.executeCommand("workbench.action.openSettings", "pi-code-gui.rustExtensions");
        } else if (action === LEARN) {
          vscode.env.openExternal(vscode.Uri.parse("https://github.com/Dicklesworthstone/pi_agent_rust"));
        }
      }
      sessionTreeProvider?.refresh();
      return;
    }

    sw.webviewPanel.postMessage({
      type: "error",
      data: { message: redactSecrets(`Pi init failed: ${result.error}`) },
    });

    if (!primarySession() || primarySession() === sw) {
      const action = await vscode.window.showErrorMessage(
        redactSecrets(`Pi init failed: ${result.error}`),
        "Retry",
      );
      if (action === "Retry") {
        sw.piService.dispose();
        removeSession(sw);
        addSession(context, runtime);
      }
    }
    sessionTreeProvider?.refresh();
    return;
  }

  sw.initialized = true;

  // "auto" mode self-healed a TypeScript-extension conflict by disabling Rust
  // extension discovery — tell the user once, and how to change it.
  if (result.warning === "rust-extensions-auto-disabled" && (!primarySession() || primarySession() === sw)) {
    void vscode.window.showInformationMessage(
      'Rust Pi: extensions were disabled for this workspace because its TypeScript-format Pi extensions (.pi) aren\'t compatible with the Rust runtime. Change this via "pi-code-gui.rustExtensions".',
      "Open Setting",
    ).then((a) => {
      if (a === "Open Setting") { void vscode.commands.executeCommand("workbench.action.openSettings", "pi-code-gui.rustExtensions"); }
    });
  }

  // Phase 3/4 commands are global — register once (re-registering on every
  // primary-session init just threw "already registered" and logged noise).
  if (!phaseCommandsRegistered && sw === primarySession()) {
    phaseCommandsRegistered = true;
    // Resolve the live target each invocation — binding to sw.piService would
    // point these global commands at the first session even after it's disposed.
    const resolvePiService = (): PiService | undefined => (activeSessionWindow ?? primarySession())?.piService;
    registerPhase3Commands(context, resolvePiService);
    registerPhase4Commands(context, resolvePiService);
  }

  // Ensure tree provider is registered (safe to call multiple times)
  ensureTreeProvider(context);

  // ── Ensure past sessions are loaded (started earlier in parallel with SDK init) ──
  // The event handler calls sessionTreeProvider.refresh() on every pi event,
  // which triggers VS Code to re-render the tree. We wait for past sessions
  // to finish loading so the initial render shows the correct state.
  if (sw === primarySession()) {
    await pastSessionsPromise;
  }

  // Refresh tree only when something the user can see actually changes.
  // The tree shows session name, model, thinking level, streaming dot, entry
  // count, and usage stats. Most of these change only a few times per session.
  sw.piService.onEvent((event) => {
    let changed = false;

    if (event.type === "agent-start") {
      sw.isStreaming = true;
      changed = true;
    } else if (event.type === "agent-end") {
      sw.isStreaming = false;
      changed = true;
    } else if (event.type === "status-update" && event.data) {
      const was = sw.isStreaming;
      sw.isStreaming = !!event.data.isStreaming;
      if (was !== sw.isStreaming) { changed = true; }
    } else if (
      event.type === "chat-message" ||
      event.type === "compaction-summary-message"
    ) {
      changed = true; // entry count / usage stats changed
    }

    if (changed) { sessionTreeProvider?.refresh(); }
  });

  // Notify webview that pi is ready
  sw.webviewPanel.postMessage({
    type: "status",
    data: {
      model: sw.piService.model?.id ?? "ready",
      thinkingLevel: sw.piService.thinkingLevel,
      ready: true,
      runtime: sw.piService.runtime,
    },
  });

  if (!sessionTreeProvider) {
    piWarn("sessionTreeProvider is null at refresh time — forcing creation");
    ensureTreeProvider(context);
  }
  // Use targeted refresh — fires with the specific session item so VS Code
  // updates its label/collapsibleState in-place rather than diffing new
  // objects (which it can silently drop during async init).
  sessionTreeProvider!.refreshSession(sw);

  await new Promise((resolve) => setTimeout(resolve, 50));
  sessionTreeProvider!.refreshSession(sw);

  // Record the session's origin runtime as soon as its file path is known, so a
  // reload mid-conversation still lets Past Sessions resume-follow-origin. (Panel
  // revival itself is owned by VS Code's webview serializer.)
  const readyPath = sw.piService.sessionFilePath;
  if (readyPath) { void recordSessionRuntime(readyPath, sw.piService.runtime); }

  piDebug(`Pi Code Gui session ${sw.id} ready`);
}

function removeSession(sw: SessionWindow): void {
  const idx = sessions.indexOf(sw);
  if (idx !== -1) {
    sessions.splice(idx, 1);
  }
  updateHadOpenPanels();
  // If the removed session was the active one, fall back to the latest open session
  if (activeSessionWindow === sw) {
    setActiveSession(sessions.length > 0 ? sessions[sessions.length - 1] : null);
  }
  // Refresh tree so "Open Sessions (N)" header updates count
  sessionTreeProvider?.refresh();
}

/** Keep the "were any panels open?" hint current. Read once at activate to decide
 *  whether to auto-open a fresh session (panels being revived by VS Code means no
 *  auto-open). It is a HINT for that one decision — restore correctness never
 *  depends on it (VS Code owns panel revival). */
function updateHadOpenPanels(): void {
  void extContext?.workspaceState.update("pi-code-gui.hadOpenPanels", sessions.length > 0);
}

// ── Install helper ──────────────────────────────────────

async function installPi(): Promise<void> {
  return new Promise((resolve) => {
    const term = vscode.window.createTerminal("Pi Install");
    term.show();
    term.sendText("npm install -g @earendil-works/pi-coding-agent");
    term.sendText(
      'echo "✅ Pi SDK installed! Reload VS Code to use Pi Code Gui."',
    );
    vscode.window
      .showInformationMessage(
        "Installing Pi SDK... Reload VS Code after the terminal finishes.",
        "Reload Now",
      )
      .then((action) => {
        if (action === "Reload Now") {
          vscode.commands.executeCommand("workbench.action.reloadWindow");
        }
      });
    resolve();
  });
}

// ── Multi-Session Tree Provider ───────────────────────────

/**
 * The Sessions view in the VS Code sidebar:
 *
 *   Pi Sessions
 *     ▼ Open Sessions (2)              ← open-sessions-header
 *         Session 1  ●  claude-sonnet  ← session (active/live)
 *           Model: ...
 *           Thinking: ...
 *           ↑ 2k / ↓5k  $0.042
 *           Entries (12)               ← entries-header
 *             📝 hello
 *             🤖 Hi! I can...
 *         Session 2  ●  gpt-4o
 *           ...
 *     ▼ Past Sessions (5)             ← past-sessions-header
 *         chat about auth (3 msgs)     ← pastSessionEntry
 *         refactor done (12 msgs)
 *         ...
 */

class MultiSessionTreeProvider implements vscode.TreeDataProvider<SessionTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<SessionTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  /** Track which sessions have their entries header expanded so refresh doesn't collapse them. */
  private expandedEntries = new Set<string>();
  /** Track if past sessions header is expanded. */
  pastSessionsExpanded = false;
  /** Past sessions loaded from disk via SessionManager.list(). */
  private _pastSessions: SessionSummary[] = [];
  /** True while we are refreshing past sessions. */
  private _loadingPast = false;
  /** Current filter string for past sessions (empty = no filter). */
  public pastFilter = "";
  /** Cache of current session tree items so we can update them in-place. */
  private _sessionItems = new Map<string, SessionTreeItem>();

  constructor(private sessions: SessionWindow[], private context: vscode.ExtensionContext) {}

  /** Called by TreeView expand/collapse events to track entries-header state. */
  setEntryHeaderExpanded(sessionId: string, expanded: boolean): void {
    if (expanded) { this.expandedEntries.add(sessionId); }
    else { this.expandedEntries.delete(sessionId); }
  }

  get pastSessions(): SessionSummary[] { return this._pastSessions; }
  /** Cached past-sessions header so targeted refreshes use the same object. */
  private _pastHeaderItem: SessionTreeItem | null = null;

  /** Reload past sessions from disk asynchronously and fire refresh. */
  async refreshPastSessions(cwd: string): Promise<void> {
    this._loadingPast = true;
    try {
      const scope = vscode.workspace.getConfiguration("pi-code-gui").get<string>("sessionHistoryScope") ?? "unified";
      const defaultRt = defaultRuntimeForNewSession();

      // TypeScript sessions come from the SDK (returns [] if the SDK is absent);
      // Rust sessions are read directly from the Rust storage dir.
      const tsSessions: SessionSummary[] = (await PiService.listSessions(cwd)).map((s: SessionSummary) => ({ ...s, runtime: "typescript" }));
      const rustSessions = listRustSessions(cwd);

      let merged: SessionSummary[];
      if (scope === "perRuntime") {
        merged = defaultRt === "rust" ? rustSessions : tsSessions;
      } else {
        merged = [...tsSessions, ...rustSessions];
      }
      merged.sort((a, b) => (b.modified ?? b.created ?? 0) - (a.modified ?? a.created ?? 0));
      this._pastSessions = merged;
      piDebug(`refreshPastSessions: ${tsSessions.length} TS + ${rustSessions.length} Rust (scope=${scope})`);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      piWarn(`refreshPastSessions failed: ${e.message ?? e}`);
      this._pastSessions = [];
    }
    this._loadingPast = false;
    // Full refresh updates the root-level labels and open sessions.
    this.refresh();
    // Targeted refresh forces VS Code to re-read the past-sessions
    // header, picking up the collapsibleState change (None → Collapsed)
    // that a full refresh alone can silently miss.
    this.refreshPastOnly();
  }

  /** Lightweight refresh (does not re-fetch past sessions). */
  refresh(): void { this._onDidChangeTreeData.fire(); }

  /** Refresh a single session's tree item in-place.  More reliable than
   *  fire() with no argument, which VS Code can drop during async setup. */
  refreshSession(sw: SessionWindow): void {
    const item = this._sessionItems.get(sw.id);
    if (item) {
      this.makeSessionItem(sw);
      this._onDidChangeTreeData.fire(item);
    } else {
      this._onDidChangeTreeData.fire();
    }
  }

  /** Refresh only past sessions children — preserves expand state. */
  refreshPastOnly(): void {
    // Use the cached header element so VS Code can match it by reference
    // to the one returned by getChildren().  A fresh SessionTreeItem with
    // the same id is not reference-equal and VS Code ignores the event.
    if (this._pastHeaderItem) {
      this._onDidChangeTreeData.fire(this._pastHeaderItem);
    } else {
      this._onDidChangeTreeData.fire();
    }
  }

  getTreeItem(element: SessionTreeItem): vscode.TreeItem { return element; }

  async getChildren(element?: SessionTreeItem): Promise<SessionTreeItem[]> {
    // ── Root level: two headers (open sessions / past sessions) ──
    if (!element) {
      const children: SessionTreeItem[] = [];

      // Open Sessions
      children.push(new SessionTreeItem(
        `Open Sessions`,
        "open-sessions-header",
        undefined,
        this.sessions.length > 0
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed,
      ));

      // Past Sessions
      const pastCount = this._pastSessions.length;
      const filteredCount = this.pastFilter
        ? this._pastSessions.filter((s) => this.matchesPastFilter(s)).length
        : pastCount;
      let pastLabel: string;
      let pastState: vscode.TreeItemCollapsibleState;
      if (this._loadingPast) {
        pastLabel = "Past Sessions (loading...)";
        pastState = vscode.TreeItemCollapsibleState.None;
      } else if (pastCount > 0) {
        pastLabel = this.pastFilter
          ? `Past Sessions (${filteredCount} of ${pastCount})`
          : `Past Sessions (${pastCount})`;
        pastState = this.pastSessionsExpanded
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed;
      } else {
        pastLabel = "Past Sessions (none)";
        pastState = vscode.TreeItemCollapsibleState.None;
      }
      const pastItem = new SessionTreeItem(
        pastLabel,
        "past-sessions-header",
        undefined,
        pastState,
      );
      pastItem.id = "__past_sessions_header__";
      if (this.pastFilter) {
        pastItem.iconPath = new vscode.ThemeIcon("filter");
      }
      this._pastHeaderItem = pastItem;  // cache for targeted refresh
      children.push(pastItem);

      return children;
    }

    // ── Open sessions ────────────────────────────────────
    if (element.contextValue === "open-sessions-header") {
      return this.sessions.map((sw) => this.makeSessionItem(sw));
    }

    if (element.contextValue === "session") {
      return this.getSessionChildren(element);
    }

    if (element.contextValue === "entries-header") {
      return this.getEntryChildren(element);
    }

    // ── Past sessions ────────────────────────────────────
    if (element.contextValue === "past-sessions-header") {
      const filtered = this.pastFilter
        ? this._pastSessions.filter((s) => this.matchesPastFilter(s))
        : this._pastSessions;
      return filtered.map((s) => this.makePastSessionItem(s));
    }

    return [];
  }

  // ── Open session items (unchanged logic) ──────────────

  private makeSessionItem(sw: SessionWindow): SessionTreeItem {
    // Derive label from session name (via session_info), tab summary (AI-generated), or fall back to "Session N"
    const sessionName = sw.piService.sessionName
      ?? sw.webviewPanel.summary
      ?? getGenericSessionLabel(sw.id);

    const label = sw.initialized
      ? ((sw.isStreaming ? "\u25CF " : "\u25CB ") + sessionName)
      : `${sessionName}: initializing...`;

    // Cache the label for use in panel title updates
    sw.label = sw.initialized ? sessionName : sw.label;

    const entryCount = getEntryCount(sw);
    const collapsible = sw.initialized && entryCount === 0
      ? vscode.TreeItemCollapsibleState.None
      : vscode.TreeItemCollapsibleState.Collapsed;

    let item = this._sessionItems.get(sw.id);
    if (item) {
      // Mutate in-place AND change the id when state transitions.
      // VS Code uses id for internal diffing — a stable id across a
      // state change can cause it to silently skip re-rendering.
      const newId = `${sw.id}-${sw.initialized ? "rdy" : "init"}`;
      item.id = newId;
      item.label = label;
      item.collapsibleState = collapsible;
      item.description = sw.initialized ? `${runtimeBadge(sw.runtime)} · ${sw.piService.model?.id ?? "..."}` : "initializing";
      item.tooltip = new vscode.MarkdownString(
        `**${sw.id}**\n\nRuntime: ${sw.runtime === "rust" ? "Rust Pi" : "TypeScript Pi"}\nModel: ${sw.piService.model?.id ?? "-"}\nThinking: ${sw.piService.thinkingLevel}\nEntries: ${entryCount}\nInitialized: ${sw.initialized}\nStreaming: ${sw.isStreaming}`,
      );
    } else {
      item = new SessionTreeItem(
        label,
        "session",
        {
          command: "pi-code-gui.focusSession",
          title: "Focus Session",
          arguments: [sw.id],
        },
        collapsible,
      );
      item.id = `${sw.id}-${sw.initialized ? "rdy" : "init"}`;
      item.sessionId = sw.id;
      item.description = sw.initialized ? `${runtimeBadge(sw.runtime)} · ${sw.piService.model?.id ?? "..."}` : "initializing";
      item.tooltip = new vscode.MarkdownString(
        `**${sw.id}**\n\nRuntime: ${sw.runtime === "rust" ? "Rust Pi" : "TypeScript Pi"}\nModel: ${sw.piService.model?.id ?? "-"}\nThinking: ${sw.piService.thinkingLevel}\nEntries: ${entryCount}\nInitialized: ${sw.initialized}\nStreaming: ${sw.isStreaming}`,
      );
      this._sessionItems.set(sw.id, item);
    }

    return item;
  }

  private getSessionChildren(element: SessionTreeItem): SessionTreeItem[] {
    const sw = this.sessions.find((s) => s.id === element.sessionId);
    if (!sw) { return []; }

    // Before initialization, show placeholder items so the user can see
    // the tree structure even while the SDK is loading
    if (!sw.initialized) {
      const loading = new SessionTreeItem("Loading Pi SDK...", "loading");
      loading.iconPath = new vscode.ThemeIcon("loading~spin");
      loading.description = "please wait";
      return [loading];
    }

    const ps = sw.piService;
    const children: SessionTreeItem[] = [];

    // Model
    const modelItem = new SessionTreeItem(
      `Model: ${ps.model?.id ?? "..."}`,
      "model",
      { command: "pi-code-gui.pickSessionModel", title: "Change Model", arguments: [sw.id] },
    );
    modelItem.contextValue = "session-model";
    children.push(modelItem);

    // Thinking level
    const thinkingItem = new SessionTreeItem(
      `Thinking: ${ps.thinkingLevel}`,
      "thinking",
      { command: "pi-code-gui.pickSessionThinking", title: "Change Thinking Level", arguments: [sw.id] },
    );
    thinkingItem.contextValue = "session-thinking";
    children.push(thinkingItem);

    // Usage
    const stats = ps.getUsageStats();
    const statsParts: string[] = [];
    if (stats.input > 0) { statsParts.push(`\u2191${formatTokens(stats.input)}`); }
    if (stats.output > 0) { statsParts.push(`\u2193${formatTokens(stats.output)}`); }
    if (stats.cacheRead > 0) { statsParts.push(`R${formatTokens(stats.cacheRead)}`); }
    if (stats.cacheWrite > 0) { statsParts.push(`W${formatTokens(stats.cacheWrite)}`); }
    if (stats.cost > 0) { statsParts.push(`$${stats.cost.toFixed(3)}`); }
    if (stats.contextWindow > 0 && stats.contextPercent !== null) {
      statsParts.push(`${stats.contextPercent.toFixed(1)}%`);
    } else if (stats.contextWindow > 0) { statsParts.push("?%"); }
    if (statsParts.length > 0) {
      const usageItem = new SessionTreeItem(statsParts.join(" "), "usage");
      usageItem.contextValue = "session-usage";
      usageItem.description = "tokens / cost";
      children.push(usageItem);
    }

    // Entries
    const entries = ps.getDisplayEntries();
    if (entries && entries.length > 0) {
      const alreadyExpanded = this.expandedEntries.has(sw.id);
      const entriesHeader = new SessionTreeItem(
        `Entries (${entries.length})`,
        "entries-header",
        undefined,
        alreadyExpanded
          ? vscode.TreeItemCollapsibleState.Expanded
          : vscode.TreeItemCollapsibleState.Collapsed,
      );
      entriesHeader.sessionId = sw.id;
      entriesHeader.contextValue = "entries-header";
      children.push(entriesHeader);
    }

    return children;
  }

  private getEntryChildren(element: SessionTreeItem): SessionTreeItem[] {
    const sw = this.sessions.find((s) => s.id === element.sessionId);
    if (!sw) { return []; }

    const entries = sw.piService.getDisplayEntries();
    if (!entries || entries.length === 0) { return []; }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
    return entries.map((entry: any) => {
      const { label, tooltip, type, fullText } = formatEntryLabel(entry);
      const item = new SessionTreeItem(label, type, {
        command: "pi-code-gui.revealEntry",
        title: "Show in Chat",
        arguments: [sw.id, entry.id, entry.message?.toolCallId ?? ""],
      });
      item.tooltip = tooltip;
      // Tag message entries so we can restrict fork/clone context menus
      if (entry.type === "message" && entry.message?.role === "user") {
        item.contextValue = "sessionEntry-user";
      } else if (entry.type === "message" && entry.message?.role === "assistant") {
        item.contextValue = "sessionEntry-assistant";
      } else if (entry.type === "custom_message") {
        item.contextValue = "sessionEntry-custom";
      } else {
        item.contextValue = "sessionEntry";
      }
// eslint-disable-next-line @typescript-eslint/no-explicit-any
      (item as any)._fullText = fullText;
      return item;
    });
  }

  // ── Past session items ────────────────────────────────

  /** Check if a past session matches the current filter. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  private matchesPastFilter(s: any): boolean {
    if (!this.pastFilter) { return true; }
    const q = this.pastFilter.toLowerCase();
    // Match against name / title
    if (s.name && s.name.toLowerCase().includes(q)) { return true; }
    // Match against first message content
    if (s.firstMessage && s.firstMessage.toLowerCase().includes(q)) { return true; }
    return false;
  }

// eslint-disable-next-line @typescript-eslint/no-explicit-any
  private makePastSessionItem(s: any): SessionTreeItem {
    const label = s.name
      ? s.name
      : truncate(s.firstMessage || "(no messages)", 50);

    const dateStr = s.modified
      ? formatRelativeTime(new Date(s.modified))
      : "";
    const msgCount = s.messageCount ?? 0;
    const rt: Runtime = s.runtime === "rust" ? "rust" : "typescript";
    const desc = `${runtimeBadge(rt)} · ${msgCount} msg${msgCount === 1 ? "" : "s"}${dateStr ? " · " + dateStr : ""}`;

    const item = new SessionTreeItem(
      label,
      "pastSessionEntry",
      {
        command: "pi-code-gui.resumePastSession",
        title: "Resume Session",
        arguments: [s.path],
      },
    );
    item.description = desc;
    item.iconPath = new vscode.ThemeIcon(rt === "rust" ? "server-process" : "archive");
    item.tooltip = new vscode.MarkdownString(
      `**${s.name || "Session"}**\n\nRuntime: ${rt === "rust" ? "Rust Pi" : "TypeScript Pi"}\nPath: \`${s.path}\`\nMessages: ${msgCount}\nCreated: ${s.created ? new Date(s.created).toLocaleString() : "-"}\nModified: ${s.modified ? new Date(s.modified).toLocaleString() : "-"}`,
    );
    item.contextValue = "pastSessionEntry";
    return item;
  }
}

/**
 * Format a session entry for display in the tree.
 * Mirrors the pi TUI's entry display logic (roles, compaction, tools, etc.).
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function formatEntryLabel(entry: any): { label: string; tooltip: string; type: string; fullText: string } {
  const maxLen = 60;

  if (entry.type === "message") {
    const role = entry.message?.role;
    if (role === "user") {
      const fullText = extractText(entry.message?.content);
      const text = truncate(fullText, maxLen);
      return { label: `📝 ${text || "(empty)"}`, tooltip: fullText, type: "user", fullText };
    }
    if (role === "assistant") {
      const fullText = extractText(entry.message?.content);
      const text = truncate(fullText, maxLen);
      const label = text
        ? `🤖 ${text}`
        : `🤖 (${entry.message?.stopReason ?? "tool use"})`;
      return { label, tooltip: fullText || entry.message?.errorMessage || "", type: "assistant", fullText: fullText || "" };
    }
    if (role === "toolResult") {
      const tcName = entry.message?.toolName ?? "tool";
      const fullText = extractText(entry.message?.content);
      const text = truncate(fullText, maxLen);
      return { label: `[${tcName}] ${text}`, tooltip: fullText, type: "toolResult", fullText };
    }
    if (role === "bashExecution") {
      const cmd = entry.message?.command ?? "";
      return { label: `[bash] ${truncate(cmd, maxLen)}`, tooltip: cmd, type: "bashExecution", fullText: cmd };
    }
    if (role === "custom") {
      const fullText = extractText(entry.message?.content);
      const text = truncate(fullText, maxLen);
      return { label: `[custom] ${text}`, tooltip: fullText, type: "custom_message", fullText };
    }
  }

  if (entry.type === "compaction") {
    const kt = Math.round((entry.tokensBefore ?? 0) / 1000);
    return { label: `[compaction: ~${kt}k tokens]`, tooltip: entry.summary ?? "", type: "compaction", fullText: entry.summary ?? "" };
  }
  if (entry.type === "branch_summary") {
    const fullText = entry.summary ?? "";
    const text = truncate(fullText, maxLen);
    return { label: `[branch summary] ${text}`, tooltip: fullText, type: "branch_summary", fullText };
  }
  if (entry.type === "model_change") {
    const fullText = `Provider: ${entry.provider}`;
    return { label: `[model: ${entry.modelId}]`, tooltip: fullText, type: "model_change", fullText };
  }
  if (entry.type === "thinking_level_change") {
    return { label: `[thinking: ${entry.thinkingLevel}]`, tooltip: "", type: "thinking_level_change", fullText: "" };
  }
  if (entry.type === "custom_message") {
    const fullText = typeof entry.content === "string" ? entry.content : extractText(entry.content);
    const text = truncate(fullText, maxLen);
    return { label: `[${entry.customType}] ${text}`, tooltip: fullText, type: "custom_message", fullText };
  }
  if (entry.type === "custom") {
    return { label: `[custom: ${entry.customType}]`, tooltip: "", type: "custom", fullText: "" };
  }
  if (entry.type === "label") {
    return { label: `[label: ${entry.label ?? "(cleared)"}]`, tooltip: "", type: "label", fullText: "" };
  }
  if (entry.type === "session_info") {
    return { label: `[title: ${entry.name ?? "(empty)"}]`, tooltip: "", type: "session_info", fullText: "" };
  }

  // Fallback for unknown entry types
  return { label: `[${entry.type}]`, tooltip: JSON.stringify(entry, null, 2), type: entry.type, fullText: "" };
}

function getEntryCount(sw: SessionWindow): number {
  // Runtime-agnostic: TS reads its SessionManager, Rust reads its get_messages
  // cache. Using the unified accessor keeps Rust sessions expandable like TS.
  return sw.piService.getDisplayEntries()?.length ?? 0;
}

function truncate(s: string, max: number): string {
  if (s.length <= max) { return s; }
  return s.slice(0, max) + "\u2026";
}

function formatTokens(count: number): string {
  if (count < 1000) { return count.toString(); }
  if (count < 10000) { return `${(count / 1000).toFixed(1)}k`; }
  if (count < 1000000) { return `${Math.round(count / 1000)}k`; }
  if (count < 10000000) { return `${(count / 1000000).toFixed(1)}M`; }
  return `${Math.round(count / 1000000)}M`;
}

function formatRelativeTime(date: Date): string {
  const now = Date.now();
  const diff = now - date.getTime();
  const mins = Math.floor(diff / 60000);
  const hours = Math.floor(diff / 3600000);
  const days = Math.floor(diff / 86400000);
  if (mins < 1) { return "just now"; }
  if (mins < 60) { return `${mins}m ago`; }
  if (hours < 24) { return `${hours}h ago`; }
  if (days < 7) { return `${days}d ago`; }
  return date.toLocaleDateString();
}

// ── UI pickers for per-session model / thinking level ──────

class SessionTreeItem extends vscode.TreeItem {
  public sessionId?: string;

  constructor(
    label: string,
    type: string,
    command?: vscode.Command,
    collapsible?: vscode.TreeItemCollapsibleState,
  ) {
    super(label, collapsible ?? vscode.TreeItemCollapsibleState.None);
    this.command = command;
    this.contextValue = type;
    this.iconPath = new vscode.ThemeIcon(
      type === "session" || type === "sessions-header" ? "multiple-windows"
      : type === "model" ? "symbol-misc"
      : type === "thinking" ? "lightbulb"
      : type === "usage" ? "graph"
      : type === "entries-header" ? "list-tree"
      : type === "user" ? "person"
      : type === "assistant" ? "comment"
      : type === "toolResult" || type === "bashExecution" ? "tools"
      : type === "compaction" ? "archive"
      : type === "branch_summary" ? "git-branch"
      : type === "model_change" ? "gear"
      : type === "thinking_level_change" ? "lightbulb-autofix"
      : type === "custom_message" ? "pencil"
      : type === "custom" ? "symbol-property"
      : type === "label" ? "tag"
      : type === "session_info" ? "info"
      : "play",
    );
  }
}

export async function deactivate(): Promise<void> {
  // Panel restore is VS Code's (webview serializer); here we only record each open
  // session's origin runtime so Past Sessions can resume-follow-origin after reload.
  for (const sw of sessions) {
    const fp = sw.piService.sessionFilePath;
    if (fp) { await recordSessionRuntime(fp, sw.piService.runtime); }
  }
  // Iterate a SNAPSHOT: webviewPanel.dispose() fires onDidDispose → handlePanelDispose →
  // removeSession → sessions.splice(), so disposing while iterating the live array skipped
  // every other session — orphaning its Rust subprocess and, for a TypeScript session, never
  // running the unflushed _rewriteFile() (losing conversation entries) on an ordinary window
  // close with more than one tab open. The panel callback already disposes the service, so
  // calling piService.dispose() here too would double-dispose the ones that DID get cleaned up.
  for (const sw of [...sessions]) {
    sw.webviewPanel.dispose();
  }
  sessions.length = 0;
  // Stop output-channel writes last, so a late log during teardown can't throw
  // "Channel has been closed" from the global unhandledRejection handler.
  disposeLogger();
}
