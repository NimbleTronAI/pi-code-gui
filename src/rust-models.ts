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
          // Always write `reasoning` (true AND false). pi_agent_rust (gh #117) now
          // treats the catalog as AUTHORITATIVE — it honors this flag directly and
          // only falls back to its built-in model_is_reasoning heuristic when the
          // field is ABSENT. Omitting `false` would re-enable the heuristic and the
          // override bug that disabled thinking for misclassified models (gh #114).
          reasoning: !!m.reasoning,
          // Forward per-model thinking metadata UNDER compat — the shape pi_agent_rust
          // deserializes (model.compat.{thinkingLevelMap,forceAdaptiveThinking,
          // thinkingFormat}, gh #116/#117). thinkingLevelMap clamps graded levels
          // (e.g. DeepSeek off/high/xhigh); forceAdaptiveThinking selects Anthropic's
          // modern adaptive `effort` API over deprecated budget_tokens; thinkingFormat
          // is the wire dialect. A top-level thinkingLevelMap would be silently dropped.
          ...buildThinkingCompat(m),
        };
      }),
    };
  }
  const payload = JSON.stringify({ providers }, null, 2) + "\n";
  // Skip the write when the on-disk catalog is already byte-identical — this runs
  // on EVERY Rust session init, and the content only changes on an extension
  // update (new bundled registry) or a contextBudget change.
  try { if (fs.readFileSync(file, "utf-8") === payload) { return omittedCount; } }
  catch { /* absent/unreadable → write below */ }
  try { fs.writeFileSync(file, payload); }
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
  return seedAuthFrom(path.join(os.homedir(), ".pi", "agent", "auth.json"), path.join(dir, "auth.json"), dir);
}

/**
 * Seed `dst` from the user's real auth.json so OAuth logins apply to the relocated Rust agent
 * home. Exported for tests (the caller derives `src` from the home dir).
 *
 * ALWAYS A REGULAR FILE. A symlink used to be preferred here because it tracks future `/login`s
 * automatically, but rust-pi 0.3.0 refuses to start when auth.json is one:
 *
 *   Error: Authentication error: auth.json: auth.json must be a regular non-link file
 *   Rust process exited immediately (code 1)
 *
 * — a hardening measure against pointing an agent's credentials at an attacker-chosen path. It
 * is a hard failure, not a warning, so the symlink is no longer a preference we can keep as a
 * fast path: on 0.3.0 it means no Rust session starts at all.
 *
 * An existing symlink is therefore MIGRATED to a copy rather than left alone. Every user who
 * ever ran a pre-0.3.0 session has one, so leaving them in place would break exactly the
 * upgrade this pin is for. A regular file is also correct on older binaries, so there is no
 * version gate.
 *
 * The copy is refreshed whenever the source is newer, which is what makes a later `/login`
 * reach Rust — a copy that was never refreshed is the bug this function previously had: a user
 * would run /login, see it succeed, and Rust would keep authenticating with a stale credential
 * forever. Refresh happens at session start, so a login mid-session applies when the session is
 * reopened.
 */
export function seedAuthFrom(src: string, dst: string, dirLabel = ""): string | null {
  // Never seed (or keep) a link to a missing/empty/corrupt source — the binary
  // would just mark it auth.json.corrupt. API keys still resolve from the env.
  if (!isUsableAuth(src)) {
    try {
      const st = fs.lstatSync(dst);
      if (st.isSymbolicLink() || st.size === 0) { fs.unlinkSync(dst); }
    } catch { /* dst absent — nothing to clean up */ }
    return null;
  }

  let dstStat: fs.Stats | null = null;
  try { dstStat = fs.lstatSync(dst); } catch { /* absent */ }

  // MIGRATE a legacy symlink. Every session created before rust-pi 0.3.0 left one here, and on
  // 0.3.0 it is fatal — so this runs before any other decision, and unlinking is the whole point
  // rather than an accident. copyFileSync alone would not do it: it follows the link and writes
  // THROUGH to the user's real ~/.pi/agent/auth.json, leaving the fatal link in place.
  if (dstStat?.isSymbolicLink()) {
    try {
      fs.unlinkSync(dst);
      fs.copyFileSync(src, dst);
      return null;
    } catch (e) {
      return `Couldn't replace the auth.json symlink in "${dirLabel || path.dirname(dst)}": ${msg(e)}. Rust Pi 0.3.0+ refuses to start with a linked auth.json — delete that file and reopen the session.`;
    }
  }

  if (dstStat) {
    // A previous copy: refresh it whenever the source has moved on (i.e. after a new login).
    try {
      const srcM = fs.statSync(src).mtimeMs;
      if (dstStat.mtimeMs < srcM || !fs.existsSync(dst)) { fs.copyFileSync(src, dst); }
      return null;
    } catch (e) {
      return `Couldn't refresh auth.json in "${dirLabel || path.dirname(dst)}": ${msg(e)}. A new \`pi login\` may not apply to Rust (API keys via environment still work).`;
    }
  }

  // Nothing there yet.
  try {
    fs.copyFileSync(src, dst);
    return null;
  }
  catch (e) { return `Couldn't seed auth.json into "${dirLabel || path.dirname(dst)}": ${msg(e)}. OAuth logins won't apply to Rust there (API keys via environment still work).`; }
}

/**
 * Write the bundled model catalog into the Rust agent home and return env
 * additions (PI_CODING_AGENT_DIR) plus non-fatal warnings. Throws RustModelsError
 * on a fatal problem the caller must surface.
 */
/** Re-seed ~/.pi/agent/auth.json into the Rust agent dir. setupRustModels() does this at spawn,
 *  but a mid-session /login writes a credential the already-seeded dir may not reflect. Returns a
 *  warning string, or null when the seed is in place. */
export function reseedRustAuth(): string | null {
  if (!_ctx) { return "Rust models support not initialized."; }
  const dir = resolveAgentDir(_ctx);
  ensureDir(dir);
  return seedAuth(dir);
}

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
