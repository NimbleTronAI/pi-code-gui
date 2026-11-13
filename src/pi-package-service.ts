import * as path from "node:path";
import { importSpecifierFor } from "./sdk-service.js";
import { resolvePiPackagePath } from "./pi-service.js";
import { resolveWorkspaceCwd } from "./workspace.js";
import { isPiMarketplacePackage, npmSearchFailureText } from "./pi-package-filter.js";

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

  // Marketplace search debounce + cache
  private lastSearchTime = 0;
  private lastSearchPromise: Promise<MarketplacePackage[]> | null = null;
  /** Query the in-flight search is for (see the debounce below). */
  private lastSearchQuery: string | null = null;
  private defaultResults: MarketplacePackage[] | null = null;

  // enrichInstalledPackages: name-keyed TTL cache so repeated tree refreshes
  // don't re-hit the npm registry N times (429-burst guard). null = looked up,
  // no match (negative-cached too, so a missing package isn't re-fetched every refresh).
  private enrichCache = new Map<string, { value: MarketplacePackage | null; ts: number }>();
  private static readonly ENRICH_TTL_MS = 5 * 60 * 1000;

  /** Initialize the package manager (the Pi SDK's DefaultPackageManager). */
  async initialize(): Promise<{ success: boolean; error?: string }> {
    if (this.initialized) { return { success: true }; }

    try {
      this.sdkRoot = resolvePiPackagePath();
      // Same Windows ESM constraint as importWithRetry — see importSpecifierFor. This second
      // call site was not named in gh #71, so fixing only sdk-service.ts would have left the
      // Packages view broken on Windows while the sessions it reports on worked.
      const SDK = (await import(importSpecifierFor(path.join(this.sdkRoot, "dist/index.js"))));
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
      return { success: true };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      return { success: false, error: `Pi is not available for package management (SDK: ${e?.message ?? String(e)}).` };
    }
  }

  /** List all configured/installed packages from the store. */
  async listInstalled(): Promise<InstalledPackage[]> {
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

  /** The sources actually loaded ("active") by a session, given the installed set: every
   *  configured, non-filtered package. Installed-but-not-returned = "available, not loaded". */
  async computeActiveSources(installed: InstalledPackage[]): Promise<Set<string>> {
    return new Set(installed.filter((p) => !p.filtered).map((p) => p.source));
  }

  /** Install a package by source string (e.g. "npm:pi-subagents", "npm:@scope/pkg"). */
  async install(source: string, scope: "user" | "project" = "user"): Promise<{ success: boolean; error?: string }> {

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
    if (!this.packageManager) { return []; }

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
    // Reuse the in-flight request only when it is for the SAME query. It used to be returned for
    // any query inside the window, so typing "web" then "mcp" resolved the second call with the
    // first call's results — rendering them under the wrong header.
    if (now - this.lastSearchTime < 2000 && this.lastSearchPromise && this.lastSearchQuery === q) {
      return this.lastSearchPromise;
    }
    this.lastSearchTime = now;
    this.lastSearchQuery = q;

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

      if (!response.ok) {
        throw new Error(npmSearchFailureText(response.status));
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

          if (!isPiMarketplacePackage(pkgObj)) { return false; }

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

  /** Check if the package manager is ready. */
  get isReady(): boolean {
    return this.initialized && this.packageManager !== null;
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

    // Serve fresh cache entries; only the misses hit the network (429-burst guard).
    const now = Date.now();
    const ttl = PiPackageService.ENRICH_TTL_MS;
    const toFetch: Array<{ source: string; name: string }> = [];
    for (const pkg of npmPackages) {
      const name = pkg.source.slice(4); // remove "npm:"
      const cached = this.enrichCache.get(name);
      if (cached && now - cached.ts < ttl) {
        if (cached.value) { enriched.set(pkg.source, cached.value); }
        continue;
      }
      toFetch.push({ source: pkg.source, name });
    }
    if (toFetch.length === 0) { return enriched; }

    try {
      const results = await Promise.allSettled(
        toFetch.map(async ({ name }) => {
          const url = `https://registry.npmjs.org/-/v1/search?text=${encodeURIComponent(name)}&size=1`;
          const response = await fetch(url, {
            headers: { "Accept": "application/json" },
            signal: AbortSignal.timeout(5000),
          });
          if (!response.ok) { return null; }

          const data = (await response.json());
          const p = data?.objects?.[0]?.package;
          // Name-equality guard: the search API ranks by relevance, so objects[0]
          // can be a DIFFERENT package — never attach another package's metadata.
          if (!p || p.name !== name) { return null; }
          return {
            name: p.name,
            version: p.version,
            description: p.description ?? "",
            publisher: p.publisher?.username ?? "",
            npmPackage: p.name,
            date: p.date ?? "",
            keywords: p.keywords ?? [],
            downloads: data?.objects?.[0]?.downloads?.weekly ?? 0,
            homepage: p.links?.homepage ?? p.links?.npm ?? "",
            repository: p.links?.repository ? normalizeRepoUrl(p.links.repository) : "",
            license: p.license ?? "",
          };
        }),
      );

      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        const value = result.status === "fulfilled" ? result.value : null;
        // Cache hits AND misses (negative cache) so a package without a
        // marketplace match isn't re-fetched on every refresh.
        this.enrichCache.set(toFetch[i].name, { value, ts: now });
        if (value) { enriched.set(toFetch[i].source, value); }
      }
    } catch { /* ignore */ }

    return enriched;
  }
}
