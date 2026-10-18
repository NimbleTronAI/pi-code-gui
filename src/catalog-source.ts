// The model catalog the Rust models.json merge is fed from (Design S, phase A).
//
// The rule it serves: on Rust the extension only ADJUSTS models rust-pi already supports, using
// exactly the values Pi itself uses. "Pi's values" means the INSTALLED TypeScript Pi's catalog —
// its bundled models plus whatever overlay its own refresh has stored in the shared
// <agentDir>/models-store.json — because that is what the user's Pi CLI and TypeScript sessions
// show. So `providers()` answers, in this order:
//   - "pi"    the installed Pi's catalog, read through a CATALOG-ONLY ModelRuntime, whatever its age;
//   - "floor" the bundled snapshot (model-registry.generated.json), ONLY when no TS Pi is installed
//             — then the snapshot IS Pi's values;
//   - "none"  anything in between (installed but not ready yet, too old, failed to load): the merge
//             writes nothing this start and the previous models.json stays valid for rust-pi.
//             Writing the floor there would show the CLI values its own Pi does not have.
//
// The catalog-only runtime: `modelsPath` is a file that does not exist (asserted before create), so
// the user's models.json — including what the merge itself wrote — is never read back as catalog,
// and `modelsStorePath` is Pi's shared store, so the CLI and this runtime see the same overlay.
//
// Network (C24): the ONLY network-capable call is refreshInBackground(). It calls Pi's own
// `refresh({ signal })` — never allowNetwork, force or catalogBaseUrl — so Pi decides: PI_OFFLINE,
// its 4 h per-provider TTL and ETags all apply as they do for the CLI. pi.dev is never fetched
// from here directly. create() passes `allowModelNetwork: false`, so loading only restores the
// stored overlay locally (pi-coding-agent 0.80.8 would otherwise refresh over the network inside
// create(), outside our throttle and our start budget). A host throttle on top allows at most one
// refresh per REFRESH_INTERVAL_MS per host; Pi's personalized openrouter catalog has no TTL of its own.
//
// Credentials are READ-ONLY: a refresh can resolve an expiring OAuth token through
// `credentials.modify(updater)`, and the updater calls the provider's token endpoint and rotates
// the refresh token. Here modify never invokes its updater (that provider is skipped), delete does
// nothing, and Pi's AuthStorage is never constructed — it creates auth.json when missing. A
// command-backed or env-templated API key is not resolved by a background refresh: `read` REJECTS
// for it (pi-ai records a per-provider error and skips that provider). Returning "nothing stored"
// instead would make pi-ai fall back to an ambient env key the user's Pi does not use for that
// provider — and store that key's personalized openrouter catalog in the shared store.
// The same holds for an auth.json that EXISTS but cannot be read whole (empty or partial while Pi's
// CLI rewrites it, corrupt, unreadable): read and list reject. Only a missing file is "no credentials".
//
// K7 (shared with scripts/gen-model-registry.mjs): a provider whose connection Pi builds per
// request — a templated or empty baseUrl, a special-auth api, or github-copilot — is excluded, as
// the generator excludes it from the floor. The slim shape is the generator's, field for field;
// the unit test pins both against the floor itself.
//
// vscode-free, but it imports the bundled JSON floor, so plain Node needs the test loader:
// phase E runs it as `node --import ./scripts/vscode-register.mjs` (v4 §5 E).
//
// One shared instance per extension host: phase D calls configureCatalogSource() at activate (with
// the globalState throttle and a globalStorage catalogModelsPath); the Rust merge (phase B) reads
// catalogSource().providers().

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { pathToFileURL } from "node:url";
import { piDebug, piWarn } from "./logger.js";
import { buildPiPackageCandidates, pickPiPackagePath } from "./pi-package-path.js";
import bundledRegistry from "./model-registry.generated.json";

/* eslint-disable @typescript-eslint/no-explicit-any -- the Pi SDK is imported dynamically; its types are unavailable at compile time */

/** One model in the generator's slim shape (model-registry.generated.json). */
export interface SlimModel {
  id: string; name: string; reasoning: boolean; contextWindow: number; maxTokens: number; input: string[];
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  thinkingLevelMap?: Record<string, string | null>;
  compat?: { thinkingFormat?: string; forceAdaptiveThinking?: boolean };
}
export interface SlimProvider { baseUrl: string; api: string; models: SlimModel[] }
export type CatalogProviders = Record<string, SlimProvider>;
/** Per provider, per model id: the connection Pi itself uses for that model. The slim shape keeps one
 *  connection per provider (the generator's); a provider can mix apis and endpoints, and the Rust merge
 *  gates each model it would create on its OWN connection (C29). "pi" snapshots only. */
export type ModelConnections = Record<string, Record<string, { api: string; baseUrl: string }>>;

export type CatalogSnapshot =
  | { kind: "pi"; providers: CatalogProviders; connections: ModelConnections; label: string }
  | { kind: "floor"; providers: CatalogProviders; label: string }
  | { kind: "none"; reason: string; label: string };

/** Where the host throttle's last-refresh time lives (phase D: globalState, so it survives reloads). */
export interface ThrottleStore { get(): number | undefined; set(at: number): void }

export interface CatalogSourceOptions {
  /** The pi-coding-agent package dir. Default: the installed one, resolved as the SDK path resolves it.
   *  The seam phase E uses to point the source at another Pi (0.80.8). */
  piPackagePath?: string;
  /** Pi's agent dir (models-store.json, auth.json). Default: the SDK's own getAgentDir(). */
  agentDir?: string;
  /** The catalog-only runtime's models.json: must NOT exist. Default: under the OS temp dir. */
  catalogModelsPath?: string;
  importModule?: (absPath: string) => Promise<any>;
  throttle?: ThrottleStore;
  now?: () => number;
  log?: { debug(m: string): void; warn(m: string): void };
}

export interface CatalogSource {
  /** Start loading (once) and wait at most `budgetMs` for it; returns providers() after. */
  prepare(budgetMs: number): Promise<CatalogSnapshot>;
  providers(): CatalogSnapshot;
  /** Pi's own catalog refresh: deduped, host-throttled, errors logged — never thrown. */
  refreshInBackground(): Promise<void>;
  /** Abort an in-flight refresh; later calls do nothing. */
  dispose(): void;
}

/** The host throttle: at most one network-capable refresh per this interval (Pi's own TTL). */
export const REFRESH_INTERVAL_MS = 4 * 60 * 60 * 1000;
/** A refresh's own deadline (the CLI's budget for the same call). */
const REFRESH_TIMEOUT_MS = 15_000;

const floorData = bundledRegistry as unknown as { piAiVersion: string; providers: CatalogProviders };

// The generator's exclusion, verbatim (scripts/gen-model-registry.mjs SPECIAL_APIS / SPECIAL_PROVIDERS).
const SPECIAL_APIS = new Set(["bedrock-converse-stream", "azure-openai-responses", "google-vertex", "openai-codex-responses"]);
const SPECIAL_PROVIDERS = new Set(["github-copilot"]);

/** K7: true when a provider's first model has a plain connection rust-pi can be adjusted on. */
export function rustExpressibleProvider(providerId: string, first: { baseUrl?: string; api?: string } | undefined): boolean {
  const baseUrl = first?.baseUrl;
  return !!baseUrl && !baseUrl.includes("{") && !SPECIAL_APIS.has(first?.api ?? "") && !SPECIAL_PROVIDERS.has(providerId);
}

/** Pi's chat models → the generator's slim, per-provider shape (K7 applied). */
export function slimCatalog(models: readonly any[]): CatalogProviders {
  const byProvider = new Map<string, any[]>();
  for (const m of models) {
    if (!m || typeof m.provider !== "string" || typeof m.id !== "string") { continue; }
    let list = byProvider.get(m.provider);
    if (!list) { list = []; byProvider.set(m.provider, list); }
    list.push(m);
  }
  const out: CatalogProviders = {};
  for (const [providerId, list] of byProvider) {
    const first = list[0];
    if (!rustExpressibleProvider(providerId, first)) { continue; }
    out[providerId] = { baseUrl: first.baseUrl, api: first.api, models: list.map(slimModel) };
  }
  return out;
}

/** Pi's chat models → each model's own (api, baseUrl), for every provider (writePi reads only the ones the source keeps). */
export function modelConnections(models: readonly any[]): ModelConnections {
  const out: ModelConnections = {};
  for (const m of models) {
    if (!m || typeof m.provider !== "string" || typeof m.id !== "string" || typeof m.api !== "string" || typeof m.baseUrl !== "string") { continue; }
    (out[m.provider] ??= {})[m.id] = { api: m.api, baseUrl: m.baseUrl };
  }
  return out;
}

function slimModel(m: any): SlimModel {
  const slim: SlimModel = {
    id: m.id,
    name: m.name ?? m.id,
    reasoning: !!m.reasoning,
    contextWindow: m.contextWindow,
    maxTokens: m.maxTokens,
    input: Array.isArray(m.input) && m.input.length ? [...m.input] : ["text"],
  };
  if (m.thinkingLevelMap && typeof m.thinkingLevelMap === "object") { slim.thinkingLevelMap = { ...m.thinkingLevelMap }; }
  const compat: { thinkingFormat?: string; forceAdaptiveThinking?: boolean } = {};
  if (m.compat?.thinkingFormat) { compat.thinkingFormat = m.compat.thinkingFormat; }
  if (typeof m.compat?.forceAdaptiveThinking === "boolean") { compat.forceAdaptiveThinking = m.compat.forceAdaptiveThinking; }
  if (Object.keys(compat).length) { slim.compat = compat; }
  if (m.cost) { slim.cost = { input: m.cost.input, output: m.cost.output, cacheRead: m.cost.cacheRead, cacheWrite: m.cost.cacheWrite }; }
  return slim;
}

/** The installed pi-coding-agent dir, resolved exactly as pi-service.ts resolvePiPackagePath does. */
function defaultPiPackagePath(): string | null {
  let nvmVersions: string[] = [];
  const nvmDir = process.env.NVM_DIR;
  if (nvmDir) {
    try {
      const versionsDir = path.join(nvmDir, "versions", "node");
      if (fs.existsSync(versionsDir)) { nvmVersions = fs.readdirSync(versionsDir); }
    } catch { /* no NVM versions to add */ }
  }
  const candidates = buildPiPackageCandidates({
    platform: process.platform, pathEnv: process.env.PATH || "", appData: process.env.APPDATA,
    home: process.env.HOME || process.env.USERPROFILE, nvmDir, nvmVersions,
  });
  return pickPiPackagePath(candidates, (pkgJson) => { try { return fs.existsSync(pkgJson); } catch { return false; } });
}

const isObj = (v: unknown): v is Record<string, any> => !!v && typeof v === "object" && !Array.isArray(v);

/** A CredentialStore over auth.json that can never write it (see the header). */
function readOnlyCredentials(authPath: string): any {
  // ONLY a missing file (ENOENT) means "no credentials". An auth.json that exists but cannot be read
  // whole — empty or partial because Pi's CLI is rewriting it in place, corrupt, unreadable — THROWS,
  // as Pi's own locked reader does: "nothing stored" would let pi-ai fall back to an ambient env key.
  // The messages never carry file content (it holds keys).
  const load = (): Record<string, any> => {
    let text: string;
    try {
      text = fs.readFileSync(authPath, "utf8");
    } catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") { return {}; }
      throw new Error(`auth.json exists but could not be read (${code ?? "unknown error"}); its credentials are unavailable this cycle`);
    }
    let data: unknown;
    try { data = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); }
    catch { throw new Error("auth.json exists but is empty or not valid JSON (possibly mid-write); its credentials are unavailable this cycle"); }
    if (!isObj(data)) { throw new Error("auth.json exists but is not a JSON object; its credentials are unavailable this cycle"); }
    return data;
  };
  return {
    read: async (providerId: string, options?: { signal?: AbortSignal }) => {
      options?.signal?.throwIfAborted();
      const c = load()[providerId];
      if (!isObj(c)) { return undefined; }
      // A `!command` key would run a shell command; a `$VAR` key is a template Pi resolves itself.
      if (c.type === "api_key" && typeof c.key === "string" && (c.key.startsWith("!") || c.key.includes("$"))) {
        throw new Error(`the stored ${providerId} key is a command or template, left not resolved by a background catalog refresh`);
      }
      return structuredClone(c);
    },
    list: async (options?: { signal?: AbortSignal }) => {
      options?.signal?.throwIfAborted();
      return Object.entries(load()).filter(([, c]) => isObj(c)).map(([providerId, c]) => ({ providerId, type: c.type }));
    },
    modify: async () => undefined, // NEVER invokes its updater
    delete: async () => {},
  };
}

// The default throttle is per extension-host PROCESS (phase D replaces it with globalState so it
// survives reloads). It is set when a refresh STARTS, not when it succeeds: a failing catalog is
// not retried more than once per interval.
let hostLastRefresh: number | undefined;
const hostThrottle: ThrottleStore = { get: () => hostLastRefresh, set: (at) => { hostLastRefresh = at; } };

type State =
  | { s: "idle" } | { s: "loading" } | { s: "absent" }
  | { s: "failed"; reason: string }
  | { s: "ready"; rt: any; version: string };

export function createCatalogSource(opts: CatalogSourceOptions = {}): CatalogSource {
  const log = opts.log ?? { debug: piDebug, warn: piWarn };
  const now = opts.now ?? Date.now;
  const throttle = opts.throttle ?? hostThrottle;
  const importModule = opts.importModule ?? ((p: string) => import(pathToFileURL(p).href));
  // Default: inside a fresh private (0700) temp dir, so no other user can plant a file there.
  let catalogModelsPath = opts.catalogModelsPath;
  const modelsPath = (): string => (catalogModelsPath ??= path.join(fs.mkdtempSync(path.join(os.tmpdir(), "pi-code-gui-catalog-")), "models.json"));
  let state: State = { s: "idle" };
  let loading: Promise<void> | undefined;
  let inflight: Promise<void> | undefined;
  let disposed = false;
  const aborter = new AbortController();

  async function load(): Promise<void> {
    const root = opts.piPackagePath !== undefined ? opts.piPackagePath : defaultPiPackagePath();
    if (!root || !fs.existsSync(path.join(root, "package.json"))) { state = { s: "absent" }; return; }
    try {
      if (fs.existsSync(modelsPath())) {
        throw new Error(`the catalog-only models path exists (${modelsPath()}), so that runtime would read it`);
      }
      const SDK = await importModule(path.join(root, "dist", "index.js"));
      if (typeof SDK?.ModelRuntime?.create !== "function") {
        throw new Error("the installed Pi is too old (it has no ModelRuntime)");
      }
      const agentDir = opts.agentDir ?? (typeof SDK.getAgentDir === "function" ? SDK.getAgentDir() : path.join(os.homedir(), ".pi", "agent"));
      const rt = await SDK.ModelRuntime.create({
        modelsPath: modelsPath(),
        modelsStorePath: path.join(agentDir, "models-store.json"),
        credentials: readOnlyCredentials(path.join(agentDir, "auth.json")),
        allowModelNetwork: false,
      });
      let version: string = typeof SDK.VERSION === "string" ? SDK.VERSION : "";
      if (!version) {
        try { version = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version ?? "unknown"; } catch { version = "unknown"; }
      }
      state = { s: "ready", rt, version };
    } catch (e) {
      state = { s: "failed", reason: e instanceof Error ? e.message : String(e) };
      log.warn(`Model catalog: the installed Pi's catalog could not be loaded — ${state.reason}`);
    }
  }

  // Only "ready" is kept: an absent or failed Pi is looked for again on the next call, so a Pi
  // installed while the window is open is picked up at the next Rust start.
  function start(): Promise<void> {
    if (!loading || state.s === "absent" || state.s === "failed") { state = { s: "loading" }; loading = load(); }
    return loading;
  }

  function providers(): CatalogSnapshot {
    switch (state.s) {
      case "ready":
        try {
          const models = state.rt.getModels();
          return { kind: "pi", providers: slimCatalog(models), connections: modelConnections(models), label: `Pi's catalog (pi-coding-agent ${state.version})` };
        } catch (e) {
          const reason = `the installed Pi's catalog could not be read (${e instanceof Error ? e.message : String(e)})`;
          return { kind: "none", reason, label: `no model catalog this start — ${reason}` };
        }
      case "absent":
        return { kind: "floor", providers: structuredClone(floorData.providers), label: `bundled catalog (pi-ai ${floorData.piAiVersion}) — TypeScript Pi is not installed` };
      case "failed":
        return { kind: "none", reason: state.reason, label: `no model catalog this start — ${state.reason}` };
      default: {
        const reason = "the installed Pi's catalog is not ready yet";
        return { kind: "none", reason, label: `no model catalog this start — ${reason}` };
      }
    }
  }

  async function prepare(budgetMs: number): Promise<CatalogSnapshot> {
    let timer: NodeJS.Timeout | undefined;
    await Promise.race([start(), new Promise<void>((r) => { timer = setTimeout(r, budgetMs); })]);
    clearTimeout(timer);
    return providers();
  }

  async function refresh(): Promise<void> {
    await start();
    if (disposed || state.s !== "ready") { return; }
    // Pi re-reads its models.json on every refresh: if a file appeared at the catalog-only path,
    // this runtime would read it as catalog, so the source stops here.
    if (fs.existsSync(modelsPath())) {
      state = { s: "failed", reason: `the catalog-only models path appeared (${modelsPath()}), so that runtime would read it` };
      log.warn(`Model catalog: ${state.reason}`);
      return;
    }
    throttle.set(now());
    const signal = AbortSignal.any([aborter.signal, AbortSignal.timeout(REFRESH_TIMEOUT_MS)]);
    const result = await state.rt.refresh({ signal });
    const errors = result?.errors instanceof Map ? [...result.errors] : [];
    log.debug(errors.length
      ? `Model catalog refresh: ${errors.map(([p, e]) => `${p}: ${e instanceof Error ? e.message : String(e)}`).join("; ")}`
      : `Model catalog refresh: ok${result?.aborted ? " (aborted)" : ""}`);
  }

  function refreshInBackground(): Promise<void> {
    if (disposed) { return Promise.resolve(); }
    if (inflight) { return inflight; }
    const last = throttle.get();
    if (last !== undefined && now() - last < REFRESH_INTERVAL_MS) {
      log.debug("Model catalog refresh: skipped (refreshed on this host within 4 h)");
      return Promise.resolve();
    }
    inflight = refresh()
      .catch((e) => { log.warn(`Model catalog refresh failed: ${e instanceof Error ? e.message : String(e)}`); })
      .finally(() => { inflight = undefined; });
    return inflight;
  }

  return {
    prepare, providers, refreshInBackground,
    dispose: () => { disposed = true; aborter.abort(); },
  };
}

let shared: CatalogSource | undefined;
/** The extension host's one catalog source (created with defaults on first use). */
export function catalogSource(): CatalogSource { return (shared ??= createCatalogSource()); }
/** Phase D, at activate: replace the shared source with the host's options (throttle, globalStorage path). */
export function configureCatalogSource(o: CatalogSourceOptions): CatalogSource {
  shared?.dispose();
  return (shared = createCatalogSource(o));
}
