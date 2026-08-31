// Rust model catalog for the extension.
//
// The Rust binary resolves models against a fixed built-in registry that goes
// stale — it predates new models (e.g. deepseek-v4-pro) and carries their wrong
// reasoning flag and no pricing. Rather than make users hand-declare models, this
// module writes a fresh catalog into the binary's models.json, OVERRIDING its
// built-in list with the same registry the TypeScript runtime uses: bundled as
// src/model-registry.generated.json (generated from @earendil-works/pi-ai and kept
// fresh by regenerating with scripts/gen-model-registry.mjs; there is no dependabot.yml,
// so this is a manual step on a pi-ai bump).
//
// We always relocate the Rust agent home (PI_CODING_AGENT_DIR) to a directory we
// own (or pi-code-gui.rustAgentDir), so writing the full catalog never clobbers a
// user's own ~/.pi/agent/models.json (their CLI/TUI setup). auth.json is seeded
// from ~/.pi/agent so OAuth logins carry over; API keys resolve from the
// environment by the binary's provider convention, so no apiKey is written.
//
// Special-auth providers (Bedrock, Azure, Vertex, Copilot, …) are intentionally
// NOT in the catalog — they need non-API-key auth and stay on the binary's native
// handling. For raw, unmanaged control of the Rust model registry, use the Pi CLI.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { piDebug } from "./logger.js";
import { resolveMaxOutputTokens, buildThinkingCompat } from "./model-catalog.js";
import registryData from "./model-registry.generated.json";
import type { ApprovalMode } from "./types.js";
import pkg from "../package.json";

/** This extension's version, for stamping the entries we manage in the user's models.json. */
const EXTENSION_VERSION: string = (pkg as { version?: string }).version ?? "unknown";

interface RegistryModel {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  input: string[];
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  // Per-model thinking metadata (kept by gen-model-registry.mjs). thinkingLevelMap
  // tells rust-pi which graded levels the model honors so it clamps the same way
  // the extension's picker offers them; compat.thinkingFormat is the wire dialect;
  // compat.forceAdaptiveThinking selects Anthropic's modern adaptive `effort` API.
  thinkingLevelMap?: Record<string, string | null>;
  compat?: { thinkingFormat?: string; forceAdaptiveThinking?: boolean };
}
interface RegistryProvider { baseUrl: string; api: string; models: RegistryModel[]; }
interface ModelRegistry { generatedFrom: string; piAiVersion: string; providers: Record<string, RegistryProvider>; }
const registry = registryData as ModelRegistry;

/** A fatal models-setup failure the caller MUST surface (never swallow). */
export class RustModelsError extends Error {}

let _ctx: vscode.ExtensionContext | null = null;
/** Called once in activate() so the module can reach globalStorage. */
export function initRustModels(ctx: vscode.ExtensionContext): void { _ctx = ctx; }

function msg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

/** The Rust agent home: the user's own ~/.pi/agent, shared with the Pi CLI.
 *
 *  It used to be a directory the extension owned — first in globalStorage, briefly under
 *  ~/.pi — purely so that writing the model catalog could never clobber the user's
 *  ~/.pi/agent/models.json. That isolation cost more than it bought: the binary reads
 *  auth.json from ITS agent home, so relocating meant smuggling the credential across, and
 *  every mechanism for that was wrong in a different way.
 *
 *    symlink   0.3.0 refuses to start on one ("auth.json must be a regular non-link file")
 *    copy      OAuth refresh tokens ROTATE, so whichever copy refreshes first invalidates the
 *              other and the user meets "invalid_grant" on a credential they never touched
 *    hard link one file and therefore correct, but silently broken by any writer that saves
 *              atomically, and impossible when ~/.pi is a different filesystem — which made
 *              behaviour depend on the user's disk layout
 *
 *  Sharing the directory removes the problem rather than managing it: one agent home means one
 *  auth.json, so there is nothing to synchronise and nothing to degrade. The clobber concern is
 *  answered instead by writeRustModels MERGING per-model entries and never rewriting the file
 *  wholesale — which is also what Pi itself promises about this file.
 *
 *  `pi-code-gui.rustAgentDir` still overrides, for anyone who does want the pools separate. */
export function defaultRustAgentDir(): string {
  return path.join(os.homedir(), ".pi", "agent");
}

function resolveAgentDir(ctx: vscode.ExtensionContext): string {
  void ctx;
  const setting = vscode.workspace.getConfiguration("pi-code-gui").get<string>("rustAgentDir")?.trim();
  return setting || defaultRustAgentDir();
}

function ensureDir(dir: string): void {
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (e) {
    throw new RustModelsError(`Couldn't create the Rust agent directory "${dir}": ${msg(e)}. Fix permissions, or set the "pi-code-gui.rustAgentDir" setting to a writable path.`);
  }
}

/** Write the bundled catalog into models.json, overriding the binary's built-ins.
 *  contextWindow is clamped to the context budget so auto-compaction fires there;
 *  a model's maxTokens is written only when it's a real output limit (rust-pi
 *  0.1.20 forwards maxTokens to the API verbatim, so the pi-ai placeholder values
 *  that copy the context window 400 as a silent empty turn — those are omitted so
 *  the provider's own default applies). Returns how many maxTokens were omitted. */
/** Auth env keys that do NOT follow the `<ID>_API_KEY` convention, mirroring `pi --list-providers`
 *  for the providers we bundle. Everything else is derived, so a new provider needs no change
 *  here unless it is irregular. */
const AUTH_ENV_OVERRIDES: Record<string, string[]> = {
  "huggingface": ["HF_TOKEN"],
  "moonshotai": ["MOONSHOT_API_KEY", "KIMI_API_KEY"],
  "moonshotai-cn": ["MOONSHOT_API_KEY"],
  "opencode-go": ["OPENCODE_API_KEY"],
  "zai": ["ZHIPU_API_KEY"],
};

/** Env keys that would authenticate `provId`. */
function authEnvKeys(provId: string): string[] {
  return AUTH_ENV_OVERRIDES[provId] ?? [provId.toUpperCase().replace(/-/g, "_") + "_API_KEY"];
}

/**
 * Providers the user can actually authenticate to — from the environment the binary will be
 * given, plus OAuth entries in the shared agent home's auth.json.
 *
 * This is what scopes the catalog we write. Writing all 963 bundled models put half a megabyte
 * into the user's own models.json to describe models they cannot reach: of 32 bundled providers,
 * a typical user has credentials for one or two. Scoping to those keeps the file small enough to
 * read, and makes the model picker offer what can actually be run — the picker is populated from
 * the binary's get_available_models, so it reflects exactly what is in this file plus the
 * binary's built-ins.
 *
 * Providers whose credentials are not env/auth.json shaped (Bedrock's AWS_*, Vertex, Copilot)
 * fall out naturally: they are not in the bundled catalog, and stay on the binary's own handling.
 */
export function providerHasCredential(provId: string, env: NodeJS.ProcessEnv, oauth: Set<string>): boolean {
  if (oauth.has(provId)) { return true; }
  return authEnvKeys(provId).some((k) => (env[k] ?? "").trim() !== "");
}

/** Provider ids with an OAuth entry in the shared agent home's auth.json. */
export function oauthProviders(agentDir: string): Set<string> {
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf-8"));
    return new Set(Object.keys(auth ?? {}));
  } catch { return new Set(); }
}

export function credentialedProviders(env: NodeJS.ProcessEnv, agentDir: string): Set<string> {
  const out = new Set<string>();
  for (const provId of Object.keys(registry.providers)) {
    if (authEnvKeys(provId).some((k) => (env[k] ?? "").trim() !== "")) { out.add(provId); }
  }
  try {
    const auth = JSON.parse(fs.readFileSync(path.join(agentDir, "auth.json"), "utf-8"));
    for (const provId of Object.keys(auth ?? {})) {
      if (provId in registry.providers) { out.add(provId); }
    }
  } catch { /* absent or unparseable — env alone then */ }
  return out;
}

/**
 * Read / write the tool-approval posture in the shared agent home's settings.json.
 *
 * The CLI flags are inert over RPC — `--approval-mode write`, `--approval-mode yolo` and
 * `--yolo` all leave the session in always-ask, so every file edit comes back
 * "Tool execution denied: Approval required in always-ask mode". The config path DOES work, in
 * exactly one shape (measured against 0.3.0): `{"approval": {"mode": "yolo"}}`. A bare
 * `{"approval": "yolo"}` hangs startup and `{"approvalMode": "yolo"}` is ignored.
 *
 * This file is the USER'S, shared with the pi CLI, so the write is surgical: read, set one
 * nested key, write back with everything else preserved. Changing it changes the CLI's posture
 * too — which the UI says out loud rather than hiding.
 */
export function readApprovalMode(agentDir: string): ApprovalMode {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(agentDir, "settings.json"), "utf-8"));
    const m = j?.approval?.mode;
    return m === "yolo" || m === "write" ? m : "always-ask";
  } catch { return "always-ask"; }
}

export function writeApprovalMode(agentDir: string, mode: ApprovalMode): string | null {
  const file = path.join(agentDir, "settings.json");
  try {
    let doc: Record<string, unknown> = {};
    try { doc = JSON.parse(fs.readFileSync(file, "utf-8")) ?? {}; } catch { /* absent or corrupt: start clean */ }
    doc.approval = { ...(doc.approval ?? {}), mode };
    fs.mkdirSync(agentDir, { recursive: true });
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n");
    return null;
  } catch (e) {
    return `Couldn't set the approval mode in "${file}": ${msg(e)}.`;
  }
}

/** Stamped on every entry we manage, so the file stays inspectable: anything carrying this is
 *  ours to refresh, anything without it is the user's and is never touched. Includes the version
 *  so a stale entry can be traced to the release that wrote it. */
export const MANAGED_BY = `pi-code-gui@${EXTENSION_VERSION}`;
const MANAGED_KEY = "_managedBy";

/** Build the entry we'd write for one registry model. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function managedEntry(m: RegistryModel, contextBudget: number): { entry: any; omitted: boolean } {
  // Decide maxTokens against the model's REAL context window (provider validity is judged
  // against the true window, not the budget-clamped one written for compaction). A real
  // sub-window limit is kept verbatim so genuine large outputs survive (e.g. deepseek 384000);
  // a placeholder (>= window) or garbage value is omitted → provider default applies.
  const maxTokens = resolveMaxOutputTokens(m.maxTokens, m.contextWindow);
  return {
    omitted: maxTokens === undefined,
    entry: {
      id: m.id,
      name: m.name,
      contextWindow: contextBudget > 0 ? Math.min(m.contextWindow, contextBudget) : m.contextWindow,
      ...(maxTokens !== undefined ? { maxTokens } : {}),
      input: m.input,
      ...(m.cost ? { cost: m.cost } : {}),
      // Always write `reasoning` (true AND false). pi_agent_rust treats the catalog as
      // AUTHORITATIVE — it honors this flag directly and only falls back to its built-in
      // heuristic when the field is ABSENT. Omitting `false` would re-enable the heuristic and
      // the override bug that disabled thinking for misclassified models.
      reasoning: !!m.reasoning,
      // Per-model thinking metadata UNDER compat — the shape pi_agent_rust deserializes
      // (model.compat.{thinkingLevelMap,forceAdaptiveThinking,thinkingFormat}). A top-level
      // thinkingLevelMap would be silently dropped. This is the metadata a live
      // `--fetch-models` cannot supply, which is why we write entries at all.
      ...buildThinkingCompat(m),
      [MANAGED_KEY]: MANAGED_BY,
    },
  };
}

/**
 * Merge our managed entries into the agent home's models.json, preserving everything else.
 *
 * This file is the USER's — Pi documents it as user-authored and authoritative, loaded after the
 * generated catalog and never rewritten by Pi itself. We now share the agent home rather than
 * relocating it, so replacing the file wholesale (as this once did, with all 854 bundled models)
 * would destroy hand-written provider entries. Instead:
 *
 *   - an entry carrying our marker is ours: refreshed to match the current bundle
 *   - an entry WITHOUT the marker is the user's: left exactly as found, even where it names a
 *     model we also manage. Hand edits win, which is the same promise Pi makes about this file.
 *     To hand-edit one of ours, delete its `_managedBy` line and it stops being managed.
 *   - providers and models we say nothing about are untouched
 *
 * Membership can also come from the binary's own `--fetch-models` (models.fetched.json, loaded
 * first). That is treated as a bonus, never a dependency: its rows are silently dropped when the
 * provider's route shape changes (measured — the models vanish with no warning to the client), so
 * every model we need is written here regardless.
 */
export function mergeModelsJson(file: string, contextBudget: number, only?: Set<string>): { written: number; omitted: number; userOwned: number } {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let doc: any = { providers: {} };
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8"));
    if (parsed && typeof parsed === "object") { doc = parsed; }
  } catch { /* absent or unparseable — start fresh rather than fail the session */ }
  if (!doc.providers || typeof doc.providers !== "object") { doc.providers = {}; }

  let written = 0, omitted = 0, userOwned = 0;
  for (const [provId, prov] of Object.entries(registry.providers)) {
    // Only describe providers the user can authenticate to — see credentialedProviders.
    if (only && !only.has(provId)) { continue; }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const existing: any = doc.providers[provId];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const target: any = existing && typeof existing === "object"
      ? existing
      : (doc.providers[provId] = { baseUrl: prov.baseUrl, api: prov.api, models: [] });
    if (!Array.isArray(target.models)) { target.models = []; }
    // Only fill in connection details we invented; never rewrite a user's own baseUrl/api.
    if (!target.baseUrl) { target.baseUrl = prov.baseUrl; }
    if (!target.api) { target.api = prov.api; }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const byId = new Map<string, any>(target.models.filter((m: any) => m && typeof m.id === "string").map((m: any) => [m.id, m]));
    for (const m of prov.models) {
      const current = byId.get(m.id);
      if (current && current[MANAGED_KEY] === undefined) { userOwned++; continue; }   // theirs — hands off
      const { entry, omitted: om } = managedEntry(m, contextBudget);
      if (om) { omitted++; }
      if (current) { Object.assign(current, entry); } else { target.models.push(entry); }
      written++;
    }
  }

  const payload = JSON.stringify(doc, null, 2) + "\n";
  // Skip the write when nothing changed — this runs on EVERY Rust session init, and the content
  // only moves on an extension update or a contextBudget change.
  try { if (fs.readFileSync(file, "utf-8") === payload) { return { written, omitted, userOwned }; } }
  catch { /* absent/unreadable → write below */ }
  try { fs.writeFileSync(file, payload); }
  catch (e) { throw new RustModelsError(`Couldn't write "${file}": ${msg(e)}. The Rust model catalog won't be available.`); }
  return { written, omitted, userOwned };
}

/**
 * Ensure the agent home is usable for OAuth. Nothing to do when it IS the user's ~/.pi/agent —
 * the binary reads the same auth.json the CLI writes, so a `/login` applies with no copying,
 * linking or refreshing. This exists only for a user-set `rustAgentDir` that points somewhere
 * else: there the credential genuinely is separate, and we say so rather than silently
 * duplicating one (a second copy of an OAuth grant goes stale the moment either side rotates
 * its refresh token).
 */
export function checkAuthAvailable(dir: string): string | null {
  if (path.resolve(dir) === path.resolve(defaultRustAgentDir())) { return null; }
  const own = path.join(dir, "auth.json");
  if (fs.existsSync(own)) { return null; }
  return `The Rust agent home is set to "${dir}", which has no auth.json of its own, so OAuth logins made against ~/.pi/agent do not apply there. Run \`/login\` while a Rust session is active, or clear the "pi-code-gui.rustAgentDir" setting to share ~/.pi/agent. API keys from the environment are unaffected.`;
}

/**
 * Write the bundled model catalog into the Rust agent home and return env
 * additions (PI_CODING_AGENT_DIR) plus non-fatal warnings. Throws RustModelsError
 * on a fatal problem the caller must surface.
 */
/** Called after a mid-session `/login`. With the agent home shared there is nothing to copy —
 *  the credential the SDK just wrote IS the one the binary reads — so this only reports the case
 *  where a user-set rustAgentDir has put the two somewhere different. rust-pi reads auth at
 *  startup either way, so the caller still restarts the session. */
export function reseedRustAuth(): string | null {
  if (!_ctx) { return "Rust models support not initialized."; }
  const dir = resolveAgentDir(_ctx);
  ensureDir(dir);
  return checkAuthAvailable(dir);
}

export function setupRustModels(): { piEnv: Record<string, string>; warnings: string[] } {
  if (!_ctx) { throw new RustModelsError("Rust models support not initialized (internal error)."); }
  const warnings: string[] = [];
  const budget = vscode.workspace.getConfiguration("pi-code-gui").get<number>("contextBudget") ?? 0;
  const dir = resolveAgentDir(_ctx);
  ensureDir(dir);
  const scope = credentialedProviders(process.env, dir);
  const merged = mergeModelsJson(path.join(dir, "models.json"), budget, scope);
  const w = checkAuthAvailable(dir);
  if (w) { warnings.push(w); }
  piDebug(`Rust model catalog: merged ${merged.written} managed entries for ${scope.size} credentialed provider(s) [${[...scope].join(", ") || "none"}] into ${dir}/models.json (budget=${budget}, ${merged.omitted} placeholder maxTokens omitted, ${merged.userOwned} left to the user)`);
  return { piEnv: { PI_CODING_AGENT_DIR: dir }, warnings };
}
