import * as path from "node:path";
import { resolvePiPackagePath } from "./pi-service.js";
import { resolveWorkspaceCwd } from "./workspace.js";
import type { Runtime } from "./types.js";
import { detectRustBinary } from "./rust-resolver.js";
import { rustListInstalled, rustInstall, rustRemove, rustUpdate, rustActiveSources, rustInfo, rustLoadability, type RustPackageInfo, type RustLoadability } from "./rust-packages.js";

export type { RustPackageInfo, RustLoadability } from "./rust-packages.js";

/**
 * Wraps the Pi SDK's DefaultPackageManager for use in the VS Code extension.
 * Provides install, uninstall, list, and marketplace search capabilities.
 */

export interface InstalledPackage {
  source: string;
  scope: "user" | "project";
  filtered: boolean;
  installedPath?: string;
}

export interface MarketplacePackage {
  name: string;
  version: string;
  description: string;
  publisher: string;
  npmPackage: string;
  date: string;
  keywords: string[];
  downloads?: number;
  homepage?: string;
  repository?: string;
  license?: string;
  /** URL of the first image found in the package's README (banner / graphic). */
  bannerUrl?: string;
}

/** Normalize repository URLs from npm to clean https:// URLs. */
function normalizeRepoUrl(url: string): string {
  let u = url.trim();

  // Strip git+ prefix (git+https://... or git+ssh://...)
  if (u.startsWith("git+")) {
    u = u.slice(4);
  }

  // Convert git:// to https://
  if (u.startsWith("git://")) {
    u = "https://" + u.slice(6);
  }

  // Convert ssh://git@host/repo to https://host/repo
  const sshMatch = u.match(/^ssh:\/\/git@([^/]+)\/(.+)$/);
  if (sshMatch) {
    u = "https://" + sshMatch[1] + "/" + sshMatch[2];
  }

  // Convert git@ scp-like URLs (git@github.com:owner/repo.git)
  const scpMatch = u.match(/^git@([^:]+):(.+)$/);
  if (scpMatch) {
    u = "https://" + scpMatch[1] + "/" + scpMatch[2];
  }

  // Handle github: shorthand
  if (u.startsWith("github:")) {
    u = "https://github.com/" + u.slice(7);
  }

  // Strip trailing .git
  u = u.replace(/\.git$/, "");

  return u;
}

export class PiPackageService {
// eslint-disable-next-line @typescript-eslint/no-explicit-any
  private packageManager: any | null = null;
  private sdkRoot: string | null = null;
  private initialized = false;
  /**
   * Which backend drives package operations against the (shared) store:
   * - "sdk"  — the TypeScript SDK's DefaultPackageManager (preferred when present)
   * - "rust" — the Rust binary CLI, used when the SDK isn't installed
   * Packages are a single shared ecosystem, so either backend manages the same
   * `.pi/` packages; the choice only affects HOW operations are executed.
   */
  private backendKind: "sdk" | "rust" | "none" = "none";

  // Marketplace search debounce + cache
  private lastSearchTime = 0;
  private lastSearchPromise: Promise<MarketplacePackage[]> | null = null;
  private defaultResults: MarketplacePackage[] | null = null;

  /**
   * Initialize the package manager. Prefers the TypeScript SDK's
   * DefaultPackageManager; if the SDK isn't installed, falls back to the Rust
   * binary so Rust-only users can still manage the (shared) package store.
   */
  async initialize(): Promise<{ success: boolean; error?: string }> {
    if (this.initialized) { return { success: true }; }

    let sdkError: string;
    try {
      this.sdkRoot = resolvePiPackagePath();
      const SDK = (await import(path.join(this.sdkRoot, "dist/index.js")));
      const cwd = resolveWorkspaceCwd();
      const SettingsManager = SDK.SettingsManager;
      const DefaultPackageManagerClass = SDK.DefaultPackageManager;
      const settingsManager = SettingsManager.create(cwd);

      this.packageManager = new DefaultPackageManagerClass({
        cwd,
        agentDir: SDK.getAgentDir?.(),
        settingsManager,
      });
      this.initialized = true;
      this.backendKind = "sdk";
      return { success: true };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      sdkError = e?.message ?? String(e);
    }

    // SDK unavailable — fall back to the Rust binary against the same store.
    if (detectRustBinary().installed) {
      this.initialized = true;
      this.backendKind = "rust";
      return { success: true };
    }

    this.backendKind = "none";
    return { success: false, error: `No Pi runtime available for package management (SDK: ${sdkError}).` };
  }

  /** Which backend is driving package operations ("sdk" | "rust" | "none"). */
  get backend(): "sdk" | "rust" | "none" { return this.backendKind; }

  /** List all configured/installed packages from the shared store. */
  async listInstalled(): Promise<InstalledPackage[]> {
    if (this.backendKind === "rust") {
      const pkgs = await rustListInstalled();
      return pkgs.map((p) => ({ source: p.source, scope: p.scope, filtered: false, installedPath: p.installedPath }));
    }
    if (!this.packageManager) { return []; }
    try {
      const packages = this.packageManager.listConfiguredPackages();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
      return packages.map((pkg: any) => ({
        source: pkg.source,
        scope: pkg.scope,
        filtered: pkg.filtered ?? false,
        installedPath: pkg.installedPath,
      }));
    } catch {
      return [];
    }
  }

  /**
   * The sources actually loaded ("active") by a session on `runtime`, given the
   * installed set. Packages are shared, but a runtime may not load every one:
   * - typescript — every configured, non-filtered package loads.
   * - rust       — none when extension discovery is disabled for the workspace
   *   (`rustExtensions` / `--no-extensions`); otherwise the doctor-compatible
   *   ones. Installed-but-not-returned = "available, not loaded".
   */
  async computeActiveSources(runtime: Runtime, installed: InstalledPackage[]): Promise<Set<string>> {
    if (runtime === "rust") {
      const cwd = resolveWorkspaceCwd();
      return rustActiveSources(cwd, installed);
    }
    return new Set(installed.filter((p) => !p.filtered).map((p) => p.source));
  }

  /**
   * Provenance / safety signals for a package (`rust-pi info`), or null when the
   * Rust binary isn't available. Surfaced as badges in the Packages view.
   */
  async getSafetyInfo(source: string): Promise<RustPackageInfo | null> {
    if (!detectRustBinary().installed) { return null; }
    const name = source.startsWith("npm:") ? source.slice(4) : source;
    return rustInfo(name);
  }

  /**
   * Whether a focused Rust session would load the (installed) package — used to
   * warn at install time. Resolves the package's on-disk path from the shared
   * store, then defers to the Rust loadability check.
   */
  async checkRustLoadability(source: string): Promise<RustLoadability> {
    const cwd = resolveWorkspaceCwd();
    const installed = await this.listInstalled();
    const pkg = installed.find((p) => p.source === source);
    return rustLoadability(cwd, pkg?.installedPath);
  }

  /** Install a package by source string (e.g. "npm:pi-subagents", "npm:@scope/pkg"). */
  async install(source: string, scope: "user" | "project" = "user"): Promise<{ success: boolean; error?: string }> {
    if (this.backendKind === "rust") { return rustInstall(source, scope === "project"); }
    if (!this.packageManager) {
      return { success: false, error: "Package manager not initialized" };
    }
    try {
      await this.packageManager.installAndPersist(source, { local: scope === "project" });
      return { success: true };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      return { success: false, error: e.message ?? String(e) };
    }
  }

  /** Uninstall a package by source string. */
  async uninstall(source: string, scope: "user" | "project" = "user"): Promise<{ success: boolean; error?: string }> {
    if (this.backendKind === "rust") { return rustRemove(source, scope === "project"); }
    if (!this.packageManager) {
      return { success: false, error: "Package manager not initialized" };
    }
    try {
      await this.packageManager.removeAndPersist(source, { local: scope === "project" });
      return { success: true };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      return { success: false, error: e.message ?? String(e) };
    }
  }

  /** Update all installed packages or a specific one. */
  async update(source?: string): Promise<{ success: boolean; error?: string }> {
    if (this.backendKind === "rust") { return rustUpdate(source); }
    if (!this.packageManager) {
      return { success: false, error: "Package manager not initialized" };
    }
    try {
      await this.packageManager.update(source);
      return { success: true };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      return { success: false, error: e.message ?? String(e) };
    }
  }

  /** Check for available updates across all installed packages. */
  async checkForUpdates(): Promise<Array<{ source: string; displayName: string; type: string; scope: string }>> {
    // The Rust CLI has no dry-run; skip the per-source update markers under it.
    if (this.backendKind === "rust" || !this.packageManager) { return []; }
    try {
      return await this.packageManager.checkForAvailableUpdates();
    } catch {
      return [];
    }
  }

  /**
   * Search the npm registry for pi packages.
   * Uses npm's search API with keywords that pi packages commonly use.
   */
  /**
   * Search the npm registry for pi packages.
   * Results are cached for empty queries.  Rapid calls are debounced to
   * avoid npm 429 rate-limit responses.
   */
  async searchMarketplace(query: string): Promise<MarketplacePackage[]> {
    const q = query.trim();

    // Serve empty-query results from cache
    if (!q && this.defaultResults) {
      return this.defaultResults;
    }

    // Debounce: minimum 2 s between outgoing requests
    const now = Date.now();
    if (now - this.lastSearchTime < 2000 && this.lastSearchPromise) {
      return this.lastSearchPromise;
    }
    this.lastSearchTime = now;

    this.lastSearchPromise = this.doSearchMarketplace(q);
    try {
      const results = await this.lastSearchPromise;
      if (!q) { this.defaultResults = results; }
      return results;
    } finally {
      this.lastSearchPromise = null;
    }
  }

  private async doSearchMarketplace(q: string): Promise<MarketplacePackage[]> {
    try {
      const searchText = q
        ? q
        : "keywords:pi-coding-agent";

      const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(searchText)}&size=100`;
      const response = await fetch(url, {
        headers: { "Accept": "application/json" },
        signal: AbortSignal.timeout(10000),
      });

      if (response.status === 429) {
        throw new Error("Npm rate limit — please wait a few seconds and try again.");
      }
      if (!response.ok) {
        throw new Error(`npm search returned ${response.status}`);
      }

 
      const data = (await response.json());
      const objects = data?.objects ?? [];

      const qLower = q.toLowerCase();

      return objects
// eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((obj: any) => ({
          ...obj,
          package: {
            ...obj.package,
            links: {
              ...obj.package?.links,
              repository: obj.package?.links?.repository
                ? normalizeRepoUrl(obj.package.links.repository)
                : undefined,
            },
          },
        }))
// eslint-disable-next-line @typescript-eslint/no-explicit-any
        .filter((obj: any) => {
          const pkgObj = obj.package;
          const name = (pkgObj.name ?? "").toLowerCase();
          const desc = (pkgObj.description ?? "").toLowerCase();
          const keywords: string[] = pkgObj.keywords ?? [];
          const publisher = (pkgObj.publisher?.username ?? "").toLowerCase();

          const isPiPkg =
            name.startsWith("pi-") ||
            name.includes("-pi-") ||
            keywords.some((k: string) => k.toLowerCase().includes("pi")) ||
            desc.includes("pi coding agent") ||
            desc.includes("pi agent") ||
            desc.includes("pi extension");

          if (!isPiPkg) { return false; }

          if (qLower) {
            return (
              name.includes(qLower) ||
              desc.includes(qLower) ||
              publisher.includes(qLower) ||
              keywords.some((k: string) => k.toLowerCase().includes(qLower))
            );
          }

          return true;
        })
// eslint-disable-next-line @typescript-eslint/no-explicit-any
        .map((obj: any) => {
          const p = obj.package;
          return {
            name: p.name,
            version: p.version,
            description: p.description ?? "",
            publisher: p.publisher?.username ?? "",
            npmPackage: p.name,
            date: p.date ?? "",
            keywords: p.keywords ?? [],
            downloads: obj.downloads?.weekly ?? 0,
            homepage: p.links?.homepage ?? p.links?.npm ?? "",
            repository: p.links?.repository ?? "",
            license: p.license ?? "",
          };
        });
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      throw new Error(`Marketplace search failed: ${e.message ?? e}`);
    }
  }

  /** Check if the package manager is ready (via either backend). */
  get isReady(): boolean {
    return this.initialized && this.backendKind !== "none";
  }

  /**
   * Try to find a banner image from a package's README on GitHub.
   * Returns the full URL of the first `![...](...)` image found, or undefined.
   */
  async fetchBannerImage(repositoryUrl: string): Promise<string | undefined> {
    try {
      // Only support GitHub repos
      const ghMatch = repositoryUrl.match(/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/);
      if (!ghMatch) { return undefined; }

      const [, owner, repo] = ghMatch;
      const readmeUrl = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/README.md`;

      const response = await fetch(readmeUrl, {
        signal: AbortSignal.timeout(5000),
      });
      if (!response.ok) { return undefined; }

      const text = await response.text();

      // Find the first markdown image: ![alt](url)
      const imgMatch = text.match(/!\[.*?\]\(([^)]+)\)/);
      if (!imgMatch?.[1]) { return undefined; }

      let imgUrl = imgMatch[1];

      // Resolve relative URLs
      if (imgUrl.startsWith("./") || imgUrl.startsWith("../") || (!imgUrl.startsWith("http") && !imgUrl.startsWith("//"))) {
        const base = `https://raw.githubusercontent.com/${owner}/${repo}/HEAD/`;
        imgUrl = new URL(imgUrl, base).toString();
      }

      return imgUrl;
    } catch {
      return undefined;
    }
  }

  /**
   * Look up installed npm packages in the marketplace for richer metadata.
   */
  async enrichInstalledPackages(packages: InstalledPackage[]): Promise<Map<string, MarketplacePackage>> {
    const enriched = new Map<string, MarketplacePackage>();
    const npmPackages = packages.filter((p) => p.source.startsWith("npm:"));
    if (npmPackages.length === 0) { return enriched; }

    try {
      // Batch lookup: fetch each npm package's metadata
      const results = await Promise.allSettled(
        npmPackages.map(async (pkg) => {
          const name = pkg.source.slice(4); // remove "npm:"
          const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(name)}&size=1`;
          const response = await fetch(url, {
            headers: { "Accept": "application/json" },
            signal: AbortSignal.timeout(5000),
          });
          if (!response.ok) { return null; }
 
          const data = (await response.json());
          const obj = data?.objects?.[0];
          if (!obj) { return null; }
          const p = obj.package;
          return {
            name: p.name,
            version: p.version,
            description: p.description ?? "",
            publisher: p.publisher?.username ?? "",
            npmPackage: p.name,
            date: p.date ?? "",
            keywords: p.keywords ?? [],
            downloads: obj.downloads?.weekly ?? 0,
            homepage: p.links?.homepage ?? p.links?.npm ?? "",
            repository: p.links?.repository ? normalizeRepoUrl(p.links.repository) : "",
            license: p.license ?? "",
          };
        }),
      );

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.status === "fulfilled" && result.value) {
          enriched.set(npmPackages[i].source, result.value);
        }
      }
    } catch { /* ignore */ }

    return enriched;
  }
}
