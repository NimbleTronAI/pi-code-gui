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
import { mergeModelsJson, checkAuthAvailable, defaultRustAgentDir, credentialedProviders, readApprovalMode, writeApprovalMode, apisUnsupportedByRust, MANAGED_BY } from "../../rust-models.js";
import registry from "../../model-registry.generated.json";

function tmpFile(contents?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "models-merge-"));
  const file = join(dir, "models.json");
  if (contents !== undefined) { writeFileSync(file, contents); }
  return file;
}
function read(file: string): any { return JSON.parse(readFileSync(file, "utf-8")); }
function modelsOf(doc: any, prov: string): any[] { return doc.providers?.[prov]?.models ?? []; }

/** A model id the bundled catalog actually carries for `prov`, rather than a literal.
 *  Hardcoding one couples the test to upstream naming: pi-ai 0.86.1 renamed
 *  `deepseek-v4-flash` to `deepseek-flash` and broke two of these tests for no real reason. */
function anyBundledId(prov: string): string {
  const models = (registry.providers as Record<string, { models: Array<{ id: string }> }>)[prov]?.models ?? [];
  assert.ok(models.length > 0, `the bundled catalog must carry ${prov}`);
  return models[0].id;
}

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
  const id = anyBundledId("deepseek");
  const file = tmpFile(JSON.stringify({ providers: { deepseek: { baseUrl: "https://my-proxy.invalid/v1",
    api: "openai-completions", models: [{ id, name: "MINE", contextWindow: 4096 }] } } }));
  const before = read(file);
  const r = mergeModelsJson(file, 0);
  const after = read(file);
  const flash = modelsOf(after, "deepseek").find((m) => m.id === id);
  assert.equal(flash.name, "MINE", "not overwritten");
  assert.equal(flash.contextWindow, 4096, "their value kept");
  assert.equal(flash._managedBy, undefined, "and it stays unmanaged");
  assert.equal(after.providers.deepseek.baseUrl, before.providers.deepseek.baseUrl, "their baseUrl kept");
  assert.ok(r.userOwned >= 1, "counted as user-owned");
});

test("mergeModelsJson: OUR entry is refreshed in place on the next run", () => {
  const id = anyBundledId("deepseek");
  const file = tmpFile();
  mergeModelsJson(file, 0);
  const doc = read(file);
  const flash = modelsOf(doc, "deepseek").find((m) => m.id === id);
  flash.contextWindow = 1; flash._managedBy = "pi-code-gui@0.0.1";   // stale, from an older release
  writeFileSync(file, JSON.stringify(doc, null, 2));

  mergeModelsJson(file, 0);
  const after = modelsOf(read(file), "deepseek").find((m) => m.id === id);
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

// ── the approval file is the default ────────────────────────────────
// rust-pi reads approval ONLY from ~/.pi/agent/settings.json at startup and has no per-session
// override, so that file IS the default for new sessions. An extension setting mirroring it was
// a second store for one fact, and the two disagreed: the picker showed ★ write beside ✓ yolo
// while the session ran yolo. The file is now the single source for both marks.

test("writing the posture sets what the NEXT session starts in", () => {
  const dir = mkdtempSync(join(tmpdir(), "appr-default-"));
  writeFileSync(join(dir, "settings.json"), JSON.stringify({ theme: "dark", approval: { mode: "yolo" } }));
  // What the spawn path does: apply, then read back.
  writeApprovalMode(dir, "write");
  assert.equal(readApprovalMode(dir), "write", "the session starts in the configured default");
  assert.equal(JSON.parse(readFileSync(join(dir, "settings.json"), "utf8")).theme, "dark", "rest preserved");
});

test("nothing is written unless the user picks a posture", () => {
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

// ── protocols the pinned binary cannot act on ───────────────────────
test("mergeModelsJson: a provider whose api the binary has no protocol for is withheld", () => {
  // An unknown `api` is not a row the binary skips — it is a file it may reject whole, dropping
  // every managed entry for every provider with no error anywhere. pi-ai 0.86.1 added
  // `pi-messages` (radius), which postdates the rust-pi 0.3.0 that 0.2.x pins.
  const file = tmpFile();
  const r = mergeModelsJson(file, 0);
  const after = read(file);
  for (const { provider, api } of apisUnsupportedByRust()) {
    assert.equal(after.providers?.[provider], undefined, `${provider} (${api}) must not be described`);
    assert.ok(r.skippedApis.some((s) => s.includes(provider)), `${provider} must be reported as withheld`);
  }
  // Withholding is narrow: the providers we CAN describe are still all there.
  assert.ok(modelsOf(after, "deepseek").length > 0, "supported providers unaffected");
});

test("every api the bundled catalog carries is either supported or reported", () => {
  // The guard must never widen silently. Whatever a pi-ai bump introduces, it is listed as
  // supported on purpose or it shows up here — there is no third, quiet outcome.
  const withheld = new Set(apisUnsupportedByRust().map((x) => x.provider));
  const apis = new Set<string>();
  for (const [provId, prov] of Object.entries(registry.providers as Record<string, { api: string }>)) {
    if (!withheld.has(provId)) { apis.add(prov.api); }
  }
  // Fails loudly if a NEW api slips into the supported set without a decision being recorded.
  assert.deepEqual([...apis].sort(), [
    "anthropic-messages", "google-generative-ai", "mistral-conversations",
    "openai-completions", "openai-responses",
  ], "an unrecognised api reached the Rust catalog — see RUST_SUPPORTED_APIS");
});

test("the withheld set is exactly what pi-ai 0.86.1 introduced", () => {
  // Documents the current state rather than asserting emptiness: when the pinned rust-pi learns
  // `pi-messages`, this test is the reminder to move radius across.
  assert.deepEqual(apisUnsupportedByRust(), [{ provider: "radius", api: "pi-messages" }]);
});
