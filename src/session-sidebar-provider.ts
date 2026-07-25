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

export interface PiSidebarPackage {
  source: string;
  name: string;
  description: string;
  version?: string;
  publisher?: string;
  license?: string;
  downloads?: number;
  scope?: "user" | "project";
  installed: boolean;
  updateAvailable: boolean;
  repository?: string;
  homepage?: string;
  imageUrl?: string;
  videoUrl?: string;
}

export interface PiSidebarPackages {
  ready: boolean;
  loading: boolean;
  error?: string;
  query: string;
  installed: PiSidebarPackage[];
  marketplace: PiSidebarPackage[];
}

export interface PiSidebarState {
  sessions: PiSidebarSession[];
  packages: PiSidebarPackages;
}

interface PiSidebarActions {
  getState: () => PiSidebarState;
  createSession: () => void;
  focusSession: (sessionId: string) => void;
  resumeSession: (path: string) => void;
  searchPackages: (query: string) => void | Promise<void>;
  refreshPackages: () => void | Promise<void>;
  installPackage: (source: string) => void | Promise<void>;
  uninstallPackage: (source: string, scope: "user" | "project") => void | Promise<void>;
  updatePackage: (source: string) => void | Promise<void>;
  openUrl: (url: string) => void;
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
      switch (payload.type) {
        case "ready":
          this.refresh();
          break;
        case "new":
          this.actions.createSession();
          break;
        case "open":
          if (payload.kind === "open" && typeof payload.id === "string") {
            this.actions.focusSession(payload.id);
          } else if (payload.kind === "past" && typeof payload.path === "string") {
            this.actions.resumeSession(payload.path);
          }
          break;
        case "package-search":
          if (typeof payload.query === "string") { void this.actions.searchPackages(payload.query); }
          break;
        case "package-refresh":
          void this.actions.refreshPackages();
          break;
        case "package-install":
          if (typeof payload.source === "string") { void this.actions.installPackage(payload.source); }
          break;
        case "package-uninstall":
          if (
            typeof payload.source === "string" &&
            (payload.scope === "user" || payload.scope === "project")
          ) {
            void this.actions.uninstallPackage(payload.source, payload.scope);
          }
          break;
        case "package-update":
          if (typeof payload.source === "string") { void this.actions.updatePackage(payload.source); }
          break;
        case "open-url":
          if (typeof payload.url === "string") { this.actions.openUrl(payload.url); }
          break;
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
        content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${nonce}'; script-src 'nonce-${nonce}'; img-src https: data:; media-src https:;">
  <style nonce="${nonce}">
    :root {
      color-scheme: dark;
      --pi-bg: #0b0c0e;
      --pi-panel: #0e1012;
      --pi-active: #14171a;
      --pi-border: #2b2f35;
      --pi-text: #e7e1d5;
      --pi-muted: #71808a;
      --pi-faint: #58636b;
      --pi-lavender: #b9a6ff;
      --pi-green: #83c092;
      --pi-red: #e67e80;
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
      font-family: var(--vscode-editor-font-family, "SFMono-Regular", Consolas, monospace);
      font-size: 12px;
    }

    button,
    input { color: inherit; font: inherit; }

    button:focus-visible,
    input:focus-visible {
      outline: 1px solid var(--pi-lavender);
      outline-offset: -1px;
    }

    .sidebar {
      min-height: 100vh;
      padding-bottom: 18px;
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

    .new-session,
    .icon-button {
      border: 0;
      background: transparent;
      color: #d8d2c7;
      cursor: pointer;
    }

    .new-session {
      margin-left: auto;
      padding: 4px 0 4px 10px;
      white-space: nowrap;
    }

    .new-session:hover,
    .icon-button:hover { color: #fff; }

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

    .session-list { padding: 0 7px 12px; }

    .session-row {
      position: relative;
      width: 100%;
      height: 35px;
      display: grid;
      grid-template-columns: 13px minmax(0, 1fr) auto;
      align-items: center;
      padding: 0 7px 0 10px;
      border: 0;
      border-left: 1px solid transparent;
      background: transparent;
      color: #d8d2c7;
      text-align: left;
      cursor: pointer;
    }

    .session-row:hover { background: #111416; color: #fff9ea; }
    .session-row.active {
      border-left-color: var(--pi-lavender);
      background: var(--pi-active);
      color: #fff9ea;
      font-weight: 700;
    }

    .chevron { color: var(--pi-lavender); font-weight: 700; opacity: 0; }
    .session-row.active .chevron { opacity: 1; }

    .title {
      min-width: 0;
      padding-right: 8px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    .meta { color: var(--pi-muted); font-size: 10px; font-weight: 400; white-space: nowrap; }
    .streaming-dot {
      width: 5px;
      height: 5px;
      margin-right: 6px;
      display: inline-block;
      background: var(--pi-green);
      vertical-align: 1px;
    }
    .empty { padding: 7px 25px; color: var(--pi-muted); line-height: 1.7; }

    .packages-section { border-top: 1px solid var(--pi-border); }
    .packages-heading {
      height: 42px;
      display: flex;
      align-items: center;
      padding: 0 8px 0 6px;
    }
    .packages-toggle {
      min-width: 0;
      flex: 1;
      display: flex;
      align-items: center;
      gap: 7px;
      padding: 8px;
      border: 0;
      background: transparent;
      color: #697984;
      font-size: 9px;
      letter-spacing: .18em;
      text-align: left;
      text-transform: uppercase;
      cursor: pointer;
    }
    .packages-caret { color: var(--pi-lavender); transform: rotate(0deg); transition: transform 120ms ease; }
    .packages-section.expanded .packages-caret { transform: rotate(90deg); }
    .packages-count { margin-left: auto; color: var(--pi-faint); letter-spacing: 0; }
    .packages-body { display: none; padding: 0 7px 12px; }
    .packages-section.expanded .packages-body { display: block; }

    .package-search {
      display: flex;
      margin: 0 5px 10px;
      border: 1px solid var(--pi-border);
      background: #090a0c;
    }
    .package-search input {
      min-width: 0;
      flex: 1;
      padding: 7px 8px;
      border: 0;
      outline: 0;
      background: transparent;
      color: var(--pi-text);
    }
    .package-search button,
    .package-action {
      padding: 5px 8px;
      border: 1px solid var(--pi-border);
      border-radius: 0;
      background: transparent;
      color: var(--pi-muted);
      cursor: pointer;
    }
    .package-search button { border-width: 0 0 0 1px; }
    .package-search button:hover,
    .package-action:hover { border-color: var(--pi-lavender); color: var(--pi-lavender); }

    .package-subtitle {
      padding: 8px 7px 5px;
      color: var(--pi-faint);
      font-size: 9px;
      letter-spacing: .14em;
      text-transform: uppercase;
    }
    .package-card {
      margin-bottom: 7px;
      padding: 9px;
      border: 1px solid var(--pi-border);
      border-left: 1px solid transparent;
      background: var(--pi-panel);
    }
    .package-card.installed { border-left-color: var(--pi-green); }
    .package-card-header { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
    .package-name {
      min-width: 0;
      flex: 1;
      overflow: hidden;
      color: #fff9ea;
      font-weight: 700;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .package-version { color: var(--pi-faint); font-size: 10px; }
    .package-description {
      display: -webkit-box;
      margin-top: 5px;
      overflow: hidden;
      color: var(--pi-muted);
      font-size: 11px;
      line-height: 1.45;
      -webkit-box-orient: vertical;
      -webkit-line-clamp: 2;
    }
    .package-preview {
      width: 100%;
      height: 112px;
      display: block;
      margin-top: 8px;
      overflow: hidden;
      padding: 0;
      border: 1px solid var(--pi-border);
      background: #070809;
      cursor: zoom-in;
    }
    .package-preview img,
    .package-preview video { width: 100%; height: 100%; display: block; object-fit: cover; }
    .package-info { margin-top: 7px; color: var(--pi-faint); font-size: 10px; }
    .package-actions { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 8px; }
    .package-action.primary { border-color: var(--pi-lavender); color: var(--pi-lavender); }
    .package-action.danger:hover { border-color: var(--pi-red); color: var(--pi-red); }
    .package-action:disabled { opacity: .45; cursor: default; }
    .package-error { padding: 8px; color: var(--pi-red); line-height: 1.5; }
    .package-gallery-link {
      width: 100%;
      margin-top: 5px;
      padding: 8px;
      border: 0;
      background: transparent;
      color: var(--pi-muted);
      text-align: left;
      cursor: pointer;
    }
    .package-gallery-link:hover { color: var(--pi-lavender); }

    .preview-overlay {
      position: fixed;
      z-index: 1000;
      inset: 0;
      display: grid;
      padding: 18px;
      place-items: center;
      background: rgb(0 0 0 / 88%);
    }
    .preview-overlay img,
    .preview-overlay video { max-width: 96vw; max-height: 88vh; object-fit: contain; }
    .preview-close {
      position: fixed;
      top: 10px;
      right: 12px;
      width: 30px;
      height: 30px;
      border: 1px solid var(--pi-border);
      background: var(--pi-panel);
      color: var(--pi-text);
      cursor: pointer;
    }
  </style>
</head>
<body>
  <main class="sidebar">
    <header class="brand">
      <span class="pi-mark">π</span>
      <span class="wordmark">pi / code</span>
      <button class="new-session" id="new-session" type="button" aria-label="New Pi session">+ new</button>
    </header>
    <section aria-labelledby="sessions-heading">
      <div class="section-title" id="sessions-heading">sessions</div>
      <div class="session-list" id="session-list"></div>
    </section>
    <section class="packages-section" id="packages-section" aria-labelledby="packages-heading">
      <div class="packages-heading">
        <button class="packages-toggle" id="packages-toggle" type="button" aria-expanded="false">
          <span class="packages-caret">›</span>
          <span id="packages-heading">packages</span>
          <span class="packages-count" id="packages-count"></span>
        </button>
        <button class="icon-button" id="packages-refresh" type="button" title="Refresh packages">↻</button>
      </div>
      <div class="packages-body" id="packages-body">
        <form class="package-search" id="package-search">
          <input id="package-query" type="search" placeholder="Search Pi packages..." aria-label="Search Pi packages">
          <button type="submit">search</button>
        </form>
        <div id="package-list"></div>
        <button class="package-gallery-link" id="package-gallery-link" type="button">browse pi.dev/packages ↗</button>
      </div>
    </section>
  </main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const savedUiState = vscode.getState() || {};
    const uiState = { packagesExpanded: savedUiState.packagesExpanded === true };
    const sessionList = document.getElementById("session-list");
    const packagesSection = document.getElementById("packages-section");
    const packagesToggle = document.getElementById("packages-toggle");
    const packagesCount = document.getElementById("packages-count");
    const packageList = document.getElementById("package-list");
    const packageQuery = document.getElementById("package-query");
    let currentState = null;
    let marketplaceRequested = false;

    function syncPackagesExpanded() {
      packagesSection.classList.toggle("expanded", uiState.packagesExpanded);
      packagesToggle.setAttribute("aria-expanded", String(uiState.packagesExpanded));
      vscode.setState(uiState);
    }

    document.getElementById("new-session").addEventListener("click", () => {
      vscode.postMessage({ type: "new" });
    });
    packagesToggle.addEventListener("click", () => {
      uiState.packagesExpanded = !uiState.packagesExpanded;
      syncPackagesExpanded();
      if (uiState.packagesExpanded) {
        marketplaceRequested = true;
        vscode.postMessage({ type: "package-refresh" });
      }
    });
    document.getElementById("packages-refresh").addEventListener("click", () => {
      vscode.postMessage({ type: "package-refresh" });
    });
    document.getElementById("package-search").addEventListener("submit", (event) => {
      event.preventDefault();
      marketplaceRequested = true;
      vscode.postMessage({ type: "package-search", query: packageQuery.value.trim() });
    });
    document.getElementById("package-gallery-link").addEventListener("click", () => {
      vscode.postMessage({ type: "open-url", url: "https://pi.dev/packages" });
    });

    function renderSessions(sessions) {
      sessionList.replaceChildren();
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
          vscode.postMessage({ type: "open", kind: session.kind, id: session.id, path: session.path });
        });
        sessionList.appendChild(row);
      }
    }

    function formatDownloads(value) {
      if (!value) return "";
      if (value >= 1000000) return (value / 1000000).toFixed(1) + "M/wk";
      if (value >= 1000) return (value / 1000).toFixed(1) + "K/wk";
      return value + "/wk";
    }

    function openPreview(pkg, video) {
      document.querySelector(".preview-overlay")?.remove();
      const overlay = document.createElement("div");
      overlay.className = "preview-overlay";
      const media = document.createElement(video ? "video" : "img");
      media.src = video ? pkg.videoUrl : pkg.imageUrl;
      if (video) {
        media.controls = true;
        media.autoplay = true;
      }
      const close = document.createElement("button");
      close.className = "preview-close";
      close.type = "button";
      close.textContent = "×";
      const remove = () => overlay.remove();
      close.addEventListener("click", remove);
      overlay.addEventListener("click", (event) => { if (event.target === overlay) remove(); });
      overlay.append(media, close);
      document.body.appendChild(overlay);
    }

    function actionButton(label, className, handler, disabled) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "package-action " + (className || "");
      button.textContent = label;
      button.disabled = disabled === true;
      button.addEventListener("click", handler);
      return button;
    }

    function createPackageCard(pkg, installedSection) {
      const card = document.createElement("article");
      card.className = "package-card" + (pkg.installed ? " installed" : "");
      const header = document.createElement("div");
      header.className = "package-card-header";
      const name = document.createElement("span");
      name.className = "package-name";
      name.textContent = pkg.name;
      const version = document.createElement("span");
      version.className = "package-version";
      version.textContent = pkg.version ? "v" + pkg.version : "";
      header.append(name, version);
      card.appendChild(header);

      if (pkg.description) {
        const description = document.createElement("div");
        description.className = "package-description";
        description.textContent = pkg.description;
        card.appendChild(description);
      }

      if (pkg.videoUrl || pkg.imageUrl) {
        const preview = document.createElement("button");
        preview.type = "button";
        preview.className = "package-preview";
        const isVideo = Boolean(pkg.videoUrl);
        const media = document.createElement(isVideo ? "video" : "img");
        media.src = isVideo ? pkg.videoUrl : pkg.imageUrl;
        media.setAttribute("aria-label", pkg.name + " preview");
        if (isVideo) {
          media.muted = true;
          media.loop = true;
          media.playsInline = true;
          media.preload = "metadata";
          preview.addEventListener("mouseenter", () => { media.play().catch(() => {}); });
          preview.addEventListener("mouseleave", () => { media.pause(); media.currentTime = 0; });
        }
        preview.appendChild(media);
        preview.addEventListener("click", () => openPreview(pkg, isVideo));
        card.appendChild(preview);
      }

      const infoParts = [];
      if (pkg.scope) infoParts.push(pkg.scope);
      if (pkg.publisher) infoParts.push("by " + pkg.publisher);
      if (pkg.license) infoParts.push(pkg.license);
      const downloads = formatDownloads(pkg.downloads);
      if (downloads) infoParts.push(downloads);
      if (infoParts.length > 0) {
        const info = document.createElement("div");
        info.className = "package-info";
        info.textContent = infoParts.join(" · ");
        card.appendChild(info);
      }

      const actions = document.createElement("div");
      actions.className = "package-actions";
      if (installedSection) {
        if (pkg.updateAvailable) {
          actions.appendChild(actionButton("update", "primary", () => {
            vscode.postMessage({ type: "package-update", source: pkg.source });
          }));
        }
        actions.appendChild(actionButton("remove", "danger", () => {
          vscode.postMessage({ type: "package-uninstall", source: pkg.source, scope: pkg.scope || "user" });
        }));
      } else {
        actions.appendChild(actionButton(pkg.installed ? "installed" : "install", "primary", () => {
          if (!pkg.installed) vscode.postMessage({ type: "package-install", source: pkg.source });
        }, pkg.installed));
      }
      const targetUrl = pkg.repository || pkg.homepage || (pkg.name ? "https://www.npmjs.com/package/" + pkg.name : "");
      if (targetUrl) {
        actions.appendChild(actionButton("open", "", () => {
          vscode.postMessage({ type: "open-url", url: targetUrl });
        }));
      }
      card.appendChild(actions);
      return card;
    }

    function appendPackageGroup(title, packages, installedSection) {
      if (packages.length === 0) return;
      const heading = document.createElement("div");
      heading.className = "package-subtitle";
      heading.textContent = title;
      packageList.appendChild(heading);
      packages.forEach((pkg) => packageList.appendChild(createPackageCard(pkg, installedSection)));
    }

    function renderPackages(packages) {
      packageList.replaceChildren();
      const installed = Array.isArray(packages?.installed) ? packages.installed : [];
      const marketplace = Array.isArray(packages?.marketplace) ? packages.marketplace : [];
      if (uiState.packagesExpanded && packages?.ready && !packages?.loading &&
          marketplace.length === 0 && !marketplaceRequested) {
        marketplaceRequested = true;
        vscode.postMessage({ type: "package-refresh" });
      }
      packagesCount.textContent = installed.length ? String(installed.length) : "";
      if (document.activeElement !== packageQuery) packageQuery.value = packages?.query || "";
      if (packages?.error) {
        const error = document.createElement("div");
        error.className = "package-error";
        error.textContent = packages.error;
        packageList.appendChild(error);
      }
      appendPackageGroup("installed", installed, true);
      appendPackageGroup(packages?.query ? "results" : "marketplace", marketplace, false);
      if (packages?.loading) {
        const loading = document.createElement("div");
        loading.className = "empty";
        loading.textContent = "Loading packages...";
        packageList.appendChild(loading);
      } else if (!packages?.error && installed.length === 0 && marketplace.length === 0) {
        const empty = document.createElement("div");
        empty.className = "empty";
        empty.textContent = packages?.ready ? "No packages found." : "Package service is starting...";
        packageList.appendChild(empty);
      }
    }

    function render(state) {
      currentState = state;
      renderSessions(Array.isArray(state?.sessions) ? state.sessions : []);
      renderPackages(state?.packages || {});
    }

    window.addEventListener("message", (event) => {
      if (event.data?.type === "state") render(event.data.state);
    });
    document.addEventListener("keydown", (event) => {
      if (event.key === "Escape") document.querySelector(".preview-overlay")?.remove();
    });
    syncPackagesExpanded();
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
