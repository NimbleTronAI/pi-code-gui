// Removes the model entries earlier releases of this extension wrote into the user's own Pi
// models.json, and nothing else.
//
// Pi Code Gui 0.2.0–0.2.3 wrote stamped entries into `providers.<p>.models[]` of
// ~/.pi/agent/models.json (whatever PI_CODING_AGENT_DIR said), and filled in an unstamped
// connection (`api` + `baseUrl`) on the provider object; the 0.2.8 pre-releases wrote stamped
// `providers.<p>.modelOverrides.<id>` values and, briefly, a provider-level stamp. Pi itself
// reads that same file — a provider-level `baseUrl` there is forced onto every built-in model of
// the provider — so the entries outlive the feature that wrote them. Nothing writes them once
// this release lands: the code that wrote them is removed in the same release.
//
// THE RULE: an object whose `_managedBy` is a string starting `pi-code-gui@` is ours and goes —
// unless the user has since added a key we never write, which makes it theirs (kept whole, stamp
// and all). A connection goes only from an object that held our models[] entries and nothing else,
// and only when it is a pair we shipped for that provider. A container or provider object our
// removal empties goes with it. Everything else in the file is the user's and is kept value for
// value, key for key, in order.
//
// The file is never written when there is nothing to remove, nor when it is not strict JSON in the
// shape of a models file, nor when it (or its folder) is read-only: the result says why, and the
// caller logs it. A write is a temp file renamed over the original, only if the original has not
// changed since it was read.

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import { isDeepStrictEqual } from "node:util";

const MANAGED_KEY = "_managedBy";
const STAMP_PREFIX = "pi-code-gui@";
const PRODUCT = "Pi Code Gui";

/**
 * Every (api, baseUrl) pair an earlier release wrote, unstamped, into a provider object
 * (git history v0.2.0..0.2.8; the opencode / opencode-go `openai-completions …/zen[/go]/v1` pairs
 * come from the v0.1.x registries). The only way to tell such a connection from a user's is "an
 * object holding only our models[] entries, on a pair we shipped". Frozen: nothing writes one again.
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

/** Every key any release ever wrote inside a stamped entry or override. A stamped value holding
 *  any other key was edited by the user: it is theirs, whole. */
const WROTE = {
  top: new Set(["id", "name", "contextWindow", "maxTokens", "input", "cost", "reasoning", "thinkingLevelMap", "compat", MANAGED_KEY]),
  cost: new Set(["input", "output", "cacheRead", "cacheWrite"]),
  compat: new Set(["thinkingFormat", "forceAdaptiveThinking", "thinkingLevelMap"]),
};

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
const isObj = (v: unknown): v is Record<string, Json> => !!v && typeof v === "object" && !Array.isArray(v);
/** Carries our stamp (a foreign or non-string `_managedBy` is not ours). */
const ours = (v: unknown): boolean => isObj(v) && typeof v[MANAGED_KEY] === "string" && v[MANAGED_KEY].startsWith(STAMP_PREFIX);
const onlyKeys = (v: unknown, allowed: Set<string>): boolean => !isObj(v) || Object.keys(v).every((k) => allowed.has(k));
/** Carries a key we never wrote: the user edited it, so it is theirs. */
const edited = (v: Json): boolean => !(onlyKeys(v, WROTE.top) && onlyKeys(v.cost, WROTE.cost) && onlyKeys(v.compat, WROTE.compat));
const removable = (v: unknown): boolean => ours(v) && !edited(v);

/** A shape Pi rejects, at every level this module reads. */
function shapeOk(doc: Json): boolean {
  if (!isObj(doc)) { return false; }
  if (doc.providers === undefined) { return true; }
  if (!isObj(doc.providers)) { return false; }
  return Object.values(doc.providers).every((p) => isObj(p)
    && (p.models === undefined || (Array.isArray(p.models) && p.models.every(isObj)))
    && (p.modelOverrides === undefined || (isObj(p.modelOverrides) && Object.values(p.modelOverrides).every(isObj))));
}

/** Remove what we wrote from `doc` (mutates it); name each removal, and each stamped value kept as the user's. */
function removeOurs(doc: Json, removed: string[], kept: string[]): void {
  if (!isObj(doc.providers)) { return; }
  for (const [pid, obj] of Object.entries<Json>(doc.providers)) {
    const had = Object.keys(obj).length;
    const models: Json[] | undefined = Array.isArray(obj.models) ? obj.models : undefined;
    const overrides: Record<string, Json> | undefined = isObj(obj.modelOverrides) ? obj.modelOverrides : undefined;
    for (const m of models ?? []) { if (ours(m) && edited(m)) { kept.push(`${pid}/${String(m.id)} (models)`); } }
    for (const [id, v] of Object.entries(overrides ?? {})) { if (ours(v) && edited(v)) { kept.push(`${pid}/${id} (modelOverrides)`); } }
    // An object an older release filled — our models[] entries and none of the user's — got its
    // connection from us, iff that connection is a pair we shipped for this provider.
    if (models?.length && models.every(removable)
      && (SHIPPED_PAIRS[pid] ?? []).some(([api, url]) => api === obj.api && url === obj.baseUrl)) {
      delete obj.api; delete obj.baseUrl;
      removed.push(`${pid} connection (api, baseUrl)`);
    }
    if (models?.some(removable)) {
      for (const m of models) { if (removable(m)) { removed.push(`${pid}/${String(m.id)} (models)`); } }
      obj.models = models.filter((m) => !removable(m));
      if (!obj.models.length) { delete obj.models; } // a container our removal empties was ours
    }
    if (overrides && Object.values(overrides).some(removable)) {
      for (const [id, v] of Object.entries(overrides)) { if (removable(v)) { delete overrides[id]; removed.push(`${pid}/${id} (modelOverrides)`); } }
      if (!Object.keys(overrides).length) { delete obj.modelOverrides; }
    }
    if (ours(obj)) { delete obj[MANAGED_KEY]; removed.push(`${pid} provider stamp`); } // the 0.2.8 pre-releases stamped provider objects
    // Pi rejects an empty provider object; one the user left empty is theirs and stays.
    if (had && !Object.keys(obj).length) { delete doc.providers[pid]; removed.push(`${pid} (emptied provider)`); }
  }
}

export type UnsafeReason = "read" | "encoding" | "bom" | "parse" | "shape" | "value" | "readonly";
export type CleanupResult =
  | { outcome: "unchanged"; why: "absent" | "nothing-ours" }
  | { outcome: "unchanged"; why: "kept-only"; kept: string[] }
  | { outcome: "removed"; removed: string[]; kept: string[] }
  | { outcome: "unsafe"; reason: UnsafeReason; message: string }
  | { outcome: "raced" }
  | { outcome: "failed"; message: string };
export interface CleanupOptions {
  /** Test seam: runs after the temp file is written and before the check-and-rename. */
  beforeRename?: () => void;
}

const PLAIN_JSON_FIX = "save it as plain JSON (no comments, no trailing commas, UTF-8 without a byte-order mark)";
const MARK = `(marked "${MANAGED_KEY}": "${STAMP_PREFIX}…")`;
const OURS_DESC = `the model entries earlier versions of ${PRODUCT} added to it ${MARK}`;
const OURS_SHORT = `the model entries earlier versions of ${PRODUCT} added ${MARK}`;

/** The one message about a models.json this module will not write. */
function unsafeMessage(file: string, reason: UnsafeReason, code?: string): string {
  const after = "The file has not been changed. To have them removed";
  if (reason === "read") {
    // Its content is unknown: say only that it could not be checked.
    return `Your models.json (\`${file}\`) could not be read (${code ?? "unknown error"}), so ${PRODUCT} could not check it for the model entries earlier versions may have added ${MARK}. The file has not been changed. To have it checked, make it a readable file (check its permissions) and reload the window.`;
  }
  if (reason === "readonly") {
    const where = code ? `cannot be updated because the folder \`${code}\` is read-only` : "is read-only";
    return `Your models.json (\`${file}\`) ${where}, so ${PRODUCT} could not remove ${OURS_DESC}. ${after}, make it writable and reload the window, or delete those entries yourself.`;
  }
  const [why, fix] = {
    encoding: ["isn't valid UTF-8 text", PLAIN_JSON_FIX],
    bom: ["starts with a byte-order mark", PLAIN_JSON_FIX],
    parse: ["isn't plain JSON (it may have comments, trailing commas or a syntax error)", PLAIN_JSON_FIX],
    value: ["holds a value that cannot be written back unchanged (such as a number too large for JSON)", "correct that value"],
    shape: ["isn't shaped like a models file", "make the file, its \"providers\" and each provider JSON objects, each \"models\" a list and each \"modelOverrides\" an object"],
  }[reason];
  return `Your models.json (\`${file}\`) ${why}, so ${PRODUCT} could not remove ${OURS_DESC}. ${after}, ${fix} and reload the window, or delete those entries yourself.`;
}

/** What stops a safe write of `file`: the file itself read-only, or (the temp-file rename needs the
 *  DIRECTORY's permission) its folder. Follows a symlink. Checked only when a write is due. */
function unwritable(file: string): { folder?: string } | null {
  let target = file;
  try {
    target = fs.realpathSync(file);
    if ((fs.statSync(target).mode & 0o222) === 0) { return {}; }
    fs.accessSync(target, fs.constants.W_OK);
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== "ENOENT") { return {}; }
  }
  // The folder that matters is the TARGET's: that is where the temp file is written and renamed.
  try { fs.accessSync(path.dirname(target), fs.constants.W_OK); } catch { return { folder: path.dirname(target) }; }
  return null;
}

const errText = (e: unknown): string => (e instanceof Error ? e.message : String(e));

/** Atomically replace `file` with `payload` iff its bytes still equal `expected`. A symlinked
 *  models.json is written through to its target, and the file keeps its permissions. Throws on a
 *  write error, after removing the temp file; the original is untouched until the rename. */
function replaceIfUnchanged(file: string, payload: string, expected: string, beforeRename?: () => void): boolean {
  const target = fs.realpathSync(file);
  const mode = fs.statSync(target).mode & 0o7777;
  // Unpredictable, and created exclusively ("wx" never follows or reuses an existing path), so a
  // file or symlink planted in the folder is never written through.
  const tmp = path.join(path.dirname(target), `.${path.basename(target)}.pi-code-gui-${process.pid}-${randomBytes(6).toString("hex")}.tmp`);
  try {
    fs.writeFileSync(tmp, payload, { mode, flag: "wx" });
    fs.chmodSync(tmp, mode);
    beforeRename?.();
    let changed: boolean;
    try { changed = fs.readFileSync(file, "utf-8") !== expected; } catch { changed = true; }
    if (changed) { fs.rmSync(tmp, { force: true }); return false; }
    fs.renameSync(tmp, target);
    return true;
  } catch (e) {
    try { fs.rmSync(tmp, { force: true }); } catch { /* best effort */ }
    throw e;
  }
}

/**
 * Remove from `file` the entries earlier releases of this extension wrote (see THE RULE above).
 * Pure apart from fs. Idempotent: a second run finds nothing and writes nothing. When the file
 * changes between read and rename (an editor save, another window) it starts over once from the new
 * bytes, and after a second change it leaves the file alone (`raced`).
 */
export function cleanupManagedModels(file: string, opts: CleanupOptions = {}): CleanupResult {
  for (let attempt = 0; attempt < 2; attempt++) {
    let bytes: Buffer;
    try { bytes = fs.readFileSync(file); }
    catch (e) {
      const code = (e as NodeJS.ErrnoException)?.code;
      if (code === "ENOENT") { return { outcome: "unchanged", why: "absent" }; } // a dangling symlink too: nothing to remove
      return { outcome: "unsafe", reason: "read", message: unsafeMessage(file, "read", code) };
    }
    const text = bytes.toString("utf-8");
    // Every stamp ever written holds this text literally (JSON.stringify never escapes "@"), so a
    // file without it has nothing of ours — and is not parsed, so a hand-commented file is not nagged.
    if (!text.includes(STAMP_PREFIX)) { return { outcome: "unchanged", why: "nothing-ours" }; }
    // Invalid UTF-8 would be rewritten as U+FFFD: the user's bytes would not survive.
    if (!Buffer.from(text, "utf-8").equals(bytes)) { return { outcome: "unsafe", reason: "encoding", message: unsafeMessage(file, "encoding") }; }
    if (text.charCodeAt(0) === 0xfeff) { return { outcome: "unsafe", reason: "bom", message: unsafeMessage(file, "bom") }; }
    let doc: Json;
    try { doc = JSON.parse(text); }
    catch { return { outcome: "unsafe", reason: "parse", message: unsafeMessage(file, "parse") }; }
    if (!shapeOk(doc)) { return { outcome: "unsafe", reason: "shape", message: unsafeMessage(file, "shape") }; }
    const before = JSON.stringify(doc);
    const removed: string[] = [];
    const kept: string[] = [];
    removeOurs(doc, removed, kept);
    if (JSON.stringify(doc) === before) {
      return kept.length ? { outcome: "unchanged", why: "kept-only", kept } : { outcome: "unchanged", why: "nothing-ours" };
    }
    // The format every 0.2.x writer emitted, so a file one of them last wrote changes only by what is removed.
    const payload = JSON.stringify(doc, null, 2) + "\n";
    // A value JSON cannot carry back (1e400 parses to Infinity and is written as null) would change.
    if (!isDeepStrictEqual(JSON.parse(payload), doc)) { return { outcome: "unsafe", reason: "value", message: unsafeMessage(file, "value") }; }
    const blocked = unwritable(file);
    if (blocked) { return { outcome: "unsafe", reason: "readonly", message: unsafeMessage(file, "readonly", blocked.folder) }; }
    try {
      if (replaceIfUnchanged(file, payload, text, opts.beforeRename)) { return { outcome: "removed", removed, kept }; }
    } catch (e) {
      return { outcome: "failed", message: `Couldn't remove ${OURS_SHORT} from "${file}": ${errText(e)}. The file has not been changed.` };
    }
  }
  return { outcome: "raced" };
}

/**
 * Pi's models.json, resolved as the installed Pi resolves it (`getAgentDir()` in its config.js,
 * `normalizePath()` in its utils/paths.js — @earendil-works/pi-coding-agent, MIT © 2025 Mario
 * Zechner): a non-empty PI_CODING_AGENT_DIR, with `~` / `~/…` expanded and a `file://` URL
 * converted (and, on Windows, an MSYS/Cygwin/WSL drive path made native), else `<home>/.pi/agent`.
 * `home` exists so tests never touch the real home.
 */
export function managedModelsFile(env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): string {
  const dir = env.PI_CODING_AGENT_DIR;
  return path.join(dir ? piNormalizePath(dir, home) : path.join(home, ".pi", "agent"), "models.json");
}

function piNormalizePath(input: string, home: string): string {
  const win = process.platform === "win32";
  let p = input;
  if (win && p.startsWith("/") && !p.startsWith("//") && !p.includes("\\")) {
    const m = /^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i.exec(p);
    if (m) { p = `${m[1].toUpperCase()}:\\${m[2]?.replaceAll("/", "\\") ?? ""}`; }
  }
  if (p === "~") { return home; }
  if (p.startsWith("~/") || (win && p.startsWith("~\\"))) { return path.join(home, p.slice(2)); }
  if (/^file:\/\//.test(p)) { return fileURLToPath(p); }
  return p;
}

export interface CleanupLog { info(message: string): void; warn(message: string): void; debug(message: string): void }

/**
 * The activation entry: clean Pi's models.json, and also `<home>/.pi/agent/models.json` when
 * PI_CODING_AGENT_DIR points elsewhere — that is where 0.2.x wrote, whatever the variable said.
 * Logs each file's outcome once (info on a removal, a warning when a file could not be cleaned,
 * debug otherwise). Never throws: it runs fire-and-forget from activate().
 */
export function cleanupManagedModelsAtStartup(log: CleanupLog, env: NodeJS.ProcessEnv = process.env, home: string = os.homedir()): void {
  const files = new Map<string, string>();
  for (const f of [managedModelsFile(env, home), managedModelsFile({}, home)]) { if (!files.has(path.resolve(f))) { files.set(path.resolve(f), f); } }
  for (const file of files.values()) {
    try { report(log, file, cleanupManagedModels(file)); }
    catch (e) { try { log.warn(`Couldn't check "${file}" for ${OURS_SHORT}: ${errText(e)}`); } catch { /* the logger itself failed */ } }
  }
}

function report(log: CleanupLog, file: string, r: CleanupResult): void {
  const list = (xs: string[]): string => xs.slice(0, 20).join(", ") + (xs.length > 20 ? `, … (${xs.length - 20} more)` : "");
  switch (r.outcome) {
    case "removed":
      log.info(`Removed from ${file} what earlier versions of ${PRODUCT} wrote there: ${list(r.removed)}` +
        (r.kept.length ? `. Kept, because you edited them: ${list(r.kept)}` : ""));
      return;
    case "unchanged":
      log.debug(`${file}: nothing earlier versions of ${PRODUCT} wrote is left to remove (${r.why})` +
        (r.why === "kept-only" ? `; kept, because you edited them: ${list(r.kept)}` : ""));
      return;
    case "raced":
      log.warn(`${file} kept changing while ${OURS_SHORT} were being removed, so it was left as it is; this is tried again at the next window start.`);
      return;
    case "unsafe":
    case "failed":
      log.warn(r.message);
      return;
  }
}
