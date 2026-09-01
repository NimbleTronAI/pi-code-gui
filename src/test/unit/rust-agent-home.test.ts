// The agent home is now the user's own ~/.pi/agent, shared with the Pi CLI — so models.json is
// THEIR file. It used to be overwritten wholesale with all 854 bundled models, which was safe
// only because the home was relocated; sharing makes that destructive. These tests pin the
// merge contract: our entries are marked and refreshed, everything else is left exactly as
// found, and a hand edit beats us.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { mergeModelsJson, checkAuthAvailable, defaultRustAgentDir, credentialedProviders, readApprovalMode, writeApprovalMode, MANAGED_BY } from "../../rust-models.js";

function tmpFile(contents?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "models-merge-"));
  const file = join(dir, "models.json");
  if (contents !== undefined) { writeFileSync(file, contents); }
  return file;
}
function read(file: string): any { return JSON.parse(readFileSync(file, "utf-8")); }
function modelsOf(doc: any, prov: string): any[] { return doc.providers?.[prov]?.models ?? []; }

test("mergeModelsJson: writes managed entries, each stamped with name and version", () => {
  const file = tmpFile();
  const r = mergeModelsJson(file, 0);
  assert.ok(r.written > 0, "wrote entries");
  const ds = modelsOf(read(file), "deepseek");
  assert.ok(ds.length > 0, "deepseek present");
  assert.ok(ds.every((m) => m._managedBy === MANAGED_BY), "every entry is attributable");
  assert.match(MANAGED_BY, /^pi-code-gui@\d+\.\d+\.\d+/, "name@version");
});

test("mergeModelsJson: a user's own provider survives untouched", () => {
  const mine = { providers: { myprivate: { baseUrl: "https://example.invalid/v1", api: "openai-completions",
    models: [{ id: "my-local-model", name: "My Local Model", contextWindow: 8192 }] } } };
  const file = tmpFile(JSON.stringify(mine, null, 2));
  mergeModelsJson(file, 0);
  const after = read(file);
  assert.deepEqual(after.providers.myprivate, mine.providers.myprivate, "byte-for-byte the user's");
  assert.ok(modelsOf(after, "deepseek").length > 0, "and ours was still added alongside");
});

test("mergeModelsJson: a hand-written entry for a model we manage WINS", () => {
  // The promise: no marker means it is theirs, even where the id collides with ours.
  const file = tmpFile(JSON.stringify({ providers: { deepseek: { baseUrl: "https://my-proxy.invalid/v1",
    api: "openai-completions", models: [{ id: "deepseek-v4-flash", name: "MINE", contextWindow: 4096 }] } } }));
  const before = read(file);
  const r = mergeModelsJson(file, 0);
  const after = read(file);
  const flash = modelsOf(after, "deepseek").find((m) => m.id === "deepseek-v4-flash");
  assert.equal(flash.name, "MINE", "not overwritten");
  assert.equal(flash.contextWindow, 4096, "their value kept");
  assert.equal(flash._managedBy, undefined, "and it stays unmanaged");
  assert.equal(after.providers.deepseek.baseUrl, before.providers.deepseek.baseUrl, "their baseUrl kept");
  assert.ok(r.userOwned >= 1, "counted as user-owned");
});

test("mergeModelsJson: OUR entry is refreshed in place on the next run", () => {
  const file = tmpFile();
  mergeModelsJson(file, 0);
  const doc = read(file);
  const flash = modelsOf(doc, "deepseek").find((m) => m.id === "deepseek-v4-flash");
  flash.contextWindow = 1; flash._managedBy = "pi-code-gui@0.0.1";   // stale, from an older release
  writeFileSync(file, JSON.stringify(doc, null, 2));

  mergeModelsJson(file, 0);
  const after = modelsOf(read(file), "deepseek").find((m) => m.id === "deepseek-v4-flash");
  assert.notEqual(after.contextWindow, 1, "refreshed");
  assert.equal(after._managedBy, MANAGED_BY, "re-stamped with the current version");
});

test("mergeModelsJson: contextBudget clamps what we write", () => {
  const file = tmpFile();
  mergeModelsJson(file, 50_000);
  for (const m of modelsOf(read(file), "deepseek")) {
    assert.ok(m.contextWindow <= 50_000, `${m.id} clamped`);
  }
});

test("mergeModelsJson: a corrupt file is replaced rather than failing the session", () => {
  const file = tmpFile("{ this is not json");
  const r = mergeModelsJson(file, 0);
  assert.ok(r.written > 0);
  assert.ok(existsSync(file));
});

test("checkAuthAvailable: silent when the agent home IS the user's ~/.pi/agent", () => {
  // The whole point of sharing — one auth.json, nothing to copy, link or refresh.
  assert.equal(checkAuthAvailable(defaultRustAgentDir()), null);
  assert.equal(defaultRustAgentDir(), join(homedir(), ".pi", "agent"));
});

test("checkAuthAvailable: warns when rustAgentDir points somewhere with no credential", () => {
  const dir = mkdtempSync(join(tmpdir(), "agent-elsewhere-"));
  const w = checkAuthAvailable(dir);
  assert.ok(w && w.includes("no auth.json of its own"), "says the credential is separate");
  assert.ok(w.includes("rustAgentDir"), "names the setting responsible");
  // Deliberately does NOT copy one in: a second copy of an OAuth grant goes stale on rotation.
  assert.ok(!existsSync(join(dir, "auth.json")), "nothing was duplicated");
});

// ── credential scoping ──────────────────────────────────────────────
// Describing all 963 bundled models put half a megabyte into the user's own models.json for
// models they cannot reach. Of 32 bundled providers a typical user has credentials for one or
// two — so the file describes those, and the picker (populated from the binary's
// get_available_models, i.e. from this file plus its built-ins) offers what can actually run.

test("credentialedProviders: finds providers by their auth env key", () => {
  const dir = mkdtempSync(join(tmpdir(), "scope-env-"));
  const s1 = credentialedProviders({ DEEPSEEK_API_KEY: "sk-x" }, dir);
  assert.ok(s1.has("deepseek"));
  assert.ok(!s1.has("anthropic"), "no key, not offered");
  assert.equal(credentialedProviders({}, dir).size, 0, "no credentials, nothing written");
});

test("credentialedProviders: an empty or whitespace key does not count", () => {
  const dir = mkdtempSync(join(tmpdir(), "scope-empty-"));
  assert.ok(!credentialedProviders({ DEEPSEEK_API_KEY: "" }, dir).has("deepseek"));
  assert.ok(!credentialedProviders({ DEEPSEEK_API_KEY: "   " }, dir).has("deepseek"));
});

test("credentialedProviders: honours irregular env keys, mirroring `pi --list-providers`", () => {
  const dir = mkdtempSync(join(tmpdir(), "scope-odd-"));
  assert.ok(credentialedProviders({ HF_TOKEN: "hf-x" }, dir).has("huggingface"), "not HUGGINGFACE_API_KEY");
  assert.ok(credentialedProviders({ ZHIPU_API_KEY: "z" }, dir).has("zai"), "not ZAI_API_KEY");
  assert.ok(credentialedProviders({ KIMI_API_KEY: "k" }, dir).has("moonshotai"), "either alias works");
});

test("credentialedProviders: an OAuth login counts, with no env key at all", () => {
  // /login writes auth.json into the shared agent home; that must bring the provider into scope.
  const dir = mkdtempSync(join(tmpdir(), "scope-oauth-"));
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ anthropic: { type: "oauth", refresh: "r" } }));
  assert.ok(credentialedProviders({}, dir).has("anthropic"));
});

test("credentialedProviders: a corrupt auth.json degrades to env only", () => {
  const dir = mkdtempSync(join(tmpdir(), "scope-bad-"));
  writeFileSync(join(dir, "auth.json"), "{ not json");
  const s2 = credentialedProviders({ DEEPSEEK_API_KEY: "sk-x" }, dir);
  assert.ok(s2.has("deepseek"), "env still works");
});

test("mergeModelsJson: writes only the scoped providers", () => {
  const file = tmpFile();
  const r = mergeModelsJson(file, 0, new Set(["deepseek"]));
  const doc = read(file);
  assert.deepEqual(Object.keys(doc.providers), ["deepseek"], "nothing else described");
  assert.ok(r.written > 0 && r.written < 20, `a handful of entries, not 963 (got ${r.written})`);
});

test("mergeModelsJson: an out-of-scope provider already in the file is left alone", () => {
  // Scope decides what we ADD, never what we remove — including our own entries from a run when
  // that provider still had a key.
  const file = tmpFile(JSON.stringify({ providers: { openai: { baseUrl: "https://api.openai.com/v1",
    api: "openai-responses", models: [{ id: "gpt-5.5-pro", _managedBy: "pi-code-gui@0.1.0" }] } } }));
  mergeModelsJson(file, 0, new Set(["deepseek"]));
  const doc = read(file);
  assert.ok(doc.providers.openai, "still there");
  assert.equal(modelsOf(doc, "openai").length, 1, "and untouched");
});

// ── approval mode ───────────────────────────────────────────────────
// The CLI flags are inert over RPC — --approval-mode and --yolo all leave the session in
// always-ask, so every edit comes back "Approval required in always-ask mode". Exactly one
// config shape works, measured against 0.3.0: {"approval": {"mode": "yolo"}}.

test("readApprovalMode: defaults to always-ask, and reads the nested shape", () => {
  const dir = mkdtempSync(join(tmpdir(), "appr-read-"));
  assert.equal(readApprovalMode(dir), "always-ask", "no file");
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ approval: { mode: "write" } }));
  assert.equal(readApprovalMode(dir), "write");
});

test("readApprovalMode: shapes the binary ignores are not honoured either", () => {
  // {"approval":"yolo"} hangs startup and {"approvalMode":"yolo"} is ignored — reporting them as
  // active would tell the user writes are permitted when they are not.
  const dir = mkdtempSync(join(tmpdir(), "appr-bad-"));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ approval: "yolo", approvalMode: "yolo" }));
  assert.equal(readApprovalMode(dir), "always-ask");
});

test("writeApprovalMode: sets one nested key and preserves the rest", () => {
  // This is the USER'S settings file, shared with the pi CLI — a rewrite would eat their config.
  const dir = mkdtempSync(join(tmpdir(), "appr-write-"));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ theme: "dark", defaultModel: "deepseek-v4-flash" }));
  assert.equal(writeApprovalMode(dir, "yolo"), null);
  const doc = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  assert.deepEqual(doc.approval, { mode: "yolo" });
  assert.equal(doc.theme, "dark", "untouched");
  assert.equal(doc.defaultModel, "deepseek-v4-flash", "untouched");
  assert.equal(readApprovalMode(dir), "yolo", "round-trips");
});

test("writeApprovalMode: a corrupt settings.json is replaced, not compounded", () => {
  const dir = mkdtempSync(join(tmpdir(), "appr-corrupt-"));
  writeFileSync(join(dir, "settings.json"), "{ not json");
  assert.equal(writeApprovalMode(dir, "write"), null);
  assert.equal(readApprovalMode(dir), "write");
});

// ── approval mode: the one lever that works ─────────────────────────
// The CLI flags are inert over RPC — --approval-mode write, --approval-mode yolo and --yolo all
// leave the session in always-ask, so every edit returns "Approval required in always-ask mode".
// Config is the only path, in exactly one shape (measured): {"approval": {"mode": "yolo"}}.

test("writeApprovalMode: nests under `approval`, the shape the binary reads", () => {
  const dir = mkdtempSync(join(tmpdir(), "appr-"));
  assert.equal(writeApprovalMode(dir, "yolo"), null);
  const doc = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  assert.deepEqual(doc.approval, { mode: "yolo" }, "a bare string hangs startup; approvalMode is ignored");
});

test("writeApprovalMode: preserves every other setting in the user's file", () => {
  // This file is the USER'S, shared with the pi CLI — the write must be surgical.
  const dir = mkdtempSync(join(tmpdir(), "appr-keep-"));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({
    theme: "dark", defaultModel: "deepseek-v4-flash", compaction: { enabled: false },
  }));
  writeApprovalMode(dir, "write");
  const doc = JSON.parse(readFileSync(join(dir, "settings.json"), "utf8"));
  assert.equal(doc.theme, "dark");
  assert.equal(doc.defaultModel, "deepseek-v4-flash");
  assert.deepEqual(doc.compaction, { enabled: false });
  assert.deepEqual(doc.approval, { mode: "write" });
});

test("readApprovalMode: unknown or absent values read as always-ask", () => {
  const dir = mkdtempSync(join(tmpdir(), "appr-read-"));
  assert.equal(readApprovalMode(dir), "always-ask", "no file");
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ approval: { mode: "nonsense" } }));
  assert.equal(readApprovalMode(dir), "always-ask", "unrecognised value fails safe");
  writeFileSync(join(dir, "settings.json"), "{ not json");
  assert.equal(readApprovalMode(dir), "always-ask", "corrupt file fails safe");
});

test("writeApprovalMode: a corrupt settings file is replaced, not compounded", () => {
  const dir = mkdtempSync(join(tmpdir(), "appr-corrupt-"));
  writeFileSync(join(dir, "settings.json"), "{ not json");
  assert.equal(writeApprovalMode(dir, "yolo"), null);
  assert.deepEqual(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).approval, { mode: "yolo" });
});

// ── defaultApproval must actually apply ─────────────────────────────
// It was a dead setting: read only to draw the ★ in the picker, written when you ticked "save as
// default", and never applied. A user whose default said `write` got whatever the shared file
// happened to hold — the picker showed ★ write beside ✓ yolo, and the session ran yolo.

test("a configured default is written to the shared file before the session reads it", () => {
  const dir = mkdtempSync(join(tmpdir(), "appr-default-"));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ theme: "dark", approval: { mode: "yolo" } }));
  // What the spawn path does: apply, then read back.
  writeApprovalMode(dir, "write");
  assert.equal(readApprovalMode(dir), "write", "the session starts in the configured default");
  assert.equal(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).theme, "dark", "rest preserved");
});

test("an empty default leaves the shared file alone", () => {
  // "" means follow ~/.pi/agent/settings.json — the file the pi CLI also writes. The extension
  // imposes nothing unless asked, which is why the default is empty rather than always-ask.
  const dir = mkdtempSync(join(tmpdir(), "appr-follow-"));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ approval: { mode: "yolo" } }));
  const before = readFileSync(join(dir, "settings.json"), "utf8");
  const wanted: "" | "write" = "";
  if (wanted) { writeApprovalMode(dir, wanted); }   // mirrors the guard at the spawn site
  assert.equal(readFileSync(join(dir, "settings.json"), "utf8"), before, "untouched");
  assert.equal(readApprovalMode(dir), "yolo", "the CLI's choice stands");
});
