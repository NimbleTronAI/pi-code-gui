import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { resolvePiPackagePath } from "./pi-service.js";
import { getWorkspaceCwd } from "./workspace-context.js";

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

export interface ManagedExtension {
  name: string;
  path: string;
  enabled: boolean;
  source: string;
  scope: "user" | "project" | "temporary";
  origin: "package" | "top-level";
}

interface PackageSourceConfig {
  source: string;
  autoload?: boolean;
  extensions?: string[];
  skills?: string[];
  prompts?: string[];
  themes?: string[];
}

interface PackageSettings {
  packages?: Array<string | PackageSourceConfig>;
  extensions?: string[];
}

interface ResolvedExtensionResource {
  path: string;
  enabled: boolean;
  metadata: {
    source: string;
    scope: "user" | "project" | "temporary";
    origin: "package" | "top-level";
    baseDir?: string;
  };
}

interface DynamicSettingsManager {
  reload(): Promise<void>;
  getGlobalSettings(): PackageSettings;
  getProjectSettings(): PackageSettings;
  setPackages(packages: Array<string | PackageSourceConfig>): void;
  setProjectPackages(packages: Array<string | PackageSourceConfig>): void;
  setExtensionPaths(paths: string[]): void;
  setProjectExtensionPaths(paths: string[]): void;
}

interface DynamicPackageManager {
  resolve(): Promise<{ extensions: ResolvedExtensionResource[] }>;
  listConfiguredPackages(): InstalledPackage[];
  installAndPersist(source: string, options: { local: boolean }): Promise<void>;
  removeAndPersist(source: string, options: { local: boolean }): Promise<void>;
  update(source?: string): Promise<void>;
  checkForAvailableUpdates(): Promise<Array<{ source: string; displayName: string; type: string; scope: string }>>;
}

function packageSource(config: string | PackageSourceConfig): string {
  return typeof config === "string" ? config : config.source;
}

function extensionName(extensionPath: string, source: string): string {
  if (source && source !== "auto") { return source.replace(/^(npm|git):/, ""); }
  const fileName = path.basename(extensionPath);
  return fileName.replace(/\.[^.]+$/, "") || fileName;
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
  /** Official Pi gallery preview metadata from package.json#pi. */
  imageUrl?: string;
  videoUrl?: string;
  /** Fallback image discovered from the package README. */
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
  private packageManager: DynamicPackageManager | null = null;
  private settingsManager: DynamicSettingsManager | null = null;
  private sdkRoot: string | null = null;
  private initialized = false;

  // Marketplace search debounce + cache
  private lastSearchTime = 0;
  private lastSearchPromise: Promise<MarketplacePackage[]> | null = null;
  private defaultResults: MarketplacePackage[] | null = null;

  /** Initialize the package manager, loading the SDK dynamically. */
  async initialize(): Promise<{ success: boolean; error?: string }> {
    if (this.initialized) { return { success: true }; }

    try {
      this.sdkRoot = resolvePiPackagePath();
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      return { success: false, error: `SDK not found: ${e.message ?? e}` };
    }

    try {
 
      const sdkPath = path.join(this.sdkRoot, "dist/index.js");
      const sdkTarget = process.platform === "win32"
        ? pathToFileURL(sdkPath).href
        : sdkPath;
      const SDK = (await import(sdkTarget));
      const cwd = getWorkspaceCwd();
      const SettingsManager = SDK.SettingsManager;
      const DefaultPackageManagerClass = SDK.DefaultPackageManager;
      this.settingsManager = SettingsManager.create(cwd);

      this.packageManager = new DefaultPackageManagerClass({
        cwd,
        agentDir: SDK.getAgentDir?.(),
        settingsManager: this.settingsManager,
      });
      this.initialized = true;
      return { success: true };
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      return { success: false, error: `Failed to initialize package manager: ${e.message ?? e}` };
    }
  }

  /** List all configured/installed packages. */
  listInstalled(): InstalledPackage[] {
    if (!this.packageManager) { return []; }
    try {
      const packages = this.packageManager.listConfiguredPackages();
      return packages.map((pkg) => ({
        source: pkg.source,
        scope: pkg.scope,
        filtered: pkg.filtered ?? false,
        installedPath: pkg.installedPath,
      }));
    } catch {
      return [];
    }
  }

  /** List extension resources resolved from current user/project settings. */
  async listExtensions(): Promise<ManagedExtension[]> {
    if (!this.packageManager || !this.settingsManager) { return []; }
    await this.settingsManager.reload();
    const resolved = await this.packageManager.resolve();
    return resolved.extensions.map((extension) => ({
        name: extensionName(extension.path, extension.metadata.source),
        path: extension.path,
        enabled: extension.enabled,
        source: extension.metadata.source,
        scope: extension.metadata.scope,
        origin: extension.metadata.origin,
      }));
  }

  /** Persist an extension resource override. Session reload is handled by the caller. */
  async setExtensionEnabled(extensionPath: string, enabled: boolean): Promise<void> {
    if (!this.packageManager || !this.settingsManager) {
      throw new Error("Package manager not initialized");
    }

    await this.settingsManager.reload();
    const resolved = await this.packageManager.resolve();
    const resource = resolved.extensions.find(
      (extension) => path.resolve(extension.path) === path.resolve(extensionPath),
    );
    if (!resource?.metadata) { throw new Error("Extension resource was not found"); }

    const metadata = resource.metadata;
    if (metadata.scope === "temporary") {
      throw new Error("Temporary extensions cannot be persisted");
    }

    const baseDir = metadata.baseDir ?? path.dirname(extensionPath);
    const relativePath = path.relative(baseDir, extensionPath).replace(/\\/g, "/");
    const matchesPath = (pattern: string): boolean =>
      pattern.replace(/^[!+-]/, "").replace(/\\/g, "/") === relativePath;

    if (metadata.origin === "package") {
      const settings = metadata.scope === "project"
        ? this.settingsManager.getProjectSettings()
        : this.settingsManager.getGlobalSettings();
      const packages = [...(settings.packages ?? [])] as Array<string | PackageSourceConfig>;
      const packageIndex = packages.findIndex((config) => packageSource(config) === metadata.source);
      if (packageIndex < 0) {
        throw new Error(`Package configuration not found: ${metadata.source}`);
      }

      const current = packages[packageIndex];
      const next: PackageSourceConfig = typeof current === "string" ? { source: current } : { ...current };
      const originalPatterns = next.extensions;
      let patterns = [...(originalPatterns ?? [])].filter((pattern) => !matchesPath(pattern));
      if (enabled) {
        if (originalPatterns?.length === 0) {
          patterns = [relativePath];
        } else if (originalPatterns?.some((pattern) => !/^[!+-]/.test(pattern))) {
          patterns.push(`+${relativePath}`);
        }
      } else if (originalPatterns?.length !== 0) {
        patterns.push(`-${relativePath}`);
      }

      if (patterns.length > 0 || originalPatterns?.length === 0) {
        next.extensions = [...new Set(patterns)];
      } else {
        delete next.extensions;
      }
      packages[packageIndex] = next;
      if (metadata.scope === "project") {
        this.settingsManager.setProjectPackages(packages);
      } else {
        this.settingsManager.setPackages(packages);
      }
      return;
    }

    const settings = metadata.scope === "project"
      ? this.settingsManager.getProjectSettings()
      : this.settingsManager.getGlobalSettings();
    const patterns = [...(settings.extensions ?? [])].filter((pattern: string) => !matchesPath(pattern));
    if (!enabled) { patterns.push(`-${relativePath}`); }
    if (metadata.scope === "project") {
      this.settingsManager.setProjectExtensionPaths(patterns);
    } else {
      this.settingsManager.setExtensionPaths(patterns);
    }
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
        : "keywords:pi-package";

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

      const packages: MarketplacePackage[] = objects
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

      // The npm search API omits custom package.json fields. Fetch the full
      // manifest for the visible results so official pi.image/pi.video gallery
      // metadata can be rendered in the web sidebar.
      await this.enrichGalleryMetadata(packages.slice(0, 30));
      return packages;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
    } catch (e: any) {
      throw new Error(`Marketplace search failed: ${e.message ?? e}`);
    }
  }

  private async enrichGalleryMetadata(packages: MarketplacePackage[]): Promise<void> {
    await Promise.allSettled(packages.map(async (pkg) => {
      try {
        const name = encodeURIComponent(pkg.npmPackage);
        const version = encodeURIComponent(pkg.version || "latest");
        const response = await fetch(`https://registry.npmjs.org/${name}/${version}`, {
          headers: { "Accept": "application/json" },
          signal: AbortSignal.timeout(5000),
        });
        if (!response.ok) { return; }

        const manifest = await response.json() as Record<string, unknown>;
        const pi = manifest.pi;
        if (!pi || typeof pi !== "object") { return; }
        const gallery = pi as Record<string, unknown>;
        const image = this.safePreviewUrl(gallery.image, "image");
        const video = this.safePreviewUrl(gallery.video, "video");
        if (image) { pkg.imageUrl = image; }
        if (video) { pkg.videoUrl = video; }
      } catch {
        // Preview metadata is optional and must not fail package listing.
      }
    }));
  }

  private safePreviewUrl(value: unknown, kind: "image" | "video"): string | undefined {
    if (typeof value !== "string") { return undefined; }
    try {
      const url = new URL(value);
      if (url.protocol !== "https:") { return undefined; }
      if (kind === "video" && !/\.mp4(?:$|[?#])/i.test(url.href)) { return undefined; }
      if (kind === "image" && !/\.(?:png|jpe?g|gif|webp)(?:$|[?#])/i.test(url.href)) { return undefined; }
      return url.href;
    } catch {
      return undefined;
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
      await this.enrichGalleryMetadata([...enriched.values()]);
    } catch { /* ignore */ }

    return enriched;
  }
}
