import * as path from "node:path";
import * as vscode from "vscode";
import { appendEditorContext, truncateUtf8, type PromptEditorContext } from "./editor-context.js";
import { piError } from "./logger.js";
import type { PiService } from "./pi-service.js";
import type { PiServiceEvent } from "./types.js";
import {
  validateExtensionToWebview,
  type EditorContextItem,
  type WorkspaceFileItem,
  type WebviewToExtension,
  type ExtensionToWebview,
} from "./shared/protocol.js";

export type PanelDisposeCallback = (piService: PiService) => void;

export interface ExtensionPanelItem {
  name: string;
  path: string;
  enabled: boolean;
  source: string;
  scope: "user" | "project" | "temporary";
  origin: "package" | "top-level";
}

export interface ExtensionPanelActions {
  list: () => Promise<ExtensionPanelItem[]>;
  setEnabled: (extensionPath: string, enabled: boolean) => Promise<void>;
}

export class PiWebviewPanel {
  private panel: vscode.WebviewPanel | null = null;
  private piService: PiService;
  private disposables: vscode.Disposable[] = [];
  /** Cleanup function returned by piService.onEvent() */
  private piCleanup: (() => void) | null = null;
  private lastActiveTextEditorId = vscode.window.activeTextEditor?.document.uri.toString();
  private editorContextUpdateTimer: ReturnType<typeof setTimeout> | null = null;
  private workspaceFileCache: { loadedAt: number; items: WorkspaceFileItem[] } | null = null;

  // Tab indicator state
  private _tabInitialized = false;
  private _tabStreaming = false;
  private _tabSummary: string | null = null;

  /** Callback invoked when the panel is disposed (VS Code tab closed) */
  private _onDispose: PanelDisposeCallback | null = null;

  constructor(
    private context: vscode.ExtensionContext,
    piService: PiService,
    private readonly extensionPanelActions: ExtensionPanelActions,
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

    // Use a unique viewType per webview to prevent VS Code from restoring
    // stale webviews that reference old extension versions. The randomId is
    // regenerated on every createWebviewPanel call.
    var randomId = Math.random().toString(36).slice(2, 8);
    this.panel = vscode.window.createWebviewPanel(
      "pi-chat-" + randomId,
      "Pi on Code",
      vscode.ViewColumn.Two,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(this.context.extensionUri, "media"),
        ],
      }
    );

    this.panel.iconPath = {
      light: vscode.Uri.joinPath(this.context.extensionUri, "media", "pi-icon-light.svg"),
      dark: vscode.Uri.joinPath(this.context.extensionUri, "media", "pi-icon-dark.svg"),
    };

    this.panel.webview.html = this.getWebviewContent(this.panel.webview);
    this.setupWebviewHandlers();
    this.setupEditorContextTracking();
    this.setupServiceHandlers();
    this.piService.emitLoadedExtensions();

    this.panel.onDidChangeViewState((e) => {
      if (e.webviewPanel.active && this._onActivateCb) {
        this._onActivateCb();
      }
    });

    this.panel.onDidDispose(() => {
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

  private getVisibleEditorContextItems(): EditorContextItem[] {
    if (!this.piService.autoAttachActiveEditor) { return []; }
    const visibleEditors = vscode.window.visibleTextEditors;
    const visibleIds = new Set(visibleEditors.map((editor) => editor.document.uri.toString()));
    const currentActiveId = vscode.window.activeTextEditor?.document.uri.toString();
    if (currentActiveId && visibleIds.has(currentActiveId)) {
      this.lastActiveTextEditorId = currentActiveId;
    }
    if (!this.lastActiveTextEditorId || !visibleIds.has(this.lastActiveTextEditorId)) {
      this.lastActiveTextEditorId = visibleEditors[0]?.document.uri.toString();
    }

    const seen = new Set<string>();
    const items: EditorContextItem[] = [];
    for (const editor of visibleEditors) {
      const document = editor.document;
      const id = document.uri.toString();
      if (seen.has(id)) { continue; }
      seen.add(id);

      const displayPath = document.isUntitled
        ? document.fileName
        : vscode.workspace.asRelativePath(document.uri, false);
      const active = id === this.lastActiveTextEditorId;
      const selection = active ? editor.selection : undefined;
      items.push({
        id,
        path: displayPath,
        name: path.basename(document.fileName || displayPath),
        languageId: document.languageId,
        active,
        dirty: document.isDirty,
        selectionLines: selection && !selection.isEmpty
          ? selection.end.line - selection.start.line + 1
          : undefined,
      });
    }
    return items;
  }

  private async capturePromptEditorContext(
    includedEditorIds: string[],
    attachedFileIds: string[],
  ): Promise<PromptEditorContext | undefined> {
    const included = new Set(includedEditorIds);
    const items = this.getVisibleEditorContextItems().filter((item) => included.has(item.id));
    const activeItem = items.find((item) => item.active);
    const activeEditor = activeItem
      ? vscode.window.visibleTextEditors.find(
          (editor) => editor.document.uri.toString() === activeItem.id,
        )
      : undefined;

    let activeDocument: PromptEditorContext["activeDocument"];
    if (activeItem && activeEditor) {
      const selection = activeEditor.selection;
      const source = selection.isEmpty ? "document" : "selection";
      const rawContent = selection.isEmpty
        ? activeEditor.document.getText()
        : activeEditor.document.getText(selection);
      const content = truncateUtf8(rawContent, 32 * 1024);
      activeDocument = {
        id: activeItem.id,
        path: activeItem.path,
        languageId: activeItem.languageId,
        source,
        content: content.text,
        truncated: content.truncated,
      };
    }

    const attachedDocuments: NonNullable<PromptEditorContext["attachedDocuments"]> = [];
    for (const id of new Set(attachedFileIds)) {
      let uri: vscode.Uri;
      try {
        uri = vscode.Uri.parse(id);
      } catch {
        continue;
      }
      if (!vscode.workspace.getWorkspaceFolder(uri)) { continue; }

      let document = vscode.workspace.textDocuments.find(
        (candidate) => candidate.uri.toString() === id,
      );
      try {
        document ??= await vscode.workspace.openTextDocument(uri);
      } catch {
        continue;
      }

      const displayPath = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
      let rawContent = document.getText();
      let binary = false;
      if (rawContent.includes("\0")) {
        rawContent = "[Binary file content omitted]";
        binary = true;
      }
      const content = truncateUtf8(rawContent, 32 * 1024);
      const existing = items.find((item) => item.id === id);
      if (existing) {
        existing.attached = true;
      } else {
        items.push({
          id,
          path: displayPath,
          name: path.basename(document.fileName || displayPath),
          languageId: document.languageId,
          active: false,
          dirty: document.isDirty,
          attached: true,
        });
      }

      const documentContext = {
        id,
        path: displayPath,
        languageId: document.languageId,
        source: "document" as const,
        content: content.text,
        truncated: content.truncated || binary,
      };
      if (activeItem?.id === id) {
        activeDocument = documentContext;
      } else {
        attachedDocuments.push(documentContext);
      }
    }

    if (items.length === 0) { return undefined; }
    return {
      items,
      activeDocument,
      attachedDocuments: attachedDocuments.length > 0 ? attachedDocuments : undefined,
    };
  }

  private async postWorkspaceFiles(query: string): Promise<void> {
    const now = Date.now();
    if (!this.workspaceFileCache || now - this.workspaceFileCache.loadedAt > 5000) {
      const uris = await vscode.workspace.findFiles(
        "**/*",
        "**/{node_modules,.git,dist,out,artifacts,.vscode-test}/**",
        2000,
      );
      this.workspaceFileCache = {
        loadedAt: now,
        items: uris.map((uri) => {
          const displayPath = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
          return {
            id: uri.toString(),
            path: displayPath,
            name: path.basename(displayPath),
          };
        }),
      };
    }

    const normalized = query.trim().toLowerCase();
    const items = this.workspaceFileCache.items
      .filter((item) => !normalized || item.path.toLowerCase().includes(normalized))
      .sort((left, right) => {
        const leftName = left.name.toLowerCase();
        const rightName = right.name.toLowerCase();
        const leftStarts = leftName.startsWith(normalized) ? 0 : 1;
        const rightStarts = rightName.startsWith(normalized) ? 0 : 1;
        return leftStarts - rightStarts || left.path.localeCompare(right.path);
      })
      .slice(0, 50);

    this.postMessage({
      type: "workspace-files-update",
      data: { query, items },
    });
  }

  private postEditorContext(): void {
    this.postMessage({
      type: "editor-context-update",
      data: { items: this.getVisibleEditorContextItems() },
    });
  }

  private setupEditorContextTracking(): void {
    const scheduleUpdate = (): void => {
      if (this.editorContextUpdateTimer) { clearTimeout(this.editorContextUpdateTimer); }
      this.editorContextUpdateTimer = setTimeout(() => {
        this.editorContextUpdateTimer = null;
        this.postEditorContext();
      }, 75);
    };

    this.disposables.push(
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        if (editor) { this.lastActiveTextEditorId = editor.document.uri.toString(); }
        scheduleUpdate();
      }),
      vscode.window.onDidChangeVisibleTextEditors(scheduleUpdate),
      vscode.window.onDidChangeTextEditorSelection((event) => {
        if (event.textEditor.document.uri.toString() === this.lastActiveTextEditorId) {
          scheduleUpdate();
        }
      }),
      vscode.workspace.onDidChangeTextDocument((event) => {
        const changedId = event.document.uri.toString();
        if (vscode.window.visibleTextEditors.some(
          (editor) => editor.document.uri.toString() === changedId,
        )) {
          scheduleUpdate();
        }
      }),
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (event.affectsConfiguration("pi-on-code.autoAttachActiveEditor")) {
          scheduleUpdate();
          this.piService.emitSettings();
        }
      }),
      { dispose: () => {
        if (this.editorContextUpdateTimer) {
          clearTimeout(this.editorContextUpdateTimer);
          this.editorContextUpdateTimer = null;
        }
      } },
    );
  }

  private setupWebviewHandlers(): void {
    if (!this.panel) {
      piError("setupWebviewHandlers called with no panel — webview messages will be lost");
      return;
    }

    // Proactively send status every 500ms until pi is ready
    // This avoids the webview-to-extension 'ready' handshake entirely
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    let statusInterval: any = null;
    const startPolling = (): void => {
      if (statusInterval) {return;}
      statusInterval = setInterval(() => {
        const model = this.piService.model;
        this.postMessage({
          type: "status",
          data: {
            model: model?.id ?? "loading...",
            thinkingLevel: this.piService.thinkingLevel,
            effort: this.piService.effort,
            ready: model !== null,
          },
        });
        if (model !== null && statusInterval) {
          clearInterval(statusInterval);
          statusInterval = null;
          this._tabInitialized = true;
          this.piService.emitLoadedExtensions();
          this.updateTabIndicator();
        }
      }, 500);
    };
    startPolling();
    this.disposables.push({ dispose: () => { if (statusInterval) {clearInterval(statusInterval);} } });

    this.panel.webview.onDidReceiveMessage(
      async (message) => {
        switch (message.type) {
          case "prompt": {
              const msg = message;
              const editorContext = !msg.mode && !msg.text.startsWith("/")
                ? await this.capturePromptEditorContext(
                    msg.editorContext?.includedEditorIds ?? [],
                    msg.editorContext?.attachedFileIds ?? [],
                  )
                : undefined;
              const promptText = editorContext
                ? appendEditorContext(msg.text, editorContext)
                : msg.text;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
              this.piService.sendPrompt(promptText, msg.images, msg.mode).catch((error: any) => {
                let errMsg = error.message ?? String(error);
                if (/api.?key|login|authenticate|provider/i.test(errMsg)) {
                  errMsg += "\n\n[Set up an API key →](https://pi.dev/docs/latest/quickstart)";
                }
                this.postMessage({ type: "error", data: { message: errMsg } });
              });
            }
            break;

          case "requestEditorContext":
            this.postEditorContext();
            break;

          case "requestWorkspaceFiles":
            await this.postWorkspaceFiles(message.query);
            break;

          case "abort":
            await this.piService.abort();
            break;

          case "cycleModel":
            await this.piService.cycleModel();
            break;

          case "setThinkingLevel":
            await this.piService.setThinkingLevel(message.level);
            break;

          case "setEffort":
            await this.piService.setEffort(message.effort);
            break;

          case "pickModel":
            void this.triggerModelPicker();
            break;

          case "pickThinkingLevel":
            void this.triggerThinkingPicker();
            break;

          case "pickEffort":
            void this.triggerEffortPicker();
            break;

          case "getExtensions":
            void this.postExtensionsPanelState();
            break;

          case "reloadExtensions":
            void this.triggerExtensionsReload();
            break;

          case "setExtensionEnabled":
            void this.triggerExtensionToggle(message.path, message.enabled);
            break;

          case "openUrl":
            vscode.env.openExternal(vscode.Uri.parse(message.url));
            break;

          case "openFile":
            vscode.window.showTextDocument(vscode.Uri.file(message.path));
            break;

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

          case "toggleAutoAttachActiveEditor":
            await this.piService.toggleAutoAttachActiveEditor();
            break;

          // Request user messages list (#2)
          case "getUserMessages":
            this.postMessage({
              type: "user-messages-list",
              data: { messages: this.piService.userMessages.slice(-20) },
            });
            break;

          // Request settings state (#3)
          case "getSettings":
            this.piService.emitSettings();
            this.piService.emitScopedModels();
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

          case "replaceFollowUpQueue":
            try {
              await this.piService.replaceFollowUpQueue(message.messages);
            } catch (error: unknown) {
              this.postMessage({
                type: "error",
                data: { message: `Could not update follow-ups: ${error instanceof Error ? error.message : String(error)}` },
              });
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
      this.panel.title = "Pi on Code";
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
    // Webview-to-extension messages are validated on receipt by the extension host.
    // For extension→webview, we validate here to catch malformed events early.
    // We check if "type" is an extension→webview type (has data or is command).
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    const msgType = (message as any).type;
    if (msgType && msgType !== "prompt" && msgType !== "abort" && msgType !== "slashCommand" &&
        msgType !== "pickModel" && msgType !== "pickThinkingLevel" && msgType !== "pickEffort" &&
        msgType !== "pickContextBudget" && msgType !== "getSettings" && msgType !== "toggleAutoCompaction" &&
        msgType !== "toggleAutoRetry" && msgType !== "toggleShowImages" &&
        msgType !== "toggleAutoAttachActiveEditor" && msgType !== "openUrl" &&
        msgType !== "openFile" && msgType !== "promoteToSteer" && msgType !== "replaceFollowUpQueue" && msgType !== "clearQueue" &&
        msgType !== "resendUserMessage") {
      const result = validateExtensionToWebview(message);
      if (!result.success) {
        piError(`postMessage validation failed for type "${msgType}": ${result.error}`);
      }
    }
    this.panel?.webview.postMessage(message);
  }

  /** Insert a command or file reference into the chat input */
  postCommand(command: string): void {
    this.panel?.webview.postMessage({ type: "insertCommand", command });
  }

  async attachWorkspaceFile(uri: vscode.Uri): Promise<void> {
    if (!vscode.workspace.getWorkspaceFolder(uri)) { return; }
    await this.show();
    const displayPath = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
    this.postMessage({
      type: "attach-workspace-file",
      data: {
        id: uri.toString(),
        path: displayPath,
        name: path.basename(displayPath),
      },
    });
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
        await vscode.commands.executeCommand("pi-on-code.sessions.focus");
        break;
      case "settings":
        await this.triggerSettingsPicker();
        break;
      default:
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
  <title>Pi on Code</title>
  <link rel="stylesheet" href="${styleUri}">
</head>
<body>
  <div id="pi-web-app">
  <div id="chat-container">
    <div id="welcome" class="welcome-message">
      <div class="welcome-kicker">Pi-native agent workspace</div>
      <h2>Pi on Code</h2>
      <p>Use Pi inside the editor without losing the clarity of its terminal UI.</p>
    </div>
  </div>

  <div id="live-panel"></div>

  <div id="attachment-bar"></div>

  <div id="input-area">
    <textarea id="prompt-input" placeholder="Ask pi to do something..." title="Enter: send · Shift+Enter: newline · Alt+Enter: follow-up while running" rows="1" disabled></textarea>
    <div id="steer-split">
      <button id="send-button" disabled title="Submit (Enter)">↵</button>
      <button id="steer-dropdown" class="hidden" title="Switch to Follow-up">▾</button>
    </div>
    <button id="abort-button" class="hidden">■ Stop</button>
  </div>

  <div id="pi-status-bar">
    <span id="pi-sb-dot" style="flex-shrink:0; font-weight:700;">○</span>
    <div class="pi-sb-item" id="pi-sb-model" title="Click to change model">π Pi</div>
    <div class="pi-sb-item" id="pi-sb-thinking" title="Click to change thinking level">thinking: off</div>
    <div class="pi-sb-item" id="pi-sb-effort" title="Click to change effort">effort: auto</div>
    <div id="pi-extension-status" class="pi-sb-item"></div>
    <span class="pi-sb-hint" id="pi-sb-follow-up-hint" title="Queue a follow-up while Pi is working" hidden>Alt+Enter follow-up</span>
    <div class="pi-sb-item spacer"></div>
    <div class="pi-sb-item" id="pi-sb-extensions" title="Manage extensions for this session">extensions: 0</div>
    <div class="pi-sb-item" id="pi-sb-usage" title="Click to set context budget">0%</div>
    <div class="pi-sb-item" id="pi-sb-settings" title="Settings">⚙</div>
  </div>
  </div>

  <div class="user-msg-selector-overlay" id="user-msg-overlay"></div>
  <div class="settings-overlay" id="settings-overlay"></div>
  <div class="extensions-overlay" id="extensions-overlay"></div>
  <div class="slash-autocomplete" id="slash-autocomplete"></div>
  <div class="file-autocomplete" id="file-autocomplete"></div>

    <script nonce="${nonce}" src="${bundleUri}"></script>
</body>
</html>`;
  }

  /** Push extension resources and their enabled state into the custom panel. */
  private async postExtensionsPanelState(): Promise<void> {
    this.postMessage({ type: "extensions-panel-update", data: { extensions: [], loading: true } });
    try {
      const extensions = await this.extensionPanelActions.list();
      this.postMessage({ type: "extensions-panel-update", data: { extensions } });
    } catch (error: unknown) {
      this.postMessage({
        type: "extensions-panel-update",
        data: {
          extensions: [],
          error: error instanceof Error ? error.message : String(error),
        },
      });
    }
  }

  /** Reload extension runtime state without replaying conversation history. */
  private async triggerExtensionsReload(): Promise<void> {
    this.postMessage({ type: "extensions-panel-update", data: { extensions: [], loading: true } });
    try {
      await this.piService.reloadExtensions();
      await this.postExtensionsPanelState();
    } catch (error: unknown) {
      this.postMessage({
        type: "extensions-panel-update",
        data: {
          extensions: [],
          error: `Reload failed: ${error instanceof Error ? error.message : String(error)}`,
        },
      });
    }
  }

  /** Persist one extension toggle, then reload the session to apply it. */
  private async triggerExtensionToggle(extensionPath: string, enabled: boolean): Promise<void> {
    this.postMessage({ type: "extensions-panel-update", data: { extensions: [], loading: true } });
    try {
      await this.extensionPanelActions.setEnabled(extensionPath, enabled);
      await this.piService.reloadExtensions();
      await this.postExtensionsPanelState();
    } catch (error: unknown) {
      this.postMessage({
        type: "extensions-panel-update",
        data: {
          extensions: [],
          error: `Could not ${enabled ? "enable" : "disable"} extension: ${error instanceof Error ? error.message : String(error)}`,
        },
      });
    }
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

  /** Open VS Code quick pick to pick effort */
  async triggerEffortPicker(): Promise<void> {
    const ps = this.piService;
    const levels = [
      { label: "auto", description: "Let the model decide" },
      { label: "none", description: "No effort" },
      { label: "low", description: "Low effort" },
      { label: "medium", description: "Medium effort" },
      { label: "high", description: "High effort" },
    ];
    const currentEffort = ps.effort || "auto";
    const items = levels.map((l) => ({
      label: `${l.label === currentEffort ? "$(check) " : ""}${l.label}`,
      description: l.description,
    }));
    const picked = await vscode.window.showQuickPick(items, { placeHolder: "Select effort level" });
    if (!picked) { return; }
    await ps.setEffort(picked.label);
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
        label: makeToggleLabel("Auto-attach active file", ps.autoAttachActiveEditor),
        description: "Attach the active editor or selection to new prompts",
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
    } else if (picked.label.includes("Auto-attach active file")) {
      await ps.toggleAutoAttachActiveEditor();
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
