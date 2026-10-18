// Rust model catalog for the extension (Design S).
//
// THE RULE (the founder's, C27): on Rust the extension only ADJUSTS models rust-pi already
// supports, using exactly the values Pi itself uses. It never adds providers, never moves
// endpoints, and never shrinks context windows.
//
// So at each Rust session start this module writes ONE kind of thing into the agent home's
// models.json: `providers.<p>.modelOverrides.<id>` = Pi's own per-model values (name, window,
// output limit, prices, input, reasoning, thinking map, two compat flags) plus our `_managedBy`
// stamp. Nothing at provider level, no `models` array, no connection, no context-budget clamp.
// "Pi's values" come from catalogSource() — the installed TypeScript Pi's catalog, or the bundled
// floor when no TS Pi is installed (src/catalog-source.ts). When it has no answer, nothing is
// written and the previous file stays valid for rust-pi.
//
// An override for an id rust-pi does not list makes rust-pi CREATE that model on the connection it
// gives any new model of that provider. That is allowed only where that connection is the one Pi
// uses (C29); src/rust-pi-catalog.generated.json — rust-pi's own ids and that connection per
// provider, measured from the pinned binary by scripts/gen-rust-pi-catalog.mjs — is the evidence.
//
// models.json is the USER'S file, shared with the Pi CLI. Everything we ever wrote carries the
// stamp; everything without it is theirs and is never deleted or rewritten. A file we cannot
// rewrite safely is never written at all, and the user is told once why (rust-pi ignores a file it cannot parse; a read-only one it reads as it is).

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import { piDebug, piWarn } from "./logger.js";
import { catalogSource, type CatalogProviders, type ModelConnections, type SlimModel } from "./catalog-source.js";
import rustPiCatalogData from "./rust-pi-catalog.generated.json";
import type { ApprovalMode } from "./types.js";
import pkg from "../package.json";

/** This extension's version, for stamping the entries we manage in the user's models.json. */
const EXTENSION_VERSION: string = (pkg as { version?: string }).version ?? "unknown";

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
 *  answered instead by mergeModelsJson writing only stamped per-model overrides and never
 *  rewriting anything it did not write — which is also what Pi itself promises about this file.
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
 * Whether the user can authenticate to `provId` — from the environment the binary will be given,
 * or an OAuth entry in the shared agent home's auth.json. Used by the Rust service's credential
 * predicate (stale-model recovery); it does NOT scope what models.json describes — rust-pi lists
 * only providers it has credentials for, so every provider is written (Design S, C26 NEW-1).
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

/** Stamped on every value we write, so the file stays inspectable: anything carrying it is ours to
 *  replace, anything without it is the user's and is never touched. Includes the version so an
 *  entry can be traced to the release that wrote it. */
export const MANAGED_BY = `pi-code-gui@${EXTENSION_VERSION}`;
const MANAGED_KEY = "_managedBy";

/** rust-pi's own catalog, per provider of Pi's: the ids it lists with no models.json of ours, and
 *  the connection it gives a model it does NOT list. Generated; see scripts/gen-rust-pi-catalog.mjs. */
export interface RustPiCatalog {
  rustPi: string;
  providers: Record<string, { newModel: { api: string; baseUrl: string }; ids: string[] }>;
}
export const RUST_PI_CATALOG = rustPiCatalogData as RustPiCatalog;

/**
 * K1 — every (api, baseUrl) an earlier release wrote into a provider object (git history
 * v0.2.0..0.2.8; the opencode / opencode-go `openai-completions …/zen[/go]/v1` pairs come from the
 * v0.1.x registries, which wrote to globalStorage — kept, as they equal rust-pi's own connection). Those releases wrote connections unstamped, so the only way to tell ours from a
 * user's is "an object holding only our models[] entries, on a pair we shipped". Frozen: this
 * release never writes a connection again.
 */
const SHIPPED_PAIRS: Record<string, ReadonlyArray<readonly [string, string]>> = {
  "ant-ling": [["openai-completions", "https://api.ant-ling.com/v1"]],
  "anthropic": [["anthropic-messages", "https://api.anthropic.com"]],
  "baseten": [["openai-completions", "https://inference.baseten.co/v1"]],
  "cerebras": [["openai-completions", "https://api.cerebras.ai/v1"]],
  "deepseek": [["openai-completions", "https://api.deepseek.com"]],
  "fireworks": [["anthropic-messages", "https://api.fireworks.ai/inference"]],
  "google": [["google-generative-ai", "https://generativelanguage.googleapis.com/v1beta"]],
  "groq": [["openai-completions", "https://api.groq.com/openai/v1"]],
  "huggingface": [["openai-completions", "https://router.huggingface.co/v1"]],
  "kimi-coding": [["anthropic-messages", "https://api.kimi.com/coding"], ["openai-completions", "https://api.kimi.com/coding/v1"]],
  "meta": [["openai-responses", "https://api.meta.ai/v1"]],
  "minimax": [["anthropic-messages", "https://api.minimax.io/anthropic"]],
  "minimax-cn": [["anthropic-messages", "https://api.minimaxi.com/anthropic"]],
  "mistral": [["mistral-conversations", "https://api.mistral.ai"]],
  "moonshotai": [["openai-completions", "https://api.moonshot.ai/v1"]],
  "moonshotai-cn": [["openai-completions", "https://api.moonshot.cn/v1"]],
  "nvidia": [["openai-completions", "https://integrate.api.nvidia.com/v1"]],
  "openai": [["openai-responses", "https://api.openai.com/v1"]],
  "opencode": [["anthropic-messages", "https://opencode.ai/inference"], ["anthropic-messages", "https://opencode.ai/zen"], ["openai-completions", "https://opencode.ai/zen/v1"]],
  "opencode-go": [["anthropic-messages", "https://opencode.ai/inference/go"], ["anthropic-messages", "https://opencode.ai/zen/go"], ["openai-completions", "https://opencode.ai/zen/go/v1"]],
  "openrouter": [["anthropic-messages", "https://openrouter.ai/api"], ["openai-completions", "https://openrouter.ai/api/v1"]],
  "qwen-token-plan": [["openai-completions", "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1"]],
  "qwen-token-plan-cn": [["openai-completions", "https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1"]],
  "qwen-token-plan-individual": [["openai-completions", "https://token-plan.ap-southeast-1.maas.aliyuncs.com/compatible-mode/v1"]],
  "radius": [["pi-messages", "https://radius.pi.dev/v1"]],
  "together": [["openai-completions", "https://api.together.ai/v1"]],
  "vercel-ai-gateway": [["anthropic-messages", "https://ai-gateway.vercel.sh"]],
  "xai": [["openai-completions", "https://api.x.ai/v1"], ["openai-responses", "https://api.x.ai/v1"]],
  "xiaomi": [["openai-completions", "https://api.xiaomimimo.com/v1"]],
  "xiaomi-token-plan-ams": [["openai-completions", "https://token-plan-ams.xiaomimimo.com/v1"]],
  "xiaomi-token-plan-cn": [["openai-completions", "https://token-plan-cn.xiaomimimo.com/v1"]],
  "xiaomi-token-plan-sgp": [["openai-completions", "https://token-plan-sgp.xiaomimimo.com/v1"]],
  "zai": [["openai-completions", "https://api.z.ai/api/coding/paas/v4"]],
  "zai-coding-cn": [["openai-completions", "https://open.bigmodel.cn/api/coding/paas/v4"]],
};

/** K10 — every key any release ever wrote inside a stamped entry or override. A stamped value
 *  holding any other key was edited by the user: it becomes theirs, whole. */
const WROTE = {
  top: new Set(["id", "name", "contextWindow", "maxTokens", "input", "cost", "reasoning", "thinkingLevelMap", "compat", MANAGED_KEY]),
  cost: new Set(["input", "output", "cacheRead", "cacheWrite"]),
  compat: new Set(["thinkingFormat", "forceAdaptiveThinking", "thinkingLevelMap"]),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const isObj = (v: unknown): v is Record<string, Json> => !!v && typeof v === "object" && !Array.isArray(v);
const ours = (v: unknown): boolean => isObj(v) && v[MANAGED_KEY] !== undefined;
const onlyKeys = (v: unknown, allowed: Set<string>): boolean => !isObj(v) || Object.keys(v).every((k) => allowed.has(k));
/** K10: drop our stamp from a stamped value the user has added a key to. */
function adoptIfEdited(v: Json): void {
  if (ours(v) && !(onlyKeys(v, WROTE.top) && onlyKeys(v.cost, WROTE.cost) && onlyKeys(v.compat, WROTE.compat))) { delete v[MANAGED_KEY]; }
}
/** K3: rust-pi 0.8.0 merges a bare key into `<provider>/x` (measured for openrouter's auto; `deepseek/x` and bare nvidia ids stay distinct), so we write LESS, never more: for our own and your ids `x` and `<provider>/x` are compared as one. Never used to decide what rust-pi lists. */
const oneId = (pid: string, id: unknown): unknown =>
  typeof id === "string" && id.startsWith(`${pid}/`) && !id.slice(pid.length + 1).includes("/") ? id.slice(pid.length + 1) : id;
/** rust-pi reports an anthropic-messages endpoint with the `/v1/messages` path the protocol
 *  appends; Pi's base URL names the same endpoint without it (measured on 0.8.0). */
const endpoint = (api: string, baseUrl: string): string =>
  `${api} ${api === "anthropic-messages" ? baseUrl.replace(/\/v1\/messages$/, "") : baseUrl}`;

/** K4–K6: what one override carries — Pi's per-model values, in the form rust-pi reads as Pi does. */
function overrideOf(m: SlimModel): Json {
  // K4: a placeholder output limit (>= the window) is left out; rust-pi would send it verbatim.
  const maxTokens = Number.isFinite(m.maxTokens) && m.maxTokens > 0 && m.maxTokens < m.contextWindow ? m.maxTokens : undefined;
  // K5: string levels only — a null level ("unsupported" in Pi) makes rust-pi reject the whole file.
  const map: Record<string, string> = {};
  for (const [level, value] of Object.entries(m.thinkingLevelMap ?? {})) { if (typeof value === "string") { map[level] = value; } }
  const compat: Json = {};
  if (m.compat?.thinkingFormat) { compat.thinkingFormat = m.compat.thinkingFormat; }
  if (typeof m.compat?.forceAdaptiveThinking === "boolean") { compat.forceAdaptiveThinking = m.compat.forceAdaptiveThinking; }
  return {
    ...(m.name !== undefined ? { name: m.name } : {}),
    contextWindow: m.contextWindow,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    ...(m.input !== undefined ? { input: m.input } : {}),
    ...(m.cost ? { cost: { input: m.cost.input, output: m.cost.output, cacheRead: m.cost.cacheRead, cacheWrite: m.cost.cacheWrite } } : {}),
    reasoning: !!m.reasoning,
    ...(Object.keys(map).length ? { thinkingLevelMap: map } : {}),
    ...(Object.keys(compat).length ? { compat } : {}),
    [MANAGED_KEY]: MANAGED_BY,
  };
}

/** K8: a shape either runtime rejects, at every level we read or write. */
function shapeOk(doc: Json): boolean {
  if (!isObj(doc)) { return false; }
  if (doc.providers === undefined) { return true; }
  if (!isObj(doc.providers)) { return false; }
  return Object.values(doc.providers).every((p) => isObj(p)
    && (p.models === undefined || (Array.isArray(p.models) && p.models.every(isObj)))
    && (p.modelOverrides === undefined || (isObj(p.modelOverrides) && Object.values(p.modelOverrides).every(isObj))));
}

/** STEP 1 — remove everything we wrote (K1, K10, K11). Mutates `doc`. */
function removeOurs(doc: Json): void {
  if (!isObj(doc.providers)) { return; }
  for (const [pid, obj] of Object.entries<Json>(doc.providers)) {
    const had = Object.keys(obj).length;
    if (Array.isArray(obj.models)) { obj.models.forEach(adoptIfEdited); }
    if (isObj(obj.modelOverrides)) { Object.values(obj.modelOverrides).forEach(adoptIfEdited); }
    // K1: an object an older release filled — our models[] entries and none of the user's — got
    // its connection from us, iff that connection is a pair we shipped for this provider.
    if (Array.isArray(obj.models) && obj.models.some(ours) && obj.models.every(ours)
      && (SHIPPED_PAIRS[pid] ?? []).some(([api, url]) => api === obj.api && url === obj.baseUrl)) {
      delete obj.api; delete obj.baseUrl;
    }
    // K11: a container our removal empties was ours.
    if (Array.isArray(obj.models) && obj.models.some(ours)) {
      obj.models = obj.models.filter((m: Json) => !ours(m));
      if (!obj.models.length) { delete obj.models; }
    }
    if (isObj(obj.modelOverrides) && Object.values(obj.modelOverrides).some(ours)) {
      for (const [id, v] of Object.entries(obj.modelOverrides)) { if (ours(v)) { delete obj.modelOverrides[id]; } }
      if (!Object.keys(obj.modelOverrides).length) { delete obj.modelOverrides; }
    }
    delete obj[MANAGED_KEY]; // 0.2.8-pre stamped provider objects; nothing else we would remove is left in them
    if (had && !Object.keys(obj).length) { delete doc.providers[pid]; } // TS Pi rejects an empty provider object
  }
}

/** STEP 2 — write Pi's values for every source model rust-pi can take as Pi does. Mutates `doc`. */
function writePi(doc: Json, source: CatalogProviders, rust: RustPiCatalog, connections?: ModelConnections): { written: number; notCreated: string[] } {
  let written = 0;
  const notCreated: string[] = [];
  for (const [pid, prov] of Object.entries(source)) {
    const r = rust.providers[pid];
    // A provider rust-pi does not list has nothing to adjust (C27 give-up 1).
    if (!r || !prov.models?.length) { continue; }
    const existing: Json = isObj(doc.providers?.[pid]) ? doc.providers[pid] : undefined;
    // B-1. rust-pi lists none of its built-ins for a provider object carrying a `models` array (measured,
    // 0.8.0), and a new model there takes the object's own api/baseUrl: such an object is the user's catalog,
    // so we create nothing in it. An object that sets its own baseUrl or api likewise: only what rust-pi lists.
    const usersCatalog = Array.isArray(existing?.models);
    const usersConnection = existing?.api !== undefined || existing?.baseUrl !== undefined;
    const own = usersCatalog ? new Set<unknown>() : new Set<unknown>(r.ids); // exact ids: rust-pi merges `x` with `<p>/x` only for openrouter's auto (measured), so oneId is not used here
    // C29: a model rust-pi lacks is created on r.newModel; allowed only when that is Pi's own
    // connection FOR THAT MODEL (a provider can mix apis and endpoints; the slim provider-level pair is
    // only its first model's, and is used only where no per-model connection is known — the floor).
    const rustNew = endpoint(r.newModel.api, r.newModel.baseUrl);
    const createOk = (id: string): boolean => {
      const c = connections?.[pid]?.[id] ?? prov;
      return endpoint(c.api, c.baseUrl) === rustNew;
    };
    // K2: an id the user defines in this provider (models[] or modelOverrides) is theirs.
    const yours = new Set<unknown>([
      ...(Array.isArray(existing?.models) ? existing.models.map((m: Json) => oneId(pid, m?.id)) : []),
      ...Object.keys(isObj(existing?.modelOverrides) ? existing.modelOverrides : {}).map((id) => oneId(pid, id)),
    ]);
    const ids = new Set(prov.models.map((m) => m.id));
    for (const m of prov.models) {
      if (oneId(pid, m.id) === m.id && oneId(pid, `${pid}/${m.id}`) === m.id && ids.has(`${pid}/${m.id}`)) { continue; } // K3: the prefixed twin carries it
      if (yours.has(oneId(pid, m.id))) { continue; }
      if (!own.has(m.id) && (usersCatalog || usersConnection || !createOk(m.id))) { notCreated.push(`${pid}/${m.id}`); continue; }
      if (!isObj(doc.providers)) { doc.providers = {}; }
      const target: Json = isObj(doc.providers[pid]) ? doc.providers[pid] : (doc.providers[pid] = {});
      if (!isObj(target.modelOverrides)) { target.modelOverrides = {}; }
      target.modelOverrides[m.id] = overrideOf(m);
      written++;
    }
  }
  return { written, notCreated };
}

type UnsafeReason = "read" | "readonly" | "bom" | "parse" | "shape";
const PLAIN_JSON_FIX = "save it as plain JSON (no comments, no trailing commas, UTF-8 without a byte-order mark)";

/** The one message a user sees about a models.json we will not touch (K8, C28(4)). */
function unsafeMessage(file: string, reason: UnsafeReason, code?: string): string {
  // A read-only file is one rust-pi DOES read, so it gets its own sentence, not "Rust Pi ignores it".
  if (reason === "readonly" && code === "folder") {
    return `Your models.json (\`${file}\`) cannot be updated because its folder is read-only, so the extension has not changed it, and Rust sessions use it exactly as it is. To let the extension keep Rust Pi's model details current, make the folder writable, then start a new Rust session.`;
  }
  if (reason === "readonly") {
    return `Your models.json (\`${file}\`) is read-only, so the extension has not changed it, and Rust sessions use it exactly as it is. To let the extension keep Rust Pi's model details current, make it writable, then start a new Rust session.`;
  }
  const [why, fix] = {
    read: [`could not be read (${code ?? "unknown error"})`, "make it a readable file (check its permissions)"],
    bom: ["starts with a byte-order mark", PLAIN_JSON_FIX],
    parse: ["isn't plain JSON (it may have comments, trailing commas or a syntax error)", PLAIN_JSON_FIX],
    shape: ["isn't shaped like a models file", "make the file, its \"providers\" and each provider JSON objects, each \"models\" a list and each \"modelOverrides\" an object"],
  }[reason];
  return `Your models.json (\`${file}\`) ${why}. Rust Pi ignores a file like that completely — including any custom providers in it — so Rust sessions use only Rust Pi's built-in models. The extension has not changed the file. To fix it, ${fix}, then start a new Rust session.`;
}

/** The file's current text, or null when it does not exist. Other errors throw. */
function readText(file: string): string | null {
  try { return fs.readFileSync(file, "utf-8"); }
  catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") { throw e; }
    // A symlink to a missing file is the user's link, not "no file": writing would replace it.
    let link = false;
    try { link = fs.lstatSync(file).isSymbolicLink(); } catch { /* truly absent */ }
    if (link) { throw e; }
    return null;
  }
}

/** SF-1/SF-B: what stops us writing `file` safely — the file itself read-only, or (the temp-file rename
 *  needs the DIRECTORY's permission) its folder. Follows a symlink. Checked only when a write is due. */
function unwritable(file: string): "file" | "folder" | null {
  let target = file;
  try {
    target = fs.realpathSync(file);
    if ((fs.statSync(target).mode & 0o222) === 0) { return "file"; }
    fs.accessSync(target, fs.constants.W_OK);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") { return "file"; }
  }
  try { fs.accessSync(path.dirname(target), fs.constants.W_OK); } catch { return "folder"; }
  return null;
}

export interface MergeOptions {
  /** rust-pi's own catalog (default: the generated one for the pinned binary). */
  rust?: RustPiCatalog;
  /** Pi's own connection per model (a "pi" snapshot's); absent → the provider's (the floor's shape). */
  connections?: ModelConnections;
  /** Test seam: runs after the temp file is written and before the check-and-rename. */
  beforeRename?: () => void;
}
export type MergeResult =
  | { outcome: "written" | "unchanged"; written: number; notCreated: string[] }
  | { outcome: "unsafe"; reason: UnsafeReason; message: string }
  | { outcome: "raced" };

/**
 * Merge Pi's values into models.json (v4 §2). Pure in (file, source): the content written depends
 * only on those, so two windows starting Rust together converge on the same bytes.
 *
 *   - unsafe file (K8): never written; the result carries the message for the user
 *   - STEP 1: everything we ever wrote is removed (K1 migration, K10, K11)
 *   - STEP 2: Pi's values are written as stamped overrides (K2–K6, C29)
 *   - no semantic change: nothing is written, so the user's formatting is never touched for nothing
 *   - otherwise a temp file is renamed over it — unless the file changed since we read it (an
 *     editor save, another window): then we start over once, and after a second change we skip
 */
export function mergeModelsJson(file: string, source: CatalogProviders, opts: MergeOptions = {}): MergeResult {
  const rust = opts.rust ?? RUST_PI_CATALOG;
  for (let attempt = 0; attempt < 2; attempt++) {
    let text: string | null;
    try { text = readText(file); }
    catch (e) { return { outcome: "unsafe", reason: "read", message: unsafeMessage(file, "read", (e as NodeJS.ErrnoException)?.code) }; }
    let doc: Json = {};
    if (text !== null) {
      if (text.charCodeAt(0) === 0xfeff) { return { outcome: "unsafe", reason: "bom", message: unsafeMessage(file, "bom") }; }
      try { doc = JSON.parse(text); }
      catch { return { outcome: "unsafe", reason: "parse", message: unsafeMessage(file, "parse") }; }
      if (!shapeOk(doc)) { return { outcome: "unsafe", reason: "shape", message: unsafeMessage(file, "shape") }; }
    }
    const before = JSON.stringify(doc);
    removeOurs(doc);
    const { written, notCreated } = writePi(doc, source, rust, opts.connections);
    if (JSON.stringify(doc) === before) { return { outcome: "unchanged", written, notCreated }; }
    const blocked = unwritable(file);
    if (blocked) { return { outcome: "unsafe", reason: "readonly", message: unsafeMessage(file, "readonly", blocked) }; }
    if (replaceIfUnchanged(file, JSON.stringify(doc, null, 2) + "\n", text, opts.beforeRename)) {
      return { outcome: "written", written, notCreated };
    }
  }
  return { outcome: "raced" };
}

/** Atomically replace `file` with `payload` iff its bytes still equal `expected` (null = absent).
 *  A symlinked models.json is written through to its target, and the file keeps its permissions. */
function replaceIfUnchanged(file: string, payload: string, expected: string | null, beforeRename?: () => void): boolean {
  let target = file;
  let mode: number | undefined;
  try { target = fs.realpathSync(file); mode = fs.statSync(target).mode & 0o7777; }
  catch { /* absent: a new file with default permissions */ }
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.pi-code-gui-${process.pid}.tmp`);
  try {
    fs.writeFileSync(tmp, payload, mode !== undefined ? { mode } : {});
    if (mode !== undefined) { fs.chmodSync(tmp, mode); }
    beforeRename?.();
    let changed: boolean;
    try { changed = readText(file) !== expected; } catch { changed = true; }
    if (changed) { fs.rmSync(tmp, { force: true }); return false; }
    fs.renameSync(tmp, target);
    return true;
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw new RustModelsError(`Couldn't write "${file}": ${msg(e)}. Rust sessions will use the models it already describes.`);
  }
}

const unsafeWarned = new Set<UnsafeReason>(); // one notice per reason per window

/**
 * Prepare the Rust agent home for a spawn: merge Pi's values into models.json (rust-pi reads it
 * only at startup) and return env additions (PI_CODING_AGENT_DIR) plus non-fatal warnings.
 * Throws RustModelsError on a fatal problem the caller must surface. Called from
 * RustService.initialize via pi-service's `setupModels` dep — the ONLY place models.json is
 * written (C28(2)).
 */
export function setupRustModels(): { piEnv: Record<string, string>; warnings: string[] } {
  if (!_ctx) { throw new RustModelsError("Rust models support not initialized (internal error)."); }
  const warnings: string[] = [];
  const dir = resolveAgentDir(_ctx);
  ensureDir(dir);
  const file = path.join(dir, "models.json");
  const snap = catalogSource().providers();
  if (snap.kind === "none") {
    piDebug(`Rust model catalog: models.json left as it is this start — ${snap.label}`);
  } else {
    const r = mergeModelsJson(file, snap.providers, { connections: snap.kind === "pi" ? snap.connections : undefined });
    if (r.outcome === "unsafe") {
      piWarn(`Rust model catalog: ${r.message}`);
      if (!unsafeWarned.has(r.reason)) { unsafeWarned.add(r.reason); warnings.push(r.message); }
    } else if (r.outcome === "raced") {
      piWarn(`Rust model catalog: ${file} kept changing while it was being merged, so it was left as it is this start.`);
    } else {
      piDebug(`Rust model catalog from ${snap.label}: ${r.outcome}, ${r.written} override(s) in ${file}` +
        (r.notCreated.length ? `; ${r.notCreated.length} model(s) not offered because rust-pi would reach them on another endpoint or protocol than Pi (${r.notCreated.slice(0, 5).join(", ")}${r.notCreated.length > 5 ? ", …" : ""})` : ""));
    }
  }
  const w = checkAuthAvailable(dir);
  if (w) { warnings.push(w); }
  // PI_MAX_TOOL_ITERATIONS: rust-pi stops a turn at 50 tool calls by default and reports
  // `stopReason: "error"`, cutting long work off mid-task. 0 leaves the binary's default alone
  // rather than pinning us to a number that could drift out from under the setting.
  const piEnv: Record<string, string> = { PI_CODING_AGENT_DIR: dir };
  const maxIters = vscode.workspace.getConfiguration("pi-code-gui").get<number>("maxToolIterations") ?? 0;
  if (Number.isInteger(maxIters) && maxIters > 0) { piEnv.PI_MAX_TOOL_ITERATIONS = String(maxIters); }
  return { piEnv, warnings };
}
