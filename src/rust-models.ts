// Custom-model support for the Rust runtime.
//
// Rust resolves models against a fixed built-in registry, so a model it doesn't
// know (e.g. a brand-new id, or any OpenAI-compatible endpoint) won't resolve —
// unlike the TypeScript SDK, which passes any id straight through. Rust's escape
// hatch is a `models.json` ({ "providers": { … } }) in its agent home. This
// module turns the `pi-code-gui.rustCustomModels` setting into that file.
//
// Placement (the `pi-code-gui.rustAgentDir` setting overrides all of this):
//   1. setting set            → use it (relocate via PI_CODING_AGENT_DIR; seed auth.json)
//   2. else ~/.pi/agent exists → use it (NO relocation; merge into its models.json)
//   3. else                   → globalStorage/rust-agent (relocate; seed auth.json)
//
// In the shared case (2) we MERGE: models.json is strict JSON (no comment fences),
// so we track the (provider,id) pairs we manage in globalState and only ever touch
// those — user-authored entries are preserved. Nothing here is ever swallowed: a
// bad dir/permission/JSON error throws RustModelsError (surfaced loudly by the
// caller); softer problems (a skipped entry, an auth-seed miss) are returned as
// warnings. This file is Rust-only — the TypeScript SDK never reads models.json.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { piLog } from "./logger.js";

export interface RustCustomModel {
  provider: string;
  id: string;
  baseUrl: string;
  api: string;
  apiKeyEnv?: string;
  contextWindow?: number;
  maxTokens?: number;
  name?: string;
  reasoning?: boolean;
}

/** A fatal models-setup failure the caller MUST surface (never swallow). */
export class RustModelsError extends Error {}

interface ManagedRef { provider: string; id: string; }
const MANAGED_KEY = "pi-code-gui.managedRustModelIds";

let _ctx: vscode.ExtensionContext | null = null;
/** Called once in activate() so the module can reach globalState + globalStorage. */
export function initRustModels(ctx: vscode.ExtensionContext): void { _ctx = ctx; }

function msg(e: unknown): string { return e instanceof Error ? e.message : String(e); }

/** Read + validate the rustCustomModels setting; returns valid specs and per-entry warnings. */
function readCustomModels(): { models: RustCustomModel[]; warnings: string[] } {
  const raw = vscode.workspace.getConfiguration("pi-code-gui").get<unknown[]>("rustCustomModels") ?? [];
  const models: RustCustomModel[] = [];
  const warnings: string[] = [];
  raw.forEach((entry, i) => {
    if (!entry || typeof entry !== "object") { warnings.push(`Custom model #${i + 1}: not an object — skipped.`); return; }
    const e = entry as Record<string, unknown>;
    const str = (k: string): string => { const v = e[k]; return typeof v === "string" ? v.trim() : ""; };
    const missing = ["provider", "id", "baseUrl", "api"].filter((k) => !str(k));
    if (missing.length) { warnings.push(`Custom model #${i + 1} ("${str("id") || "?"}"): missing ${missing.join(", ")} — skipped.`); return; }
    models.push({
      provider: str("provider"), id: str("id"), baseUrl: str("baseUrl"), api: str("api"),
      apiKeyEnv: str("apiKeyEnv") || undefined,
      contextWindow: typeof e.contextWindow === "number" ? e.contextWindow : undefined,
      maxTokens: typeof e.maxTokens === "number" ? e.maxTokens : undefined,
      name: typeof e.name === "string" ? e.name : undefined,
      reasoning: e.reasoning === true,
    });
  });
  return { models, warnings };
}

/** Resolve where Rust's agent home (and thus models.json) should live. */
function resolveAgentDir(ctx: vscode.ExtensionContext): { dir: string; relocate: boolean } {
  const setting = vscode.workspace.getConfiguration("pi-code-gui").get<string>("rustAgentDir")?.trim();
  if (setting) { return { dir: setting, relocate: true }; }
  const home = path.join(os.homedir(), ".pi", "agent");
  if (fs.existsSync(home)) { return { dir: home, relocate: false }; }
  return { dir: path.join(ctx.globalStorageUri.fsPath, "rust-agent"), relocate: true };
}

function ensureDir(dir: string): void {
  try { fs.mkdirSync(dir, { recursive: true }); }
  catch (e) {
    throw new RustModelsError(`Couldn't create the Rust agent directory "${dir}": ${msg(e)}. Fix permissions, or set the "pi-code-gui.rustAgentDir" setting to a writable path.`);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type ModelsRoot = { providers: Record<string, any> };

/** Merge the managed models into models.json, preserving user-authored entries.
 *  When a context budget is set, the written contextWindow is clamped to it so
 *  the Rust runtime's auto-compaction threshold (contextWindow − reserveTokens)
 *  fires at the budget for these CUSTOM models — genuine parity with TS, which
 *  clamps the active model's contextWindow directly. The clamp is unconditional
 *  (it applies in the shared ~/.pi/agent dir too), so the budget behaves
 *  identically everywhere rather than varying by agent dir.
 *
 *  Scope: this only covers models we write here. Built-in Rust models live in the
 *  binary's static registry and never reach models.json, so their REAL compaction
 *  trigger can't be clamped from the extension (only by shadowing the built-in,
 *  which we refuse to do). For those, the GUI clamps the context-% DISPLAY in
 *  pi-service.ts applyRustState instead — see the limitation note there. */
function applyManagedModels(ctx: vscode.ExtensionContext, file: string, models: RustCustomModel[], contextBudget: number): void {
  const prev = ctx.globalState.get<ManagedRef[]>(MANAGED_KEY, []);
  let root: ModelsRoot = { providers: {} };
  if (fs.existsSync(file)) {
    let raw: string;
    try { raw = fs.readFileSync(file, "utf-8"); }
    catch (e) { throw new RustModelsError(`Couldn't read "${file}": ${msg(e)}.`); }
    if (raw.trim()) {
      try { root = JSON.parse(raw) as ModelsRoot; }
      catch (e) { throw new RustModelsError(`"${file}" is not valid JSON (${msg(e)}). Refusing to overwrite it — fix or remove the file.`); }
    }
    if (!root || typeof root !== "object") { root = { providers: {} }; }
    if (!root.providers || typeof root.providers !== "object") { root.providers = {}; }
  }

  // Remove only the entries WE previously wrote (so setting removals take effect, no dupes).
  for (const ref of prev) {
    const p = root.providers[ref.provider];
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    if (p && Array.isArray(p.models)) { p.models = p.models.filter((m: any) => m?.id !== ref.id); }
  }

  // Add current managed models.
  const nowManaged: ManagedRef[] = [];
  for (const m of models) {
    let p = root.providers[m.provider];
    if (!p || typeof p !== "object") {
      p = root.providers[m.provider] = { baseUrl: m.baseUrl, api: m.api, models: [] };
      if (m.apiKeyEnv) { p.apiKey = `env:${m.apiKeyEnv}`; }
    } else {
      // Existing (possibly user-authored) provider — only fill gaps, don't clobber.
      if (!p.baseUrl) { p.baseUrl = m.baseUrl; }
      if (!p.api) { p.api = m.api; }
      if (m.apiKeyEnv && !p.apiKey) { p.apiKey = `env:${m.apiKeyEnv}`; }
      if (!Array.isArray(p.models)) { p.models = []; }
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    p.models = p.models.filter((x: any) => x?.id !== m.id);
    const declaredCw = m.contextWindow ?? 128000;
    const effectiveCw = contextBudget > 0 ? Math.min(declaredCw, contextBudget) : declaredCw;
    if (effectiveCw !== declaredCw) {
      piLog(`Rust custom model ${m.provider}/${m.id}: contextWindow clamped ${declaredCw} → ${effectiveCw} by contextBudget`);
    }
    p.models.push({
      id: m.id, name: m.name ?? m.id,
      contextWindow: effectiveCw, maxTokens: m.maxTokens ?? 8192,
      input: ["text"], ...(m.reasoning ? { reasoning: true } : {}),
    });
    nowManaged.push({ provider: m.provider, id: m.id });
  }

  // Drop providers left with no models (e.g. when the user removed all of ours):
  // an empty provider entry is useless and can shadow a built-in provider.
  for (const prov of Object.keys(root.providers)) {
    const p = root.providers[prov];
    if (p && Array.isArray(p.models) && p.models.length === 0) { delete root.providers[prov]; }
  }

  try { fs.writeFileSync(file, JSON.stringify(root, null, 2) + "\n"); }
  catch (e) { throw new RustModelsError(`Couldn't write "${file}": ${msg(e)}. Custom models won't be available to Rust.`); }
  void ctx.globalState.update(MANAGED_KEY, nowManaged);
}

/** Make the relocated agent dir usable for auth: link/copy ~/.pi/agent/auth.json. */
function seedAuth(dir: string): string | null {
  const src = path.join(os.homedir(), ".pi", "agent", "auth.json");
  const dst = path.join(dir, "auth.json");
  if (!fs.existsSync(src) || fs.existsSync(dst)) { return null; }
  try { fs.symlinkSync(src, dst); return null; }
  catch {
    try { fs.copyFileSync(src, dst); return `Copied auth.json into "${dir}" (symlink unavailable) — it won't track future logins; re-run after \`pi login\`.`; }
    catch (e) { return `Couldn't seed auth.json into "${dir}": ${msg(e)}. OAuth logins won't apply to Rust there (API keys via environment still work).`; }
  }
}

/**
 * Ensure the Rust agent dir holds a models.json reflecting `rustCustomModels`.
 * Returns env additions (PI_CODING_AGENT_DIR when relocating) and non-fatal
 * warnings. Throws RustModelsError on a fatal problem the caller must surface.
 */
export function setupRustModels(): { piEnv: Record<string, string>; warnings: string[] } {
  if (!_ctx) { throw new RustModelsError("Rust models support not initialized (internal error)."); }
  const { models, warnings } = readCustomModels();
  const prev = _ctx.globalState.get<ManagedRef[]>(MANAGED_KEY, []);

  // Nothing configured now or previously → don't touch anything.
  if (models.length === 0 && prev.length === 0) { return { piEnv: {}, warnings }; }

  const contextBudget = vscode.workspace.getConfiguration("pi-code-gui").get<number>("contextBudget") ?? 0;
  const { dir, relocate } = resolveAgentDir(_ctx);
  ensureDir(dir);
  applyManagedModels(_ctx, path.join(dir, "models.json"), models, contextBudget);
  piLog(`Rust custom models: ${models.length} managed in ${dir}/models.json (relocate=${relocate}, budget=${contextBudget})`);

  const piEnv: Record<string, string> = {};
  if (relocate) {
    const w = seedAuth(dir);
    if (w) { warnings.push(w); }
    piEnv.PI_CODING_AGENT_DIR = dir;
  }
  return { piEnv, warnings };
}
