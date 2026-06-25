// Rust model catalog for the extension.
//
// The Rust binary resolves models against a fixed built-in registry that goes
// stale — it predates new models (e.g. deepseek-v4-pro) and carries their wrong
// reasoning flag and no pricing. Rather than make users hand-declare models, this
// module writes a fresh catalog into the binary's models.json, OVERRIDING its
// built-in list with the same registry the TypeScript runtime uses: bundled as
// src/model-registry.generated.json (generated from @earendil-works/pi-ai and kept
// fresh by Dependabot — see scripts/gen-model-registry.mjs).
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
import { resolveMaxOutputTokens } from "./rust-catalog.js";
import registryData from "./model-registry.generated.json";

interface RegistryModel {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  input: string[];
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
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

/** Where the Rust agent home (and thus models.json) lives — always our own dir so
 *  writing the full catalog never clobbers a user's ~/.pi/agent. */
function resolveAgentDir(ctx: vscode.ExtensionContext): string {
  const setting = vscode.workspace.getConfiguration("pi-code-gui").get<string>("rustAgentDir")?.trim();
  return setting || path.join(ctx.globalStorageUri.fsPath, "rust-agent");
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
function writeModelsJson(file: string, contextBudget: number): number {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const providers: Record<string, any> = {};
  let omittedCount = 0;
  for (const [provId, prov] of Object.entries(registry.providers)) {
    providers[provId] = {
      baseUrl: prov.baseUrl,
      api: prov.api,
      // No apiKey: the binary resolves provider keys from the environment by
      // convention (verified), so omitting it lets standard env vars just work.
      models: prov.models.map((m) => {
        // Decide maxTokens against the model's REAL context window (provider
        // validity is judged against the true window, not the budget-clamped one
        // written for compaction). A real sub-window limit is kept verbatim so
        // genuine large outputs survive (e.g. deepseek 384000); a placeholder
        // (>= window) or garbage value is omitted → provider default applies.
        const maxTokens = resolveMaxOutputTokens(m.maxTokens, m.contextWindow);
        if (maxTokens === undefined) { omittedCount++; }
        return {
          id: m.id,
          name: m.name,
          contextWindow: contextBudget > 0 ? Math.min(m.contextWindow, contextBudget) : m.contextWindow,
          ...(maxTokens !== undefined ? { maxTokens } : {}),
          input: m.input,
          ...(m.cost ? { cost: m.cost } : {}),
          ...(m.reasoning ? { reasoning: true } : {}),
        };
      }),
    };
  }
  try { fs.writeFileSync(file, JSON.stringify({ providers }, null, 2) + "\n"); }
  catch (e) { throw new RustModelsError(`Couldn't write "${file}": ${msg(e)}. The Rust model catalog won't be available.`); }
  return omittedCount;
}

/** True if `file` holds parseable, non-empty auth JSON. A 0-byte or corrupt
 *  source makes the binary write auth.json.corrupt on startup, so we refuse to
 *  seed (or keep a link) from one. */
function isUsableAuth(file: string): boolean {
  try {
    const raw = fs.readFileSync(file, "utf-8").trim();
    if (!raw) { return false; }
    JSON.parse(raw);
    return true;
  } catch { return false; }
}

/** Make the relocated agent dir usable for OAuth: link/copy ~/.pi/agent/auth.json. */
function seedAuth(dir: string): string | null {
  const src = path.join(os.homedir(), ".pi", "agent", "auth.json");
  const dst = path.join(dir, "auth.json");
  // Never seed (or keep) a link to a missing/empty/corrupt source — the binary
  // would just mark it auth.json.corrupt. API keys still resolve from the env.
  if (!isUsableAuth(src)) {
    try {
      const st = fs.lstatSync(dst);
      if (st.isSymbolicLink() || st.size === 0) { fs.unlinkSync(dst); }
    } catch { /* dst absent — nothing to clean up */ }
    return null;
  }
  if (fs.existsSync(dst)) { return null; }
  try { fs.symlinkSync(src, dst); return null; }
  catch {
    try { fs.copyFileSync(src, dst); return `Copied auth.json into "${dir}" (symlink unavailable) — it won't track future logins; re-run after \`pi login\`.`; }
    catch (e) { return `Couldn't seed auth.json into "${dir}": ${msg(e)}. OAuth logins won't apply to Rust there (API keys via environment still work).`; }
  }
}

/**
 * Write the bundled model catalog into the Rust agent home and return env
 * additions (PI_CODING_AGENT_DIR) plus non-fatal warnings. Throws RustModelsError
 * on a fatal problem the caller must surface.
 */
export function setupRustModels(): { piEnv: Record<string, string>; warnings: string[] } {
  if (!_ctx) { throw new RustModelsError("Rust models support not initialized (internal error)."); }
  const warnings: string[] = [];
  const budget = vscode.workspace.getConfiguration("pi-code-gui").get<number>("contextBudget") ?? 0;
  const dir = resolveAgentDir(_ctx);
  ensureDir(dir);
  const omitted = writeModelsJson(path.join(dir, "models.json"), budget);
  const w = seedAuth(dir);
  if (w) { warnings.push(w); }
  piDebug(`Rust model catalog: ${Object.keys(registry.providers).length} providers from pi-ai ${registry.piAiVersion} → ${dir}/models.json (budget=${budget}, ${omitted} placeholder maxTokens omitted → provider default)`);
  return { piEnv: { PI_CODING_AGENT_DIR: dir }, warnings };
}
