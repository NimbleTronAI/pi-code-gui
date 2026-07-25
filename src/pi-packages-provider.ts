import * as vscode from "vscode";
import type { PiPackageService, InstalledPackage, MarketplacePackage } from "./pi-package-service.js";

export interface PackageWebItem {
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

export interface PackageWebState {
  ready: boolean;
  loading: boolean;
  error?: string;
  query: string;
  installed: PackageWebItem[];
  marketplace: PackageWebItem[];
}

function sourceLabel(source: string): string {
  if (source.startsWith("npm:")) { return source.slice(4); }
  if (source.startsWith("git:")) {
    const repository = source.slice(4).split("@")[0];
    return repository.split("/").pop() ?? source;
  }
  return source;
}

/** State provider for the Packages section in the unified sidebar webview. */
export class PiPackagesProvider {
  private readonly changeEmitter = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changeEmitter.event;

  private installed: InstalledPackage[] = [];
  private installedEnriched = new Map<string, MarketplacePackage>();
  private marketplace: MarketplacePackage[] = [];
  private marketplaceLoading = false;
  private marketplaceError: string | null = null;
  private searchQueryValue = "";
  private updatesAvailable = new Set<string>();

  constructor(private readonly packageService: PiPackageService) {}

  get searchQuery(): string { return this.searchQueryValue; }

  async refreshInstalled(): Promise<void> {
    this.loadInstalled();
    await Promise.all([this.loadUpdates(), this.loadInstalledMetadata()]);
    this.changeEmitter.fire();
  }

  async refreshAll(searchQuery?: string): Promise<void> {
    const explicitSearch = searchQuery !== undefined;
    if (explicitSearch) { this.searchQueryValue = searchQuery; }
    await this.refreshInstalled();
    if (explicitSearch || this.marketplace.length === 0) {
      await this.searchMarketplace();
    }
    this.changeEmitter.fire();
  }

  getWebState(): PackageWebState {
    const installedSources = new Set(this.installed.map((pkg) => pkg.source));
    const installed = this.installed.map((pkg): PackageWebItem => {
      const metadata = this.installedEnriched.get(pkg.source);
      return {
        source: pkg.source,
        name: metadata?.npmPackage ?? sourceLabel(pkg.source),
        description: metadata?.description ?? "",
        version: metadata?.version,
        publisher: metadata?.publisher,
        license: metadata?.license,
        downloads: metadata?.downloads,
        scope: pkg.scope,
        installed: true,
        updateAvailable: this.updatesAvailable.has(pkg.source),
        repository: metadata?.repository,
        homepage: metadata?.homepage,
        imageUrl: metadata?.imageUrl ?? metadata?.bannerUrl,
        videoUrl: metadata?.videoUrl,
      };
    });
    const marketplace = this.marketplace.slice(0, 30).map((pkg): PackageWebItem => {
      const source = `npm:${pkg.npmPackage}`;
      return {
        source,
        name: pkg.npmPackage,
        description: pkg.description,
        version: pkg.version,
        publisher: pkg.publisher,
        license: pkg.license,
        downloads: pkg.downloads,
        installed: installedSources.has(source),
        updateAvailable: false,
        repository: pkg.repository,
        homepage: pkg.homepage,
        imageUrl: pkg.imageUrl ?? pkg.bannerUrl,
        videoUrl: pkg.videoUrl,
      };
    });
    return {
      ready: this.packageService.isReady,
      loading: this.marketplaceLoading,
      error: this.marketplaceError ?? undefined,
      query: this.searchQueryValue,
      installed,
      marketplace,
    };
  }

  showError(message: string): void {
    this.marketplaceError = message;
    this.changeEmitter.fire();
  }

  private loadInstalled(): void {
    try {
      this.installed = this.packageService.listInstalled();
    } catch {
      this.installed = [];
    }
  }

  private async loadUpdates(): Promise<void> {
    this.updatesAvailable.clear();
    try {
      for (const update of await this.packageService.checkForUpdates()) {
        this.updatesAvailable.add(update.source);
      }
    } catch {
      // Update availability is optional metadata.
    }
  }

  private async loadInstalledMetadata(): Promise<void> {
    try {
      this.installedEnriched = await this.packageService.enrichInstalledPackages(this.installed);
      for (const metadata of this.installedEnriched.values()) {
        this.loadFallbackImage(metadata);
      }
    } catch {
      this.installedEnriched.clear();
    }
  }

  private async searchMarketplace(): Promise<void> {
    this.marketplaceLoading = true;
    this.marketplaceError = null;
    this.changeEmitter.fire();
    try {
      this.marketplace = await this.packageService.searchMarketplace(this.searchQueryValue);
      this.changeEmitter.fire();
      for (const metadata of this.marketplace.slice(0, 30)) {
        this.loadFallbackImage(metadata);
      }
    } catch (error: unknown) {
      this.marketplaceError = error instanceof Error ? error.message : String(error);
      this.marketplace = [];
    } finally {
      this.marketplaceLoading = false;
      this.changeEmitter.fire();
    }
  }

  private loadFallbackImage(metadata: MarketplacePackage): void {
    if (
      !metadata.repository ||
      metadata.imageUrl ||
      metadata.videoUrl ||
      metadata.bannerUrl
    ) {
      return;
    }
    void this.packageService.fetchBannerImage(metadata.repository).then((url) => {
      if (url) {
        metadata.bannerUrl = url;
        this.changeEmitter.fire();
      }
    });
  }
}
