import type * as vscode from "vscode";

export interface PiSidebarSession {
  id: string;
  title: string;
  meta: string;
  active: boolean;
  streaming: boolean;
  kind: "open" | "past";
  path?: string;
}

export interface PiSidebarState {
  sessions: PiSidebarSession[];
}

interface PiSidebarActions {
  getState: () => PiSidebarState;
  createSession: () => void;
  focusSession: (sessionId: string) => void;
  resumeSession: (path: string) => void;
}

export class PiSessionSidebarProvider implements vscode.WebviewViewProvider {
  private view: vscode.WebviewView | undefined;

  constructor(private readonly actions: PiSidebarActions) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = { enableScripts: true };
    view.webview.html = this.getHtml(view.webview);

    view.webview.onDidReceiveMessage((message: unknown) => {
      if (!message || typeof message !== "object") { return; }
      const payload = message as Record<string, unknown>;
      if (payload.type === "ready") {
        this.refresh();
        return;
      }
      if (payload.type === "new") {
        this.actions.createSession();
        return;
      }
      if (payload.type !== "open" || typeof payload.kind !== "string") { return; }
      if (payload.kind === "open" && typeof payload.id === "string") {
        this.actions.focusSession(payload.id);
      } else if (payload.kind === "past" && typeof payload.path === "string") {
        this.actions.resumeSession(payload.path);
      }
    });
  }

  refresh(): void {
    void this.view?.webview.postMessage({
      type: "state",
      state: this.actions.getState(),
    });
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = getNonce();
    return /* html */ `<!doctype html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy"
        content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}';">
  <style nonce="${nonce}">
    :root {
      color-scheme: dark;
      --pi-bg: #0b0c0e;
      --pi-panel: #0e1012;
      --pi-active: #14171a;
      --pi-border: #2b2f35;
      --pi-text: #e7e1d5;
      --pi-muted: #71808a;
      --pi-lavender: #b9a6ff;
    }

    * { box-sizing: border-box; }

    html,
    body {
      width: 100%;
      min-height: 100%;
      margin: 0;
      padding: 0;
      overflow-x: hidden;
      background: var(--pi-bg);
      color: var(--pi-text);
      font-family: var(--vscode-editor-font-family, "SFMono-Regular", Consolas, "Liberation Mono", monospace);
      font-size: 12px;
    }

    button {
      color: inherit;
      font: inherit;
    }

    .sidebar {
      min-height: 100vh;
      background: var(--pi-bg);
      border-right: 1px solid var(--pi-border);
    }

    .brand {
      height: 40px;
      display: flex;
      align-items: center;
      gap: 9px;
      padding: 0 14px;
      border-bottom: 1px solid var(--pi-border);
      background: #090a0c;
    }

    .pi-mark {
      width: 19px;
      height: 19px;
      display: grid;
      place-items: center;
      flex: 0 0 19px;
      border: 1px solid var(--pi-lavender);
      color: var(--pi-lavender);
      font-weight: 700;
      font-size: 11px;
      line-height: 1;
    }

    .wordmark {
      min-width: 0;
      color: #fff9ea;
      font-weight: 700;
      letter-spacing: .01em;
      white-space: nowrap;
    }

    .new-session {
      margin-left: auto;
      padding: 4px 0 4px 10px;
      border: 0;
      background: transparent;
      color: #d8d2c7;
      cursor: pointer;
      white-space: nowrap;
    }

    .new-session:hover,
    .new-session:focus-visible {
      color: #fff;
      outline: none;
    }

    .section-title {
      height: 42px;
      display: flex;
      align-items: center;
      padding: 5px 15px 0;
      color: #697984;
      font-size: 9px;
      letter-spacing: .18em;
      text-transform: uppercase;
    }

    .session-list {
      padding: 0 7px 12px;
    }

    .session-row {
      position: relative;
      width: 100%;
      height: 35px;
      display: grid;
      grid-template-columns: 13px minmax(0, 1fr) auto;
      align-items: center;
      gap: 0;
      padding: 0 7px 0 10px;
      border: 0;
      border-left: 1px solid transparent;
      background: transparent;
      color: #d8d2c7;
      text-align: left;
      cursor: pointer;
    }

    .session-row:hover {
      background: #111416;
      color: #fff9ea;
    }

    .session-row.active {
      border-left-color: var(--pi-lavender);
      background: var(--pi-active);
      color: #fff9ea;
      font-weight: 700;
    }

    .session-row:focus-visible {
      outline: 1px solid var(--pi-lavender);
      outline-offset: -1px;
    }

    .chevron {
      color: var(--pi-lavender);
      font-weight: 700;
      opacity: 0;
    }

    .session-row.active .chevron {
      opacity: 1;
    }

    .title {
      min-width: 0;
      padding-right: 8px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .meta {
      color: var(--pi-muted);
      font-size: 10px;
      font-weight: 400;
      white-space: nowrap;
    }

    .streaming-dot {
      width: 5px;
      height: 5px;
      margin-right: 6px;
      display: inline-block;
      background: #83c092;
      vertical-align: 1px;
    }

    .empty {
      padding: 7px 25px;
      color: var(--pi-muted);
      line-height: 1.7;
    }
  </style>
</head>
<body>
  <main class="sidebar">
    <header class="brand">
      <span class="pi-mark">π</span>
      <span class="wordmark">pi / web</span>
      <button class="new-session" id="new-session" type="button" aria-label="New Pi session">+ new</button>
    </header>
    <section aria-labelledby="sessions-heading">
      <div class="section-title" id="sessions-heading">sessions</div>
      <div class="session-list" id="session-list"></div>
    </section>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const sessionList = document.getElementById("session-list");

    document.getElementById("new-session").addEventListener("click", () => {
      vscode.postMessage({ type: "new" });
    });

    function render(state) {
      sessionList.replaceChildren();
      const sessions = Array.isArray(state?.sessions) ? state.sessions : [];
      if (sessions.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = "No sessions yet. Select + new to start.";
        sessionList.appendChild(empty);
        return;
      }

      for (const session of sessions) {
        const row = document.createElement("button");
        row.type = "button";
        row.className = "session-row" + (session.active ? " active" : "");
        row.title = session.title;
        row.setAttribute("aria-current", session.active ? "true" : "false");

        const chevron = document.createElement("span");
        chevron.className = "chevron";
        chevron.textContent = "›";

        const title = document.createElement("span");
        title.className = "title";
        if (session.streaming) {
          const dot = document.createElement("span");
          dot.className = "streaming-dot";
          title.appendChild(dot);
        }
        title.appendChild(document.createTextNode(session.title));

        const meta = document.createElement("span");
        meta.className = "meta";
        meta.textContent = session.meta || "";

        row.append(chevron, title, meta);
        row.addEventListener("click", () => {
          vscode.postMessage({
            type: "open",
            kind: session.kind,
            id: session.id,
            path: session.path,
          });
        });
        sessionList.appendChild(row);
      }
    }

    window.addEventListener("message", (event) => {
      if (event.data?.type === "state") {
        render(event.data.state);
      }
    });

    vscode.postMessage({ type: "ready" });
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let value = "";
  for (let i = 0; i < 32; i += 1) {
    value += alphabet.charAt(Math.floor(Math.random() * alphabet.length));
  }
  return value;
}
