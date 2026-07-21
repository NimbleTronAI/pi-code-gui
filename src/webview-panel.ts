import * as vscode from "vscode";
import type { PiService } from "./pi-service.js";
import type { PiServiceEvent } from "./types.js";
import { validateExtensionToWebview, validateWebviewToExtension, type WebviewToExtension, type ExtensionToWebview } from "./shared/protocol.js";
import { piWarn } from "./logger.js";
import { safeExternalUrlString, safeWorkspaceFilePath } from "./shared/webview-nav-guard.js";

export type PanelDisposeCallback = (piService: PiService) => void;

export class PiWebviewPanel {
  private panel: vscode.WebviewPanel | null = null;
  private piService: PiService;
  private disposables: vscode.Disposable[] = [];
  /** Cleanup function returned by piService.onEvent() */
  private piCleanup: (() => void) | null = null;

  // Tab indicator state
  private _tabInitialized = false;
  private _tabStreaming = false;
  private _tabSummary: string | null = null;

  /** Callback invoked when the panel is disposed (VS Code tab closed) */
  private _onDispose: PanelDisposeCallback | null = null;

  constructor(
    private context: vscode.ExtensionContext,
    piService: PiService
  ) {
    this.piService = piService;
  }

  /** Register a callback that fires when the panel/webview is closed. */
  set onDispose(cb: PanelDisposeCallback | null) { this._onDispose = cb; }

  /** Register a callback that fires when this panel/view becomes active. */
  set onActivate(cb: (() => void) | null) { this._onActivateCb = cb; }
  private _onActivateCb: (() => void) | null = null;

  async show(): Promise<void> {
    if (this.panel) {
      this.panel.reveal();
      return;
    }

    // STABLE viewType: VS Code persists panels by viewType and revives them across
    // reload via the WebviewPanelSerializer registered in extension.ts (a random
    // viewType would opt out of restoration). Stale-HTML across extension upgrades
    // is a non-issue: attach() regenerates the HTML on every create AND revive.
    const panel = vscode.window.createWebviewPanel(
      "pi-code-gui.session",
      "Pi Code Gui",
      vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, "media"),
        ],
      }
    );
    this.attach(panel);
  }

  /** Adopt a panel VS Code revived through the WebviewPanelSerializer. The panel
   *  already exists (VS Code re-created it in its saved column/order); we only wire
   *  it up exactly like a freshly created one. */
  adoptPanel(panel: vscode.WebviewPanel): void {
    if (this.panel) {
      piWarn("adoptPanel called but a panel is already attached — disposing the revived duplicate");
      panel.dispose();
      return;
    }
    // Re-assert webview options: revival restores what was serialized, but scripts +
    // media access must hold regardless of which extension version created the panel.
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.context.extensionUri, "media")],
    };
    this.attach(panel);
  }

  /** Shared wiring for created AND revived panels: icon, fresh HTML, message and
   *  lifecycle handlers. Regenerating the HTML here is what makes restoration safe
   *  across extension upgrades — a revived panel never runs stale markup. */
  private attach(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    panel.iconPath = {
      light: vscode.Uri.joinPath(this.context.extensionUri, "media", "pi-icon-light.svg"),
      dark: vscode.Uri.joinPath(this.context.extensionUri, "media", "pi-icon-dark.svg"),
    };

    panel.webview.html = this.getWebviewContent(panel.webview);
    this.setupWebviewHandlers();
    this.setupServiceHandlers();

    panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active && this._onActivateCb) {
        this._onActivateCb();
      }
    });

    panel.onDidDispose(() => {
      // Notify the owner (extension.ts) so it can save and remove from open sessions
      if (this._onDispose) {
        this._onDispose(this.piService);
      }
      this.panel = null;
      this.disposables.forEach((d) => d.dispose());
      this.disposables = [];
      this.cleanupPiListener();
    });
  }

  /** Allowlisted external URL → Uri, or null when blocked. See shared/webview-nav-guard.ts. */
  private safeExternalUrl(raw: unknown): vscode.Uri | null {
    const ok = safeExternalUrlString(raw);
    return ok ? vscode.Uri.parse(ok) : null;
  }

  /** Workspace-confined file → Uri, or null when the path escapes every root. */
  private safeWorkspaceFile(raw: unknown): vscode.Uri | null {
    const roots = (vscode.workspace.workspaceFolders ?? []).map((f) => f.uri.fsPath);
    const abs = safeWorkspaceFilePath(raw, roots);
    return abs ? vscode.Uri.file(abs) : null;
  }

  private setupWebviewHandlers(): void {
    if (!this.panel) {
      piWarn("setupWebviewHandlers called with no panel — webview messages will be lost");
      return;
    }

    // Proactively send status every 500ms until pi is ready
    // This avoids the webview-to-extension 'ready' handshake entirely
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    let statusInterval: any = null;
    let statusPolls = 0;
    // Bound the initial-status poll: it normally stops as soon as the model
    // resolves, but if a session never reports a model (e.g. a Rust session that
    // failed to authenticate), an unbounded 500ms poll would spam status forever.
    // Status is also pushed event-driven via reportStatus(), so giving up here is safe.
    const MAX_STATUS_POLLS = 40; // ~20s
    const startPolling = (): void => {
      if (statusInterval) {return;}
      statusInterval = setInterval(() => {
        const model = this.piService.model;
        this.postMessage({
          type: "status",
          data: {
            model: model?.id ?? "loading...",
            thinkingLevel: this.piService.thinkingLevel,
            ready: model !== null,
            runtime: this.piService.runtime,
          },
        });
        if ((model !== null || ++statusPolls >= MAX_STATUS_POLLS) && statusInterval) {
          clearInterval(statusInterval);
          statusInterval = null;
          this._tabInitialized = true;
          this.updateTabIndicator();
        }
      }, 500);
    };
    startPolling();
    this.disposables.push({ dispose: () => { if (statusInterval) {clearInterval(statusInterval);} } });

    this.panel.webview.onDidReceiveMessage(
      async (message) => {
        // BLOCKING inbound validation. This used to warn and dispatch anyway, which made the
        // Zod schema decorative: a malformed or forged message reached the handlers regardless,
        // and openUrl/openFile below act on webview-supplied strings. Drop what doesn't validate.
        const inbound = validateWebviewToExtension(message);
        if (!inbound.success) {
          piWarn(`webview→extension message REJECTED (type "${(message as { type?: unknown })?.type}"): ${inbound.error}`);
          return;
        }
        switch (message.type) {
          case "prompt": {
 
              const msg = message;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
              this.piService.sendPrompt(msg.text, msg.images, msg.mode).catch((error: any) => {
                let errMsg = error.message ?? String(error);
                if (/api.?key|login|authenticate|provider/i.test(errMsg)) {
                  errMsg += "\n\n[Set up an API key →](https://pi.dev/docs/latest/quickstart)";
                }
                this.postMessage({ type: "error", data: { message: errMsg } });
              });
            }
            break;

          case "abort":
            await this.piService.abort();
            break;

          case "pickModel":
            void this.triggerModelPicker();
            break;

          case "pickThinkingLevel":
            void this.triggerThinkingPicker();
            break;

          case "switchRuntime":
            void vscode.commands.executeCommand("pi-code-gui.switchRuntime");
            break;

          case "openUrl": {
            // The sender is a blanket handler over MODEL-RENDERED content: handlers/index.ts
            // posts openUrl for any <a href> in the transcript. Without an allowlist a markdown
            // link to e.g. vscode://<publisher>.<ext>/… reached openExternal on one user click.
            const url = this.safeExternalUrl(message.url);
            if (!url) {
              piWarn(`Blocked openUrl with a disallowed scheme: ${String(message.url).slice(0, 120)}`);
              break;
            }
            void vscode.env.openExternal(url);
            break;
          }

          case "openFile": {
            // Same exposure: render/engine.ts posts openFile for any element carrying data-path,
            // and that attribute is model-authored. Confine it to the workspace so an injected
            // data-path="/home/<user>/.ssh/id_rsa" can't open arbitrary files.
            const file = this.safeWorkspaceFile(message.path);
            if (!file) {
              piWarn(`Blocked openFile outside the workspace: ${String(message.path).slice(0, 200)}`);
              break;
            }
            void vscode.window.showTextDocument(file);
            break;
          }

          // Slash commands intercepted locally (not sent to LLM)
          case "slashCommand":
            void this.handleSlashCommand(message.command);
            break;

          // Settings toggle messages from webview (#3)
          case "toggleAutoCompaction":
            await this.piService.toggleAutoCompaction();
            break;

          case "toggleAutoRetry":
            await this.piService.toggleAutoRetry();
            break;

          case "toggleShowImages":
            await this.piService.toggleShowImages();
            break;

          // Request settings state (#3)
          case "getSettings":
            this.piService.emitSettings();
            break;

          // Context budget picker
          case "pickContextBudget":
            void this.triggerContextBudgetPicker();
            break;

          // Request settings state (#2, #8)
          case "resendUserMessage":
            if (message.text) {
              await this.piService.sendPrompt(message.text);
            }
            break;

          case "promoteToSteer":
            if (message.text) {
              await this.piService.promoteToSteer(message.text);
            }
            break;

          case "extension_ui_response":
            this.piService.resolveDialog(message.id, message.value);
            break;

          case "clearQueue":
            await this.piService.clearQueue();
            break;
        }
      },
      undefined,
      this.disposables
    );
  }

  private setupServiceHandlers(): void {
    // Remove any stale listener before adding a new one (prevents duplicates on panel reopen)
    this.cleanupPiListener();
    this.piCleanup = this.piService.onEvent((event: PiServiceEvent) => {
      this.postMessage(event);

      // Capture first user input for tab title summary.
      // Only generate if the session does NOT already have a stored name
      // (avoids overwriting a prior AI name or manual rename on reopen).
      if (event.type === "chat-message" && event.data?.role === "user" && !this._tabSummary && !this.piService.sessionName) {
        const text: string = event.data?.content ?? "";
        if (text.trim()) {
          // Persist a fallback name immediately so the session survives even
          // if the AI call times out or the tab closes before the model responds.
          const fallback = text.replace(/\s+/g, " ").trim().slice(0, 50);
          this._tabSummary = fallback;
          this.updateTabIndicator();
          this.piService.setSessionName(fallback);

          // Then try to upgrade to a concise AI-generated summary
          this.piService.generateTabSummary(text).then((summary) => {
            if (summary && summary !== fallback) {
              this._tabSummary = summary;
              this.updateTabIndicator();
              this.piService.setSessionName(summary);
            }
          }).catch(() => {});
        }
      }

      // When the SDK updates the session name/label, update the tab title
      if (event.type === "status-update" && event.data) {
        const sessionName = this.piService.sessionName;
        if (sessionName && sessionName !== this._tabSummary) {
          this._tabSummary = sessionName;
          this._tabInitialized = true;
          this.updateTabIndicator();
        }
      }

      // Track streaming state for the tab indicator
      if (event.type === "agent-start") {
        this._tabStreaming = true;
        this.updateTabIndicator();
      } else if (event.type === "agent-end") {
        this._tabStreaming = false;
        this.updateTabIndicator();
      } else if (event.type === "status-update" && event.data) {
        const wasStreaming = this._tabStreaming;
        this._tabStreaming = !!event.data.isStreaming;
        if (!event.data.ready && event.data.ready !== undefined) {
          this._tabInitialized = false;
        }
        if (this._tabStreaming !== wasStreaming) {
          this.updateTabIndicator();
        }
      }
    });
  }

  /** Update the tab title to indicate streaming / idle / init state.
   *  The in-webview status bar handles the visual color indicator;
   *  the tab uses a text suffix for streaming so it stays theme-consistent. */
  private updateTabIndicator(): void {
    if (!this.panel) { return; }

    // Static icon — no colour coding (SVGs can't adapt to theme variables)
    const piIcon = (name: string): vscode.Uri =>
      vscode.Uri.joinPath(this.context.extensionUri, "media", name);
    this.panel.iconPath = {
      light: piIcon("pi-icon-light.svg"),
      dark: piIcon("pi-icon-dark.svg"),
    };

    if (!this._tabInitialized) {
      this.panel.title = "Pi Code Gui";
      return;
    }

    const label = this._tabSummary ?? "Pi";
    // Bullet prefix: ● busy, ○ idle — consistent with status bar
    this.panel.title = (this._tabStreaming ? "\u25CF " : "\u25CB ") + label;
  }

  private cleanupPiListener(): void {
    if (this.piCleanup) {
      this.piCleanup();
      this.piCleanup = null;
    }
  }

  get summary(): string | null { return this._tabSummary; }

  postMessage(message: ExtensionToWebview | WebviewToExtension): void {
    // ── Layer 1: Validate extension→webview messages before posting ──
    // The reverse direction (webview→extension) is validated warn-only on receipt
    // in onDidReceiveMessage. Here we validate extension→webview to catch malformed
    // events early, skipping the webview→extension command types that also flow
    // through this typed method but belong to the other schema.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msgType = (message as any).type;
    if (msgType && msgType !== "prompt" && msgType !== "abort" && msgType !== "slashCommand" &&
        msgType !== "pickModel" && msgType !== "pickThinkingLevel" &&
        msgType !== "pickContextBudget" && msgType !== "getSettings" && msgType !== "toggleAutoCompaction" &&
        msgType !== "toggleAutoRetry" && msgType !== "toggleShowImages" && msgType !== "openUrl" &&
        msgType !== "openFile" && msgType !== "promoteToSteer" && msgType !== "clearQueue" &&
        msgType !== "resendUserMessage") {
      const result = validateExtensionToWebview(message);
      if (!result.success) {
        piWarn(`postMessage validation failed for type "${msgType}": ${result.error}`);
      }
    }
    this.panel?.webview.postMessage(message);
  }

  /** Insert a command or file reference into the chat input */
  postCommand(command: string): void {
    this.panel?.webview.postMessage({ type: "insertCommand", command });
  }

  /** Handle a locally-intercepted slash command (not sent to LLM) */
  private async handleSlashCommand(command: string): Promise<void> {
    switch (command) {
      case "login":
        await this.piService.login();
        break;
      case "logout":
        await this.piService.logout();
        break;
      case "model":
        await this.triggerModelPicker();
        break;
      case "thinking":
        await this.triggerThinkingPicker();
        break;
      case "sessions":
        await vscode.commands.executeCommand("pi-code-gui.sessions.focus");
        break;
      case "settings":
        await this.triggerSettingsPicker();
        break;
      case "tools":
        // Extension-serviced (SDK only). pickActiveTools opens the picker on TS and shows the
        // honest "not available on Rust" message on Rust — instead of the raw /tools text
        // leaking to the Rust binary as a prompt.
        await this.piService.pickActiveTools();
        break;
      default:
        // The TypeScript SDK parses slash commands out of forwarded prompt text
        // (and extension command handlers like /tldr respond), so the path below
        // is correct for TypeScript and is intentionally left UNCHANGED. The Rust
        // RPC does NOT parse slash commands — "/compact" would just be sent to the
        // model — so route Rust's built-in session commands to real actions first.
        if (this.piService.runtime === "rust" && await this.handleRustSlashCommand(command)) {
          break;
        }
        // Forward to pi session so extension command handlers (e.g. /tldr) can respond
        try {
          await this.piService.sendPrompt(`/${command}`);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
        } catch (e: any) {
          this.postMessage({
            type: "error",
            data: { message: e.message ?? String(e) },
          });
        }
        break;
    }
  }

  /**
   * Route built-in session commands to real actions under the **Rust** runtime,
   * whose RPC `prompt` does not parse slash commands. Returns true if handled.
   * Only invoked for Rust sessions — the TypeScript dispatch is untouched.
   * Commands not listed here fall through to the normal forward (e.g. a Rust
   * extension command). GUI-only actions (resume/fork/export) aren't offered to
   * Rust in the first place (see PiService.getAllSlashCommands).
   */
  private async handleRustSlashCommand(command: string): Promise<boolean> {
    switch (command) {
      case "new":
      case "clear":
        await this.piService.newSession();
        return true;
      case "compact":
        await this.piService.compact();
        return true;
      default:
        return false;
    }
  }

  private getNonce(): string {
    let text = "";
    const possible = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    for (let i = 0; i < 32; i++) {
      text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
  }

  private getWebviewContent(webview: vscode.Webview): string {
    const nonce = this.getNonce();
    const bundleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "bundle.js"),
    );
    const styleUri = webview.asWebviewUri(
      vscode.Uri.joinPath(this.context.extensionUri, "media", "style.css"),
    );

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src ${webview.cspSource} blob: data:;">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Pi Code Gui</title>
  <link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <div id="chat-container">
    <div id="welcome" class="welcome-message">
      <h2>Pi coding agent</h2>
    </div>
  </div>

  <div id="live-panel"></div>

  <div id="attachment-bar"></div>

  <div id="input-area">
    <textarea id="prompt-input" placeholder="Ask pi to do something..." rows="1" disabled></textarea>
    <div id="steer-split">
      <button id="send-button" disabled title="Submit (Enter)">↵</button>
      <button id="steer-dropdown" class="hidden" title="Switch to Queue">▾</button>
    </div>
    <button id="abort-button" class="hidden">■ Stop</button>
  </div>

  <div id="pi-status-bar">
    <span id="pi-sb-dot" style="flex-shrink:0; font-weight:700;">○</span>
    <div class="pi-sb-item pi-sb-runtime--ts" id="pi-sb-runtime" title="Runtime for this session — click to start a session on the other runtime">π TS</div>
    <div class="pi-sb-item" id="pi-sb-model" title="Click to change model">π Pi</div>
    <div class="pi-sb-item" id="pi-sb-thinking" title="Click to change thinking &amp; reasoning">thinking: off</div>
    <div id="pi-extension-status" class="pi-sb-item"></div>
    <div class="pi-sb-item spacer"></div>
    <div class="pi-sb-item" id="pi-sb-usage" title="Click to set context budget">0%</div>
    <div class="pi-sb-item" id="pi-sb-settings" title="Settings">⚙</div>
  </div>
  </div>

  <div class="user-msg-selector-overlay" id="user-msg-overlay"></div>
  <div class="settings-overlay" id="settings-overlay"></div>
  <div class="slash-autocomplete" id="slash-autocomplete"></div>

    <script nonce="${nonce}" src="${bundleUri}"></script>
</body>
</html>`;
  }

  /** Open VS Code quick pick to pick a model for the current session */
  private async triggerModelPicker(): Promise<void> {
    await this.piService.pickModel();
  }

  /** Open VS Code quick pick to pick thinking level */
  private async triggerThinkingPicker(): Promise<void> {
    await this.piService.pickThinkingLevel();
  }

  /** Open VS Code quick pick to set context budget */
  async triggerContextBudgetPicker(): Promise<void> {
    const ps = this.piService;
    const current = ps.getContextBudget();
    const budgets = [
      { label: "Model default", value: 0, description: "Use the model's built-in context window" },
      { label: "100K tokens", value: 100000, description: "Compact at ~0.1M" },
      { label: "200K tokens", value: 200000, description: "Compact at ~0.2M" },
      { label: "500K tokens", value: 500000, description: "Compact at ~0.5M" },
      { label: "1M tokens", value: 1000000, description: "Compact at ~1M" },
    ];
    const items = budgets.map((b) => ({
      label: `${b.label}${b.value === current ? " $(check)" : ""}`,
      description: b.description,
      value: b.value,
    }));
    const picked = await vscode.window.showQuickPick(items,
      { placeHolder: "Select per-session token budget. Takes effect on next session." },
    );
    if (!picked) { return; }
    await ps.setContextBudget(picked.value);
    vscode.window.showInformationMessage(
      picked.value === 0
        ? "Context budget: model default. Restart session to apply."
        : `Context budget set to ${formatBudget(picked.value)}. Restart session to apply.`,
    );
  }

  /** Open VS Code quick pick for settings */
  private async triggerSettingsPicker(): Promise<void> {
    const ps = this.piService;
    const makeToggleLabel = (name: string, on: boolean): string =>
      `${on ? "$(check)" : "$(circle-outline)"} ${name}`;

    const items: vscode.QuickPickItem[] = [
      {
        label: makeToggleLabel("Auto-compaction", ps.autoCompactionEnabled),
        description: "Automatically compact context when limit is hit",
      },
      {
        label: makeToggleLabel("Auto-retry", ps.autoRetryEnabled),
        description: "Automatically retry on recoverable errors",
      },
      {
        label: makeToggleLabel("Show images", ps.showImages),
        description: "Display image attachments in chat",
      },
      {
        label: "$(graph) Context budget",
        description: `Current: ${ps.getContextBudget() === 0 ? "model default" : formatBudget(ps.getContextBudget())}`,
      },
    ];

    const picked = await vscode.window.showQuickPick(items, {
      placeHolder: "Pi settings — select to toggle or change",
    });
    if (!picked) { return; }

    if (picked.label.includes("Auto-compaction")) {
      await ps.toggleAutoCompaction();
    } else if (picked.label.includes("Auto-retry")) {
      await ps.toggleAutoRetry();
    } else if (picked.label.includes("Show images")) {
      await ps.toggleShowImages();
    } else if (picked.label.includes("Context budget")) {
      await this.triggerContextBudgetPicker();
    }
  }

  dispose(): void {
    this.cleanupPiListener();
    this.disposables.forEach((d) => d.dispose());
    this.panel?.dispose();
  }
}

function formatBudget(tokens: number): string {
  if (tokens < 1000) { return tokens.toString(); }
  if (tokens < 1000000) { return (tokens / 1000).toFixed(0) + "K"; }
  return (tokens / 1000000).toFixed(1) + "M";
}
