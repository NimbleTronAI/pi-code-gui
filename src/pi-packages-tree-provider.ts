import * as vscode from "vscode";
import type { PiPackageService, InstalledPackage, MarketplacePackage, RustPackageInfo } from "./pi-package-service.js";
import type { Runtime } from "./types.js";

/**
 * Tree data provider for the Pi Packages view.
 *
 * Structure:
 *   Pi Packages
 *     ▼ Installed (N)
 *         pi-subagents  ▸
 *           📋 Overview         — description, badges, links, banner tooltip
 *           🗑 Uninstall
 *           ⬆ Update
 *     ▼ Marketplace
 *         [Search packages...]
 *         pi-web-access  ▸     — click = install, chevron = overview
 *           📋 Overview         — same format as installed
 *           💾 Install
 */

class PkgTreeItem extends vscode.TreeItem {
  public installedData?: InstalledPackage;
  public marketData?: MarketplacePackage;

  constructor(
    label: string,
    contextValue: string,
    collapsible?: vscode.TreeItemCollapsibleState,
  ) {
    super(label, collapsible ?? vscode.TreeItemCollapsibleState.None);
    this.contextValue = contextValue;
  }
}

// ── Formatters ────────────────────────────────────────────

function fmtDl(n: number): string {
  if (n >= 1000000) { return `${(n / 1000000).toFixed(1)}M/wk`; }
  if (n >= 1000) { return `${(n / 1000).toFixed(1)}K/wk`; }
  if (n > 0) { return `${n}/wk`; }
  return "";
}

function srcLabel(source: string): string {
  if (source.startsWith("npm:")) { return source.slice(4); }
  if (source.startsWith("git:")) {
    const parts = source.slice(4).split("@")[0];
    return parts.split("/").pop() ?? source;
  }
  return source;
}

// ── Providers ────────────────────────────────────────────

export class PiPackagesTreeProvider implements vscode.TreeDataProvider<PkgTreeItem> {
  /** Coalesced full-tree refresh. Banner and safety lookups complete independently — up to 100
   *  concurrent marketplace fetches, each previously firing its own FULL-tree change event, so a
   *  single search could re-render the whole tree a hundred times. Batch them into one frame. */
  private _refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private fireRefresh(): void {
    if (this._refreshTimer) { return; }
    this._refreshTimer = setTimeout(() => {
      this._refreshTimer = null;
      this._onDidChangeTreeData.fire();
    }, 50);
  }

  private _onDidChangeTreeData = new vscode.EventEmitter<PkgTreeItem | undefined | null | void>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private installed: InstalledPackage[] = [];
  /** Marketplace metadata for installed npm packages (enriched on refresh). */
  private installedEnriched = new Map<string, MarketplacePackage>();
  private market: MarketplacePackage[] = [];
  private marketLoading = false;
  private marketError: string | null = null;
  private searchQuery = "";
  private updatesAvail = new Map<string, boolean>();

  /** Runtime of the focused session — packages are shown from its perspective. */
  private focusedRuntime: Runtime = "typescript";
  /** Sources actually loaded ("active") by the focused runtime. */
  private activeSources = new Set<string>();
  /** Provenance / safety signals per installed source (from `rust-pi info`). */
  private installedSafety = new Map<string, RustPackageInfo>();

  constructor(private pkgService: PiPackageService) {}

  /**
   * Point the view at a session runtime (called when session focus changes).
   * Recomputes which installed packages are active under that runtime, so the
   * same shared catalog is shown "available vs active" for whichever session is
   * in focus. No-op when the runtime is unchanged (avoids re-probing on every
   * panel activation).
   */
  async setFocusedRuntime(runtime: Runtime): Promise<void> {
    if (runtime === this.focusedRuntime) { return; } // refreshAll keeps the set current
    this.focusedRuntime = runtime;
    await this.recomputeActive();
    this._onDidChangeTreeData.fire();
  }

  private runtimeLabel(): string {
    return this.focusedRuntime === "rust" ? "Rust" : "TypeScript";
  }

  private async recomputeActive(): Promise<void> {
    try {
      this.activeSources = await this.pkgService.computeActiveSources(this.focusedRuntime, this.installed);
    } catch {
      this.activeSources = new Set(this.installed.map((p) => p.source));
    }
  }

  /** Fetch provenance/safety signals for installed packages (background, cached). */
  private loadSafetyInfo(): void {
    for (const pkg of this.installed) {
      if (this.installedSafety.has(pkg.source)) { continue; }
      this.pkgService.getSafetyInfo(pkg.source).then((info) => {
        if (info) { this.installedSafety.set(pkg.source, info); this.fireRefresh(); }
      }).catch(() => {});
    }
  }

  /** "risk: low · caps: none · npm" style summary, or "" when no signals known. */
  private safetySummary(source: string): string {
    const s = this.installedSafety.get(source);
    if (!s) { return ""; }
    const parts: string[] = [];
    if (s.risk) { parts.push(`risk: ${s.risk}`); }
    if (s.capabilities) { parts.push(`caps: ${s.capabilities}`); }
    if (s.source) { parts.push(s.source); }
    return parts.join("  ·  ");
  }

  // ── Refresh ──────────────────────────────────────────

  async refreshAll(searchQuery?: string): Promise<void> {
    const explicitSearch = searchQuery !== undefined;
    if (explicitSearch) { this.searchQuery = searchQuery; }
    await this.loadInstalled();
    await this.recomputeActive();
    this.loadSafetyInfo();
    await this.loadUpdates();
    await this.loadInstalledEnrichment();
    // Re-search when an explicit query was given (including clearing to ""),
    // or when we have no results yet.
    if (explicitSearch || this.market.length === 0) {
      await this.searchMarketplace();
    }
    this._onDidChangeTreeData.fire();
  }

  private async loadInstalled(): Promise<void> {
    try { this.installed = await this.pkgService.listInstalled(); }
    catch { this.installed = []; }
  }

  private async loadUpdates(): Promise<void> {
    try {
      this.updatesAvail.clear();
      for (const u of (await this.pkgService.checkForUpdates())) {
        this.updatesAvail.set(u.source, true);
      }
    } catch { /* ignore */ }
  }

  private async loadInstalledEnrichment(): Promise<void> {
    try {
      this.installedEnriched = await this.pkgService.enrichInstalledPackages(this.installed);
      // Fetch banners for enriched packages
      for (const [, mp] of this.installedEnriched) {
        if (mp.repository && !mp.bannerUrl) {
          this.pkgService.fetchBannerImage(mp.repository).then((url) => {
            if (url) {
              mp.bannerUrl = url;
              this.fireRefresh();
            }
          }).catch(() => {});
        }
      }
    } catch { /* ignore */ }
  }

  private async searchMarketplace(): Promise<void> {
    this.marketLoading = true;
    this.marketError = null;
    this._onDidChangeTreeData.fire();
    try {
      this.market = await this.pkgService.searchMarketplace(this.searchQuery);
      // Fire once for initial results, then fetch banners lazily
      this._onDidChangeTreeData.fire();
      // Fetch banners in background
      for (const mp of this.market) {
        if (mp.repository && !mp.bannerUrl) {
          this.pkgService.fetchBannerImage(mp.repository).then((url) => {
            if (url) {
              mp.bannerUrl = url;
              this.fireRefresh();
            }
          }).catch(() => {});
        }
      }
    } catch (e: unknown) {
      const err = e instanceof Error ? e : new Error(String(e));
      this.marketError = err.message;
      this.market = [];
    } finally {
      this.marketLoading = false;
    }
  }

  // ── TreeDataProvider ──────────────────────────────────

  getTreeItem(element: PkgTreeItem): vscode.TreeItem { return element; }

  async getChildren(element?: PkgTreeItem): Promise<PkgTreeItem[]> {
    if (!element) {
      const children: PkgTreeItem[] = [];

      const n = this.installed.length;
      const installedHeader = new PkgTreeItem(
        n > 0 ? `Installed (${n})` : "Installed",
        "packages-installed-header",
        n > 0 ? vscode.TreeItemCollapsibleState.Expanded : vscode.TreeItemCollapsibleState.None,
      );
      // Show which session runtime the active/available state reflects.
      const activeCount = this.installed.filter((p) => this.activeSources.has(p.source)).length;
      installedHeader.description = n > 0
        ? `${this.runtimeLabel()} · ${activeCount}/${n} active`
        : `${this.runtimeLabel()} session`;
      installedHeader.tooltip = new vscode.MarkdownString(
        `Packages are shared across runtimes. **Active** = loaded by the focused **${this.runtimeLabel()}** session; ` +
        `**available** = installed but not loaded by it.`,
      );
      children.push(installedHeader);

      children.push(new PkgTreeItem(
        this.searchQuery ? `Marketplace: "${this.searchQuery}"` : "Marketplace",
        "packages-marketplace-header",
        vscode.TreeItemCollapsibleState.Expanded,
      ));
      return children;
    }

    if (element.contextValue === "packages-installed-header") {return this.buildInstalledList();}
    if (element.contextValue === "packages-marketplace-header") {return this.buildMarketplaceList();}
    if (element.contextValue === "package-installed") {return this.buildOverview(element.installedData, element);}
    if (element.contextValue === "package-marketplace") {return this.buildOverview(undefined, element);}

    return [];
  }

  // ── Installed list ────────────────────────────────────

  private buildInstalledList(): PkgTreeItem[] {
    if (this.installed.length === 0) {
      const hint = new PkgTreeItem("No packages installed. Search the Marketplace below.", "packages-installed-empty");
      hint.iconPath = new vscode.ThemeIcon("info");
      return [hint];
    }

    return this.installed.map((pkg) => {
      const label = srcLabel(pkg.source);
      const hasUpdate = this.updatesAvail.has(pkg.source);
      const enriched = this.installedEnriched.get(pkg.source);
      const active = this.activeSources.has(pkg.source);

      const item = new PkgTreeItem(
        label,
        "package-installed",
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.installedData = pkg;
      // "available, not loaded" calls out packages the focused runtime can't/won't load.
      const stateNote = active ? "" : `  · not loaded by ${this.runtimeLabel()}`;
      item.description = `${pkg.scope}${hasUpdate ? "  ⬆" : ""}${stateNote}`;
      item.iconPath = active
        ? new vscode.ThemeIcon(hasUpdate ? "sync" : pkg.scope === "project" ? "folder-library" : "package")
        : new vscode.ThemeIcon("circle-slash", new vscode.ThemeColor("disabledForeground"));
      item.tooltip = this.buildTooltip(enriched, pkg);
      return item;
    });
  }

  // ── Marketplace list ──────────────────────────────────

  private buildMarketplaceList(): PkgTreeItem[] {
    const children: PkgTreeItem[] = [];

    // Search box
    const searchBox = new PkgTreeItem(
      this.searchQuery || "Search packages...",
      "packages-marketplace-search",
    );
    searchBox.iconPath = new vscode.ThemeIcon("search");
    searchBox.description = this.searchQuery ? "click to change" : "click to search";
    searchBox.command = { command: "pi-code-gui.searchPackages", title: "Search Pi Packages" };
    children.push(searchBox);

    if (this.marketLoading) {
      const load = new PkgTreeItem("Loading...", "packages-marketplace-loading");
      load.iconPath = new vscode.ThemeIcon("loading~spin");
      children.push(load);
      return children;
    }

    if (this.marketError) {
      const err = new PkgTreeItem(`Search failed: ${this.marketError}`, "packages-marketplace-error");
      err.iconPath = new vscode.ThemeIcon("error");
      children.push(err);
    }

    if (!this.marketLoading && !this.marketError && this.market.length === 0) {
      const msg = this.searchQuery
        ? `No packages found for "${this.searchQuery}"`
        : "Click the search box above to find Pi packages";
      const hint = new PkgTreeItem(msg, "packages-marketplace-empty");
      hint.iconPath = new vscode.ThemeIcon(this.searchQuery ? "search" : "info");
      children.push(hint);
      return children;
    }

    const installedSrc = new Set(this.installed.map((p) => p.source));

    for (const mp of this.market) {
      const src = `npm:${mp.npmPackage}`;
      const isInstalled = installedSrc.has(src);

      const parts = [`v${mp.version}`];
      if (mp.license) {parts.push(mp.license);}
      const dl = fmtDl(mp.downloads ?? 0);
      if (dl) {parts.push(dl);}
      if (isInstalled) {parts.push("✓ installed");}

      const item = new PkgTreeItem(
        mp.npmPackage,
        isInstalled ? "package-marketplace-installed" : "package-marketplace",
        vscode.TreeItemCollapsibleState.Collapsed,
      );
      item.marketData = mp;
      item.description = parts.join("  ·  ");
      item.iconPath = new vscode.ThemeIcon(isInstalled ? "check" : "cloud-download");
      item.tooltip = this.buildTooltip(mp);

      if (!isInstalled) {
        item.command = { command: "pi-code-gui.installPackage", title: "Install Package", arguments: [item] };
        item.tooltip = new vscode.MarkdownString(
          (mp.bannerUrl ? `![banner](${mp.bannerUrl}|height=80)\n\n` : "") +
          `**${mp.npmPackage}** v${mp.version}\n\n` +
          `${mp.description}\n\n` +
          `Click to **install**.  Click ▸ for details.`,
        );
      } else {
        item.tooltip = this.buildTooltip(mp);
      }

      children.push(item);
    }

    // Browse more
    if (this.market.length > 0) {
      const browse = new PkgTreeItem("Browse all packages on pi.dev →", "packages-marketplace-browse");
      browse.iconPath = new vscode.ThemeIcon("globe");
      browse.command = { command: "pi-code-gui.openPiDevMarketplace", title: "Open pi.dev/packages" };
      children.push(browse);
    }

    return children;
  }

  // ── Unified overview (expanded child for both installed & marketplace) ──

  /**
   * Build the overview children for an expanded package.
   * @param installed  — set for installed packages
   * @param element    — the parent tree item (must have .marketData for marketplace, or installedData for installed)
   */
  private buildOverview(installed?: InstalledPackage, element?: PkgTreeItem): PkgTreeItem[] {
    const children: PkgTreeItem[] = [];

    // Determine the metadata source
    let mp: MarketplacePackage | undefined;
    if (installed) {
      mp = this.installedEnriched.get(installed.source);
    } else if (element?.marketData) {
      mp = element.marketData;
    }

    // ── 1. Description ──
    const desc = mp?.description || "(no description)";
    const descItem = new PkgTreeItem(desc, "pkg-overview-desc");
    descItem.iconPath = new vscode.ThemeIcon("book");
    descItem.tooltip = this.buildTooltip(mp, installed);
    children.push(descItem);

    // ── 2. Badges row (version · license · downloads · publisher) ──
    const badgeParts: string[] = [];
    if (mp?.version) {badgeParts.push(`v${mp.version}`);}
    if (mp?.license) {badgeParts.push(mp.license);}
    const dl = fmtDl(mp?.downloads ?? 0);
    if (dl) {badgeParts.push(dl);}
    if (mp?.publisher) {badgeParts.push(`by ${mp.publisher}`);}

    if (badgeParts.length > 0) {
      const badgesItem = new PkgTreeItem(
        badgeParts.join("  ·  "),
        "pkg-overview-badges",
      );
      badgesItem.iconPath = new vscode.ThemeIcon("symbol-misc");
      children.push(badgesItem);
    }

    // ── 3. Keywords ──
    if (mp?.keywords && mp.keywords.length > 0) {
      const kw = mp.keywords.filter((k) => !k.startsWith("pi-")).slice(0, 8);
      if (kw.length > 0) {
        const kwItem = new PkgTreeItem(`🏷 ${kw.join("  ")}`, "pkg-overview-keywords");
        kwItem.iconPath = new vscode.ThemeIcon("tag");
        kwItem.tooltip = mp.keywords.join(", ");
        children.push(kwItem);
      }
    }

    // ── 4. Links (each clickable, opens browser) ──
    if (mp?.npmPackage) {
      const npmUrl = `https://www.npmjs.com/package/${mp.npmPackage}`;
      const npmItem = new PkgTreeItem(`npm: ${mp.npmPackage}`, "pkg-overview-link");
      npmItem.iconPath = new vscode.ThemeIcon("package");
      npmItem.command = { command: "pi-code-gui.openUrl", title: "Open npm", arguments: [npmUrl] };
      npmItem.tooltip = npmUrl;
      children.push(npmItem);
    }
    if (mp?.repository) {
      const repoItem = new PkgTreeItem(`repo: ${mp.repository}`, "pkg-overview-link");
      repoItem.iconPath = new vscode.ThemeIcon("github");
      repoItem.command = { command: "pi-code-gui.openUrl", title: "Open Repo", arguments: [mp.repository] };
      repoItem.tooltip = mp.repository;
      children.push(repoItem);
    }
    if (mp?.homepage && mp.homepage !== mp.repository) {
      const hpItem = new PkgTreeItem(`homepage: ${mp.homepage}`, "pkg-overview-link");
      hpItem.iconPath = new vscode.ThemeIcon("globe");
      hpItem.command = { command: "pi-code-gui.openUrl", title: "Open Homepage", arguments: [mp.homepage] };
      hpItem.tooltip = mp.homepage;
      children.push(hpItem);
    }

    // ── 4b. Safety / provenance (installed; from rust-pi info) ──
    if (installed) {
      const summary = this.safetySummary(installed.source);
      if (summary) {
        const safetyItem = new PkgTreeItem(summary, "pkg-overview-safety");
        safetyItem.iconPath = new vscode.ThemeIcon("shield");
        const s = this.installedSafety.get(installed.source);
        safetyItem.tooltip = new vscode.MarkdownString(
          `**Safety signals** (Rust catalog)\n\n` +
          (s?.risk ? `- Risk: ${s.risk}\n` : "") +
          (s?.confidence ? `- Confidence: ${s.confidence}\n` : "") +
          (s?.capabilities ? `- Capabilities: ${s.capabilities}\n` : "") +
          (s?.categories ? `- Categories: ${s.categories}\n` : "") +
          (s?.source ? `- Source: ${s.source}\n` : ""),
        );
        children.push(safetyItem);
      }
    }

    // ── 5. Actions ──
    if (installed) {
      // Uninstall
      const uninstallItem = new PkgTreeItem("🗑 Uninstall", "pkg-action-uninstall");
      uninstallItem.command = { command: "pi-code-gui.uninstallPackage", title: "Uninstall", arguments: [element] };
      uninstallItem.iconPath = new vscode.ThemeIcon("trash");
      children.push(uninstallItem);

      // Update (if available)
      if (this.updatesAvail.has(installed.source)) {
        const updateItem = new PkgTreeItem("⬆ Update to latest", "pkg-action-update");
        updateItem.command = { command: "pi-code-gui.updatePackage", title: "Update", arguments: [element] };
        updateItem.iconPath = new vscode.ThemeIcon("sync");
        children.push(updateItem);
      }
    } else if (mp) {
      const src = `npm:${mp.npmPackage}`;
      const isInstalled = this.installed.some((ip) => ip.source === src);
      if (!isInstalled) {
        const installItem = new PkgTreeItem("💾 Install", "pkg-action-install");
        installItem.command = { command: "pi-code-gui.installPackage", title: "Install", arguments: [element] };
        installItem.iconPath = new vscode.ThemeIcon("cloud-download");
        installItem.description = "Installs with scope picker";
        children.push(installItem);
      }
    }

    return children;
  }

  // ── Tooltip builder ────────────────────────────────────

  private buildTooltip(mp?: MarketplacePackage, installed?: InstalledPackage): vscode.MarkdownString {
    const name = mp?.npmPackage ?? (installed ? srcLabel(installed.source) : "?");
    const lines: string[] = [];

    // Banner image (if available) — VS Code supports ![]() in MarkdownString tooltips
    if (mp?.bannerUrl) {
      lines.push(`![banner](${mp.bannerUrl})`);
      lines.push("");
    }

    lines.push(`**${name}**${mp?.version ? ` v${mp.version}` : ""}`);
    lines.push("");

    if (mp?.description) {
      lines.push(mp.description);
      lines.push("");
    }

    const metaLines: string[] = [];
    if (mp?.publisher) {metaLines.push(`| Publisher | ${mp.publisher} |`);}
    if (mp?.license) {metaLines.push(`| License | ${mp.license} |`);}
    if (mp?.downloads) {metaLines.push(`| Weekly downloads | ${mp.downloads.toLocaleString()} |`);}
    if (installed) {
      metaLines.push(`| Scope | ${installed.scope} |`);
      metaLines.push(`| Source | \`${installed.source}\` |`);
      if (installed.installedPath) {metaLines.push(`| Path | \`${installed.installedPath}\` |`);}
    }

    if (metaLines.length > 0) {
      lines.push("| | |");
      lines.push("|---|---|");
      lines.push(...metaLines);
      lines.push("");
    }

    if (mp?.npmPackage) {
      lines.push(`[npm](https://www.npmjs.com/package/${mp.npmPackage}) · [pi.dev](https://pi.dev/packages/${mp.npmPackage})`);
    }

    return new vscode.MarkdownString(lines.join("\n"));
  }

  /** Show a persistent error banner at the root of the tree. */
  showError(message: string): void {
    this.marketError = message;
    this._onDidChangeTreeData.fire();
  }
}
