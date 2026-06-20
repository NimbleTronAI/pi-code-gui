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
import { piLog } from "./logger.js";
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
 *  contextWindow is clamped to the context budget so auto-compaction fires there. */
function writeModelsJson(file: string, contextBudget: number): void {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const providers: Record<string, any> = {};
  for (const [provId, prov] of Object.entries(registry.providers)) {
    providers[provId] = {
      baseUrl: prov.baseUrl,
      api: prov.api,
      // No apiKey: the binary resolves provider keys from the environment by
      // convention (verified), so omitting it lets standard env vars just work.
      models: prov.models.map((m) => ({
        id: m.id,
        name: m.name,
        contextWindow: contextBudget > 0 ? Math.min(m.contextWindow, contextBudget) : m.contextWindow,
        maxTokens: m.maxTokens,
        input: m.input,
        ...(m.cost ? { cost: m.cost } : {}),
        ...(m.reasoning ? { reasoning: true } : {}),
      })),
    };
  }
  try { fs.writeFileSync(file, JSON.stringify({ providers }, null, 2) + "\n"); }
  catch (e) { throw new RustModelsError(`Couldn't write "${file}": ${msg(e)}. The Rust model catalog won't be available.`); }
}

/** Make the relocated agent dir usable for OAuth: link/copy ~/.pi/agent/auth.json. */
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
  writeModelsJson(path.join(dir, "models.json"), budget);
  const w = seedAuth(dir);
  if (w) { warnings.push(w); }
  piLog(`Rust model catalog: ${Object.keys(registry.providers).length} providers from pi-ai ${registry.piAiVersion} → ${dir}/models.json (budget=${budget})`);
  return { piEnv: { PI_CODING_AGENT_DIR: dir }, warnings };
}
