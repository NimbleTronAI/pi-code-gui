// The agent home is the user's own ~/.pi/agent, shared with the Pi CLI — so models.json is THEIR
// file. These tests pin Design S (v4 §2, amended by contracts C28, C29, C31): the merge writes ONE
// thing — `providers.<p>.modelOverrides.<id>` carrying Pi's own per-model values and our stamp — and
// before writing it removes everything an earlier release wrote. No value of the user's is ever
// deleted or changed, no provider-level key or models array is ever written, and a model rust-pi
// does not already list is created only on the connection Pi itself uses for it (C29).

import { test } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, statSync, utimesSync, lstatSync, symlinkSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import {
  mergeModelsJson, setupRustModels, initRustModels, checkAuthAvailable, defaultRustAgentDir,
  readApprovalMode, writeApprovalMode, MANAGED_BY, RUST_PI_CATALOG, type RustPiCatalog,
  providerHasCredential, oauthProviders,
} from "../../rust-models.js";
import { configureCatalogSource, slimCatalog, modelConnections, type CatalogProviders, type SlimModel } from "../../catalog-source.js";
import registry from "../../model-registry.generated.json";
import rustPiVersion from "../../rust-pi-version.json";

function tmpFile(contents?: string): string {
  const dir = mkdtempSync(join(tmpdir(), "models-merge-"));
  const file = join(dir, "models.json");
  if (contents !== undefined) { writeFileSync(file, contents); }
  return file;
}
function read(file: string): any { return JSON.parse(readFileSync(file, "utf-8")); }
const ov = (doc: any, p: string): Record<string, any> => doc.providers?.[p]?.modelOverrides ?? {};

function model(id: string, extra: Partial<SlimModel> & Record<string, unknown> = {}): SlimModel {
  return { id, name: `Name ${id}`, reasoning: false, contextWindow: 100_000, maxTokens: 8_000, input: ["text"], ...extra };
}

// A rust-pi catalog in the generated file's shape: what the binary lists per provider, and the
// connection it gives a model it does NOT list.
const RUST: RustPiCatalog = {
  rustPi: "0.0.0-test",
  providers: {
    // Pi's connection equals rust-pi's: a model rust-pi lacks may be created.
    deepseek: { newModel: { api: "openai-completions", baseUrl: "https://api.deepseek.com" }, ids: ["deepseek-chat"] },
    // rust-pi reports an anthropic-messages endpoint WITH the /v1/messages path the protocol appends.
    anthropic: { newModel: { api: "anthropic-messages", baseUrl: "https://api.anthropic.com/v1/messages" }, ids: ["old-a"] },
    // Pi talks to zai on another endpoint than rust-pi gives a new model: adjust only what rust-pi lists.
    zai: { newModel: { api: "openai-completions", baseUrl: "https://api.z.ai/api/paas/v4" }, ids: ["z-own"] },
    openrouter: { newModel: { api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1" }, ids: ["openrouter/auto"] },
  },
};
const SRC: CatalogProviders = {
  deepseek: { api: "openai-completions", baseUrl: "https://api.deepseek.com", models: [model("deepseek-chat"), model("deepseek-new")] },
  anthropic: { api: "anthropic-messages", baseUrl: "https://api.anthropic.com", models: [model("old-a"), model("new-a")] },
  zai: { api: "openai-completions", baseUrl: "https://api.z.ai/api/coding/paas/v4", models: [model("z-own"), model("z-new")] },
};
const merge = (file: string, src: CatalogProviders = SRC, opts: Record<string, unknown> = {}) =>
  mergeModelsJson(file, src, { rust: RUST, ...opts });

// ── what is written ─────────────────────────────────────────────────

test("every source model is written as one stamped modelOverrides entry and nothing else is written", () => {
  const file = tmpFile();
  const src: CatalogProviders = { deepseek: SRC.deepseek, anthropic: SRC.anthropic };
  const r = merge(file, src);
  assert.equal(r.outcome, "written");
  const doc = read(file);
  assert.deepEqual(Object.keys(doc), ["providers"]);
  assert.deepEqual(Object.keys(doc.providers).sort(), ["anthropic", "deepseek"]);
  for (const [p, prov] of Object.entries(src)) {
    assert.deepEqual(Object.keys(doc.providers[p]), ["modelOverrides"], `${p}: only modelOverrides`);
    assert.deepEqual(Object.keys(ov(doc, p)).sort(), prov.models.map((m) => m.id).sort(), `${p}: one entry per model`);
    for (const v of Object.values(ov(doc, p))) { assert.equal(v._managedBy, MANAGED_BY); }
  }
});

test("no provider-level key and no models array is ever written", () => {
  // The real catalogs, onto an empty file and onto a 0.2.7-shaped one.
  const floor = (registry as any).providers as CatalogProviders;
  const legacy = { providers: { deepseek: { baseUrl: "https://api.deepseek.com", api: "openai-completions",
    models: [{ id: "deepseek-chat", name: "x", contextWindow: 1, input: ["text"], reasoning: false, _managedBy: "pi-code-gui@0.2.7" }] } } };
  for (const start of [undefined, JSON.stringify(legacy)]) {
    const file = tmpFile(start);
    mergeModelsJson(file, floor);
    const doc = read(file);
    for (const [p, obj] of Object.entries<any>(doc.providers)) {
      assert.deepEqual(Object.keys(obj), ["modelOverrides"], `${p} carries ${Object.keys(obj).join(",")}`);
    }
  }
});

test("the override carries Pi's values: window unclamped, string-only top-level map, two compat flags, no tiers", () => {
  const file = tmpFile();
  merge(file, { deepseek: { ...SRC.deepseek, models: [model("deepseek-new", {
    contextWindow: 1_000_000, maxTokens: 384_000, reasoning: true, input: ["text", "image"],
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.5, tiers: [{ above: 200_000, input: 2 }] } as any,
    thinkingLevelMap: { off: null, minimal: null, low: "low", high: "max" },
    compat: { thinkingFormat: "deepseek", forceAdaptiveThinking: true, supportsDeveloperRole: false } as any,
    headers: { "X-Pi": "1" }, api: "openai-completions", baseUrl: "https://elsewhere.example",
  })] } });
  const { _managedBy, ...v } = ov(read(file), "deepseek")["deepseek-new"];
  assert.equal(_managedBy, MANAGED_BY);
  assert.deepEqual(v, {
    name: "Name deepseek-new", contextWindow: 1_000_000, maxTokens: 384_000, input: ["text", "image"],
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0.5 }, reasoning: true,
    thinkingLevelMap: { low: "low", high: "max" }, compat: { thinkingFormat: "deepseek", forceAdaptiveThinking: true },
  });
});

test("a placeholder maxTokens (>= window) is omitted; a real one is written", () => {
  const file = tmpFile();
  merge(file, { deepseek: { ...SRC.deepseek, models: [
    model("deepseek-chat", { contextWindow: 128_000, maxTokens: 128_000 }),
    model("deepseek-new", { contextWindow: 128_000, maxTokens: 200_000 }),
    model("deepseek-real", { contextWindow: 128_000, maxTokens: 8_192 }),
  ] } });
  const o = ov(read(file), "deepseek");
  assert.equal("maxTokens" in o["deepseek-chat"], false, "equal to the window: a placeholder");
  assert.equal("maxTokens" in o["deepseek-new"], false, "above the window: a placeholder");
  assert.equal(o["deepseek-real"].maxTokens, 8_192);
});

test("x and <provider>/x are one id: only the prefixed twin is written, and your override of either wins", () => {
  const src: CatalogProviders = { openrouter: { api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1",
    models: [model("auto"), model("openrouter/auto"), model("vendor/m")] } };
  const r1 = tmpFile();
  mergeModelsJson(r1, src, { rust: { ...RUST, providers: { openrouter: { ...RUST.providers.openrouter, ids: ["openrouter/auto", "vendor/m"] } } } });
  assert.deepEqual(Object.keys(ov(read(r1), "openrouter")).sort(), ["openrouter/auto", "vendor/m"], "the bare twin is not written");
  for (const yours of ["auto", "openrouter/auto"]) {
    const file = tmpFile(JSON.stringify({ providers: { openrouter: { modelOverrides: { [yours]: { name: "mine" } } } } }));
    mergeModelsJson(file, src, { rust: RUST });
    const o = ov(read(file), "openrouter");
    assert.deepEqual(o[yours], { name: "mine" }, `your ${yours} is untouched`);
    assert.equal(Object.keys(o).filter((k) => k === "auto" || k === "openrouter/auto").length, 1, `nothing of ours beside your ${yours}`);
  }
});

test("a slash id is not the twin of its provider-prefixed form: vendor/m and openrouter/vendor/m are two models", () => {
  // oneId strips `<provider>/` only when what is left holds no further slash (rust-pi's twin rule).
  const src: CatalogProviders = { openrouter: { api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1",
    models: [model("vendor/m"), model("openrouter/vendor/m")] } };
  const rust: RustPiCatalog = { ...RUST, providers: { openrouter: { ...RUST.providers.openrouter, ids: ["vendor/m", "openrouter/vendor/m"] } } };
  const a = tmpFile();
  mergeModelsJson(a, src, { rust });
  assert.deepEqual(Object.keys(ov(read(a), "openrouter")).sort(), ["openrouter/vendor/m", "vendor/m"], "both written");
  const b = tmpFile(JSON.stringify({ providers: { openrouter: { modelOverrides: { "openrouter/vendor/m": { name: "mine" } } } } }));
  mergeModelsJson(b, src, { rust });
  const o = ov(read(b), "openrouter");
  assert.deepEqual(o["openrouter/vendor/m"], { name: "mine" }, "your override is untouched");
  assert.ok(o["vendor/m"], "and does not suppress ours for vendor/m");
});

test("your models[] entry and your override for an id are byte-identical and ours is not written", () => {
  const yoursEntry = { id: "deepseek-chat", name: "my chat", contextWindow: 4_096, input: ["text"], reasoning: false, cost: { input: 9, output: 9, cacheRead: 0, cacheWrite: 0 } };
  const yoursOverride = { contextWindow: 2_000, compat: { supportsDeveloperRole: false } };
  const file = tmpFile(JSON.stringify({ providers: { deepseek: { models: [yoursEntry], modelOverrides: { "deepseek-new": yoursOverride } } } }));
  merge(file);
  const d = read(file).providers.deepseek;
  assert.equal(JSON.stringify(d.models), JSON.stringify([yoursEntry]));
  assert.equal(JSON.stringify(d.modelOverrides["deepseek-new"]), JSON.stringify(yoursOverride));
  assert.equal(d.modelOverrides["deepseek-chat"], undefined, "your models[] id is yours");
});

// ── what is never touched ───────────────────────────────────────────

test("a key you add inside an object we created survives, and the object is not deleted", () => {
  // R-B2. The object exists only because we wrote overrides into it; you then added headers.
  const ours = { name: "x", contextWindow: 1, input: ["text"], reasoning: false, _managedBy: "pi-code-gui@0.2.8" };
  for (const src of [SRC, {} as CatalogProviders]) {
    const file = tmpFile(JSON.stringify({ providers: { deepseek: { modelOverrides: { "deepseek-chat": ours }, headers: { "X-Mine": "1" } } } }));
    merge(file, src);
    const d = read(file).providers?.deepseek;
    assert.ok(d, "the object stays");
    assert.deepEqual(d.headers, { "X-Mine": "1" });
  }
});

test("a key you add inside our override (top level, cost, compat) survives, and that id becomes yours", () => {
  const base = { name: "old", contextWindow: 1, input: ["text"], reasoning: false, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, _managedBy: "pi-code-gui@0.2.8" };
  const edited = [
    { ...base, headers: { "X-Mine": "1" } },
    { ...base, cost: { ...base.cost, tiers: [] } },
    { ...base, compat: { thinkingFormat: "deepseek", supportsDeveloperRole: false } },
  ];
  for (const e of edited) {
    const file = tmpFile(JSON.stringify({ providers: { deepseek: { modelOverrides: { "deepseek-new": e } } } }));
    merge(file);
    const { _managedBy, ...yours } = e;
    void _managedBy;
    assert.deepEqual(ov(read(file), "deepseek")["deepseek-new"], yours, "kept whole, only our stamp dropped");
  }
});

test("your provider object keeps every key: baseUrl, api, headers, apiKey, models: []", () => {
  const yours = { baseUrl: "https://my-proxy.example/v1", api: "openai-completions", headers: { "X-Mine": "1" }, apiKey: "MY_KEY_ENV", models: [] };
  const file = tmpFile(JSON.stringify({ providers: { deepseek: yours } }));
  merge(file);
  const d = read(file).providers.deepseek;
  for (const [k, v] of Object.entries(yours)) { assert.deepEqual(d[k], v, `${k} kept`); }
  assert.equal(d.modelOverrides, undefined, "and nothing of ours is written into it");
});

test("a provider object with your models array gets none of our overrides: rust-pi lists none of its own there", () => {
  // Measured on 0.8.0: with a `models` array in the object, rust-pi drops its built-ins for the provider,
  // so an override of ours would CREATE the model on rust-pi's default connection, which is not Pi's.
  for (const models of [[], [{ id: "my-z", name: "mine", contextWindow: 2, input: ["text"], reasoning: false }]]) {
    for (const p of ["zai", "deepseek"]) {
      const file = tmpFile(JSON.stringify({ providers: { [p]: { models } } }));
      merge(file);
      assert.equal(read(file).providers[p].modelOverrides, undefined, `${p} with ${models.length} model(s): nothing written into it`);
      assert.deepEqual(read(file).providers[p].models, models, `${p}: your list is kept`);
    }
  }
});

test("a provider object with your baseUrl or api: rust-pi's own ids are adjusted, nothing is created", () => {
  // A model we create there would run on YOUR connection; the gate compares rust-pi's default, which you replaced.
  for (const mine of [{ baseUrl: "https://my-proxy.example/v1" }, { api: "openai-completions" }]) {
    const file = tmpFile(JSON.stringify({ providers: { deepseek: mine } }));
    merge(file);
    const o = ov(read(file), "deepseek");
    assert.deepEqual(Object.keys(o), ["deepseek-chat"], `${Object.keys(mine)[0]}: only the id rust-pi lists`);
    for (const [k, v] of Object.entries(mine)) { assert.equal(read(file).providers.deepseek[k], v, `${k} kept`); }
  }
});

test("a models array or modelOverrides object our removal empties is removed; one you wrote empty stays", () => {
  const stamped = { id: "gone", name: "x", contextWindow: 1, input: ["text"], reasoning: false, _managedBy: "pi-code-gui@0.2.7" };
  const file = tmpFile(JSON.stringify({ providers: {
    zai: { headers: { a: "1" }, models: [stamped], modelOverrides: { gone: { ...stamped, id: undefined } } },
    deepseek: { headers: { a: "1" }, models: [], modelOverrides: {} },
  } }));
  merge(file, {});
  const doc = read(file);
  assert.deepEqual(doc.providers.zai, { headers: { a: "1" } }, "ours emptied them: removed");
  assert.deepEqual(doc.providers.deepseek, { headers: { a: "1" }, models: [], modelOverrides: {} }, "yours stay");
});

// ── migration of files earlier releases wrote ───────────────────────

test("migration: an object of only our models[] entries loses a shipped pair; any other pair stays", () => {
  const ours = (id: string) => ({ id, name: id, contextWindow: 1, input: ["text"], reasoning: false, _managedBy: "pi-code-gui@0.2.7" });
  const file = tmpFile(JSON.stringify({ providers: {
    deepseek: { baseUrl: "https://api.deepseek.com", api: "openai-completions", models: [ours("deepseek-chat")] },
    zai: { baseUrl: "https://my-zai-proxy.example/v4", api: "openai-completions", models: [ours("z-own")] },
  } }));
  merge(file);
  const doc = read(file);
  assert.deepEqual(Object.keys(doc.providers.deepseek), ["modelOverrides"], "shipped pair and our models gone");
  assert.equal(doc.providers.zai.baseUrl, "https://my-zai-proxy.example/v4", "a pair we never shipped is yours");
  assert.equal(doc.providers.zai.api, "openai-completions");
  assert.equal(doc.providers.zai.models, undefined, "our entries still go");
});

test("migration: an object holding a model of yours keeps its connection", () => {
  const file = tmpFile(JSON.stringify({ providers: { deepseek: { baseUrl: "https://api.deepseek.com", api: "openai-completions", models: [
    { id: "deepseek-chat", name: "x", contextWindow: 1, input: ["text"], reasoning: false, _managedBy: "pi-code-gui@0.2.7" },
    { id: "my-model", name: "mine", contextWindow: 2, input: ["text"], reasoning: false },
  ] } } }));
  merge(file);
  const d = read(file).providers.deepseek;
  assert.equal(d.baseUrl, "https://api.deepseek.com");
  assert.equal(d.api, "openai-completions");
  assert.deepEqual(d.models, [{ id: "my-model", name: "mine", contextWindow: 2, input: ["text"], reasoning: false }]);
});

test("0.2.8-pre provider _managedBy is removed", () => {
  const file = tmpFile(JSON.stringify({ providers: { "kimi-coding": { baseUrl: "https://api.kimi.com/coding/v1", api: "openai-completions", _managedBy: "pi-code-gui@0.2.8",
    models: [{ id: "k2", name: "k2", contextWindow: 1, input: ["text"], reasoning: false, _managedBy: "pi-code-gui@0.2.8" }] } } }));
  merge(file, {});
  assert.equal(read(file).providers["kimi-coding"], undefined, "stamp, shipped pair and our models gone; the empty object with them");
});

test("a provider object left empty is removed", () => {
  const file = tmpFile(JSON.stringify({ providers: {
    zai: { baseUrl: "https://api.z.ai/api/coding/paas/v4", api: "openai-completions", models: [{ id: "z-old", name: "g", contextWindow: 1, input: ["text"], reasoning: false, _managedBy: "pi-code-gui@0.2.5" }] },
    mine: {},
  } }));
  merge(file, {});
  const doc = read(file);
  assert.equal(doc.providers.zai, undefined);
  assert.deepEqual(doc.providers.mine, {}, "an object you left empty is yours");
});

test("running the merge twice yields identical bytes", () => {
  const floor = (registry as any).providers as CatalogProviders;
  const file = tmpFile(JSON.stringify({ providers: { deepseek: { baseUrl: "https://api.deepseek.com", api: "openai-completions",
    models: [{ id: "deepseek-chat", name: "x", contextWindow: 1, input: ["text"], reasoning: false, _managedBy: "pi-code-gui@0.2.7" }] },
    mine: { baseUrl: "https://x.example", api: "openai-completions", models: [{ id: "m", name: "m", contextWindow: 1, input: ["text"], reasoning: false }] } } }));
  assert.equal(mergeModelsJson(file, floor).outcome, "written");
  const first = readFileSync(file, "utf8");
  const old = new Date(Date.now() - 60_000);
  utimesSync(file, old, old);
  assert.equal(mergeModelsJson(file, floor).outcome, "unchanged");
  assert.equal(readFileSync(file, "utf8"), first);
  assert.equal(statSync(file).mtimeMs, old.getTime(), "not even touched");
});

// ── a file we cannot rewrite safely ─────────────────────────────────

const WHY_FIX = {
  bom: ["starts with a byte-order mark", "save it as plain JSON (no comments, no trailing commas, UTF-8 without a byte-order mark)"],
  parse: ["isn't plain JSON (it may have comments, trailing commas or a syntax error)", "save it as plain JSON (no comments, no trailing commas, UTF-8 without a byte-order mark)"],
  shape: ["isn't shaped like a models file", "make the file, its \"providers\" and each provider JSON objects, each \"models\" a list and each \"modelOverrides\" an object"],
} as const;
const message = (file: string, why: string, fix: string) =>
  `Your models.json (\`${file}\`) ${why}. Rust Pi ignores a file like that completely — including any custom providers in it — so Rust sessions use only Rust Pi's built-in models. The extension has not changed the file. To fix it, ${fix}, then start a new Rust session.`;

test("a comment, trailing comma, BOM, a non-ENOENT read error, or a non-object provider, models entry, modelOverrides or override value, or a non-array models: never written, bytes and mtime unchanged, one warning per window, with the exact why and fix text for each of the four reasons", async () => {
  const cases: Array<[string, string, keyof typeof WHY_FIX]> = [
    ["comment", '{ // mine\n "providers": {} }', "parse"],
    ["trailing comma", '{ "providers": { "a": { "baseUrl": "x", }, } }', "parse"],
    ["syntax", '{ "providers": ', "parse"],
    ["BOM", '﻿{ "providers": {} }', "bom"],
    ["top level array", "[]", "shape"],
    ["providers array", '{ "providers": [] }', "shape"],
    ["provider null", '{ "providers": { "deepseek": null } }', "shape"],
    ["provider string", '{ "providers": { "deepseek": "x" } }', "shape"],
    ["models object", '{ "providers": { "deepseek": { "models": {} } } }', "shape"],
    ["models entry not an object", '{ "providers": { "deepseek": { "models": [1] } } }', "shape"],
    ["modelOverrides array", '{ "providers": { "deepseek": { "modelOverrides": [] } } }', "shape"],
    ["override value not an object", '{ "providers": { "deepseek": { "modelOverrides": { "deepseek-chat": true } } } }', "shape"],
  ];
  for (const [name, text, reason] of cases) {
    const file = tmpFile(text);
    const old = new Date(Date.now() - 60_000);
    utimesSync(file, old, old);
    const r = merge(file);
    assert.equal(r.outcome, "unsafe", name);
    assert.equal(readFileSync(file, "utf8"), text, `${name}: bytes unchanged`);
    assert.equal(statSync(file).mtimeMs, old.getTime(), `${name}: mtime unchanged`);
    assert.equal((r as any).message, message(file, WHY_FIX[reason][0], WHY_FIX[reason][1]), `${name}: the ${reason} text`);
  }
  // A read error other than ENOENT (here: models.json is a directory).
  const dir = mkdtempSync(join(tmpdir(), "models-eisdir-"));
  const asDir = join(dir, "models.json");
  mkdirSync(asDir);
  const r = merge(asDir);
  assert.equal(r.outcome, "unsafe");
  assert.equal((r as any).message, message(asDir, "could not be read (EISDIR)", "make it a readable file (check its permissions)"));
  assert.ok(statSync(asDir).isDirectory(), "left as it was");
  // A models.json that is a symlink to a missing file: the link is the user's, never replaced by a file.
  const linkDir = mkdtempSync(join(tmpdir(), "models-dangling-"));
  const link = join(linkDir, "models.json");
  symlinkSync(join(linkDir, "dotfiles", "models.json"), link);
  const rl = merge(link);
  assert.equal(rl.outcome, "unsafe");
  assert.equal((rl as any).message, message(link, "could not be read (ENOENT)", "make it a readable file (check its permissions)"));
  assert.ok(lstatSync(link).isSymbolicLink(), "the link is still a link");

  // Through the production entry: one warning per window, whatever the number of Rust starts.
  const agent = mkdtempSync(join(tmpdir(), "agent-unsafe-"));
  writeFileSync(join(agent, "models.json"), '{ "providers": {}, }');
  (globalThis as any).__vscodeMock.config = { "pi-code-gui.rustAgentDir": agent };
  initRustModels({} as any);
  await configureCatalogSource({ piPackagePath: join(agent, "no-pi-here") }).prepare(1000);
  const w1 = setupRustModels().warnings.filter((w) => w.includes("models.json"));
  const w2 = setupRustModels().warnings.filter((w) => w.includes("models.json"));
  assert.deepEqual(w1, [message(join(agent, "models.json"), WHY_FIX.parse[0], WHY_FIX.parse[1])]);
  assert.deepEqual(w2, [], "once per window");
  assert.equal(readFileSync(join(agent, "models.json"), "utf8"), '{ "providers": {}, }');
});

test("a read-only models.json is never written; bytes, mode and mtime unchanged; one notice per window", async () => {
  const text = JSON.stringify({ providers: { mine: { baseUrl: "https://mine.example", api: "openai-completions" } } });
  const file = tmpFile(text);
  chmodSync(file, 0o444);
  const old = new Date(Date.now() - 60_000);
  utimesSync(file, old, old);
  const r = merge(file);
  assert.equal(r.outcome, "unsafe");
  assert.equal((r as any).reason, "readonly");
  assert.equal((r as any).message,
    `Your models.json (\`${file}\`) is read-only, so the extension has not changed it, and Rust sessions use it exactly as it is. To let the extension keep Rust Pi's model details current, make it writable, then start a new Rust session.`);
  assert.equal(readFileSync(file, "utf8"), text, "bytes unchanged");
  assert.equal(statSync(file).mode & 0o7777, 0o444, "mode unchanged");
  assert.equal(statSync(file).mtimeMs, old.getTime(), "mtime unchanged");
  // Through a symlink: the target's permissions decide.
  const linkDir = mkdtempSync(join(tmpdir(), "models-ro-link-"));
  const link = join(linkDir, "models.json");
  symlinkSync(file, link);
  assert.equal(merge(link).outcome, "unsafe");
  assert.equal(readFileSync(file, "utf8"), text);

  // Through the production entry: one notice per window.
  const agent = mkdtempSync(join(tmpdir(), "agent-ro-"));
  const ro = join(agent, "models.json");
  writeFileSync(ro, text);
  chmodSync(ro, 0o444);
  (globalThis as any).__vscodeMock.config = { "pi-code-gui.rustAgentDir": agent };
  initRustModels({} as any);
  await configureCatalogSource({ piPackagePath: join(agent, "no-pi-here") }).prepare(1000);
  const notices = () => setupRustModels().warnings.filter((w) => w.includes("read-only"));
  assert.equal(notices().length, 1);
  assert.equal(notices().length, 0, "once per window");
  assert.equal(readFileSync(ro, "utf8"), text);
});

test("read-only: a file the format checks reject keeps its format message; one the merge would not change is left silent", () => {
  const bad = tmpFile('{ // mine\n "providers": {} }');
  chmodSync(bad, 0o444);
  const rb = merge(bad);
  assert.equal((rb as any).reason, "parse", "rust-pi ignores such a file whether or not it is read-only");
  const ok = tmpFile();
  assert.equal(merge(ok).outcome, "written");
  chmodSync(ok, 0o444);
  assert.equal(merge(ok).outcome, "unchanged", "nothing to write: no notice");
});

test("a read-only folder: a writable or absent models.json in it is never written, and the notice says the folder", () => {
  const text = JSON.stringify({ providers: { mine: { baseUrl: "https://mine.example", api: "openai-completions" } } });
  for (const present of [true, false]) {
    const dir = mkdtempSync(join(tmpdir(), "models-rodir-"));
    const file = join(dir, "models.json");
    if (present) { writeFileSync(file, text); }
    chmodSync(dir, 0o555);
    try {
      const r = merge(file);
      assert.equal(r.outcome, "unsafe", present ? "file present" : "file absent");
      assert.equal((r as any).reason, "readonly");
      assert.match((r as any).message, /its folder is read-only/);
      assert.equal(existsSync(file), present);
      if (present) { assert.equal(readFileSync(file, "utf8"), text); }
    } finally { chmodSync(dir, 0o755); }
  }
});

test("an id is adjusted only when rust-pi lists exactly that id: Pi's x is not rust-pi's p/x", () => {
  // Measured on 0.8.0: only openrouter's `auto` merges with its prefixed form; `p/x` and `x` are two models elsewhere.
  const rust: RustPiCatalog = { rustPi: "0", providers: { p: { newModel: { api: "openai-completions", baseUrl: "https://new.example" }, ids: ["p/x"] } } };
  const file = tmpFile("{}");
  mergeModelsJson(file, { p: { api: "openai-completions", baseUrl: "https://other.example", models: [model("x")] } }, { rust });
  assert.equal(read(file).providers?.p, undefined, "x would be created off Pi's connection");
});

test("a file changed between read and rename is re-merged once, never overwritten", () => {
  // You save the file in an editor while we merge: we start over from YOUR bytes.
  const file = tmpFile(JSON.stringify({ providers: {} }));
  let saves = 0;
  const r = merge(file, SRC, { beforeRename: () => {
    if (saves++ === 0) { writeFileSync(file, JSON.stringify({ providers: { mine: { baseUrl: "https://mine.example", api: "openai-completions" } } })); }
  } });
  assert.equal(r.outcome, "written");
  const doc = read(file);
  assert.equal(doc.providers.mine.baseUrl, "https://mine.example", "your save survived");
  assert.ok(ov(doc, "deepseek")["deepseek-new"], "and ours was merged into it");
  // It keeps changing: we skip this start rather than overwrite.
  const busy = tmpFile(JSON.stringify({ providers: {} }));
  let n = 0;
  const r2 = merge(busy, SRC, { beforeRename: () => { writeFileSync(busy, JSON.stringify({ n: ++n })); } });
  assert.equal(r2.outcome, "raced");
  assert.equal(readFileSync(busy, "utf8"), JSON.stringify({ n: 2 }), "your last save stands");
});

// ── C29: a model rust-pi lacks is created only on Pi's own connection ──

test("C29: a model rust-pi lacks is written only where rust-pi's connection for a new model is Pi's; one it lists is adjusted whatever the connection", () => {
  const file = tmpFile();
  const r = merge(file, { ...SRC, unknownprov: { api: "openai-completions", baseUrl: "https://u.example", models: [model("u1")] } });
  const doc = read(file);
  assert.deepEqual(Object.keys(ov(doc, "deepseek")).sort(), ["deepseek-chat", "deepseek-new"], "same connection: adjusted and created");
  assert.deepEqual(Object.keys(ov(doc, "anthropic")).sort(), ["new-a", "old-a"], "the /v1/messages rust-pi reports is the endpoint Pi's base URL names");
  assert.deepEqual(Object.keys(ov(doc, "zai")), ["z-own"], "another endpoint: only the model rust-pi lists");
  assert.equal(doc.providers.unknownprov, undefined, "a provider rust-pi does not list gets nothing");
  assert.ok(r.outcome === "written" && r.notCreated.includes("zai/z-new"), "what was held back is reported");
});

test("C29: the gate is per model: a provider whose first model is on rust-pi's connection does not create its model on another", () => {
  // The slim catalog keeps ONE connection per provider (its first model's). Pi can mix: here the first
  // model is on rust-pi's connection and the second is an anthropic-messages model on another endpoint.
  const src: CatalogProviders = { openrouter: { api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1",
    models: [model("vendor/on-rust-connection"), model("vendor/elsewhere")] } };
  const connections = { openrouter: {
    "vendor/on-rust-connection": { api: "openai-completions", baseUrl: "https://openrouter.ai/api/v1" },
    "vendor/elsewhere": { api: "anthropic-messages", baseUrl: "https://openrouter.ai/api" },
  } };
  const file = tmpFile();
  const r = merge(file, src, { connections });
  assert.deepEqual(Object.keys(ov(read(file), "openrouter")), ["vendor/on-rust-connection"]);
  assert.ok(r.outcome === "written" && r.notCreated.includes("openrouter/vendor/elsewhere"));
  // And the other way round: a first model off rust-pi's connection does not hold back one that is on it.
  const flipped: CatalogProviders = { openrouter: { api: "anthropic-messages", baseUrl: "https://openrouter.ai/api",
    models: [model("vendor/elsewhere"), model("vendor/on-rust-connection")] } };
  const f2 = tmpFile();
  merge(f2, flipped, { connections });
  assert.deepEqual(Object.keys(ov(read(f2), "openrouter")), ["vendor/on-rust-connection"]);
});

test("modelConnections: each model's own api and base URL, per provider", () => {
  assert.deepEqual(modelConnections([
    { provider: "p", id: "a", api: "openai-completions", baseUrl: "https://p/v1" },
    { provider: "p", id: "b", api: "anthropic-messages", baseUrl: "https://p" },
    { provider: "p", id: "c" },
  ]), { p: { a: { api: "openai-completions", baseUrl: "https://p/v1" }, b: { api: "anthropic-messages", baseUrl: "https://p" } } });
});

test("C29 with the real catalogs: every override that would create a model is on Pi's own connection for that model", async () => {
  // Pi's built-in catalog (the devDep pi-ai the floor is generated from), per model, against the pinned
  // rust-pi's measured catalog.
  const all: any = await import("@earendil-works/pi-ai/providers/all");
  const builtins = all.getBuiltinProviders().flatMap((p: string) => all.getBuiltinModels(p) ?? []);
  const source = slimCatalog(builtins);
  const connections = modelConnections(builtins);
  const file = tmpFile();
  mergeModelsJson(file, source, { connections });
  const doc = read(file);
  const ep = (api: string, url: string) => `${api} ${api === "anthropic-messages" ? url.replace(/\/v1\/messages$/, "") : url}`;
  const one = (p: string, id: string) => (id.startsWith(`${p}/`) && !id.slice(p.length + 1).includes("/") ? id.slice(p.length + 1) : id);
  let created = 0, adjusted = 0;
  for (const [p, obj] of Object.entries<any>(doc.providers)) {
    const rust = RUST_PI_CATALOG.providers[p];
    assert.ok(rust, `${p}: rust-pi does not list it, so nothing may be written`);
    const own = new Set(rust.ids.map((id) => one(p, id)));
    for (const id of Object.keys(obj.modelOverrides)) {
      if (own.has(one(p, id))) { adjusted++; continue; }
      created++;
      const pi = connections[p][id];
      assert.equal(ep(pi.api, pi.baseUrl), ep(rust.newModel.api, rust.newModel.baseUrl), `${p}/${id} would be created on another connection than Pi's`);
    }
  }
  assert.ok(created > 0 && adjusted > 0, `both kinds exercised (created ${created}, adjusted ${adjusted})`);
});

test("the rust-pi catalog was measured from the pinned binary", () => {
  // scripts/gen-rust-pi-catalog.mjs re-measures it; a pin bump without a re-run fails here.
  assert.equal(`v${RUST_PI_CATALOG.rustPi}`, (rustPiVersion as any).tag);
});

// ── the production entry ────────────────────────────────────────────

test("setupRustModels writes nothing when the source is not ready", () => {
  const agent = mkdtempSync(join(tmpdir(), "agent-none-"));
  (globalThis as any).__vscodeMock.config = { "pi-code-gui.rustAgentDir": agent };
  initRustModels({} as any);
  // An installed Pi whose catalog has not loaded yet: "none".
  const pi = join(agent, "pi");
  mkdirSync(pi);
  writeFileSync(join(pi, "package.json"), "{}");
  configureCatalogSource({ piPackagePath: pi, importModule: () => new Promise(() => {}) });
  const r = setupRustModels();
  assert.equal(r.piEnv.PI_CODING_AGENT_DIR, agent);
  assert.equal(existsSync(join(agent, "models.json")), false, "nothing written");
});

test("setupRustModels writes Pi's catalog with no context-budget clamp", async () => {
  // C31: pi-code-gui.contextBudget is TypeScript-only; models.json carries the real window.
  const agent = mkdtempSync(join(tmpdir(), "agent-floor-"));
  (globalThis as any).__vscodeMock.config = { "pi-code-gui.rustAgentDir": agent, "pi-code-gui.contextBudget": 50_000 };
  initRustModels({} as any);
  await configureCatalogSource({ piPackagePath: join(agent, "no-pi-here") }).prepare(1000);
  setupRustModels();
  const o = ov(read(join(agent, "models.json")), "deepseek");
  const big = (registry as any).providers.deepseek.models.find((m: any) => m.contextWindow > 50_000);
  assert.ok(big, "the floor carries a deepseek model wider than the budget");
  assert.equal(o[big.id].contextWindow, big.contextWindow);
});

test("setupRustModels gates each created model on Pi's connection for that model", async () => {
  // The production path: an installed Pi whose openrouter mixes connections, first model on rust-pi's.
  const agent = mkdtempSync(join(tmpdir(), "agent-pi-"));
  (globalThis as any).__vscodeMock.config = { "pi-code-gui.rustAgentDir": agent };
  initRustModels({} as any);
  const pi = join(agent, "pi");
  mkdirSync(pi);
  writeFileSync(join(pi, "package.json"), JSON.stringify({ version: "9.9.9" }));
  const m = (id: string, api: string, baseUrl: string) => ({ provider: "openrouter", id, name: id, api, baseUrl, reasoning: false, contextWindow: 100_000, maxTokens: 8_000, input: ["text"] });
  const models = [m("vendor/on-rust", "openai-completions", "https://openrouter.ai/api/v1"), m("vendor/elsewhere", "anthropic-messages", "https://openrouter.ai/api")];
  const snap = await configureCatalogSource({
    piPackagePath: pi, agentDir: agent, catalogModelsPath: join(agent, "absent", "models.json"),
    importModule: async () => ({ VERSION: "9.9.9", ModelRuntime: { create: async () => ({ getModels: () => models }) } }),
  }).prepare(2000);
  assert.equal(snap.kind, "pi");
  setupRustModels();
  assert.deepEqual(Object.keys(ov(read(join(agent, "models.json")), "openrouter")), ["vendor/on-rust"]);
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

// ── the credential predicate (rust-service's stale-model recovery) ──

test("providerHasCredential: finds a provider by its auth env key", () => {
  assert.equal(providerHasCredential("deepseek", { DEEPSEEK_API_KEY: "sk-x" }, new Set()), true);
  assert.equal(providerHasCredential("deepseek", {}, new Set()), false);
});

test("providerHasCredential: an empty or whitespace key does not count", () => {
  assert.equal(providerHasCredential("deepseek", { DEEPSEEK_API_KEY: "" }, new Set()), false);
  assert.equal(providerHasCredential("deepseek", { DEEPSEEK_API_KEY: "   " }, new Set()), false);
});

test("providerHasCredential: honours irregular env keys, mirroring `pi --list-providers`", () => {
  assert.equal(providerHasCredential("huggingface", { HF_TOKEN: "hf-x" }, new Set()), true, "not HUGGINGFACE_API_KEY");
  assert.equal(providerHasCredential("zai", { ZHIPU_API_KEY: "z" }, new Set()), true, "not ZAI_API_KEY");
  assert.equal(providerHasCredential("opencode-go", { OPENCODE_API_KEY: "o" }, new Set()), true, "not OPENCODE_GO_API_KEY");
  assert.equal(providerHasCredential("moonshotai", { KIMI_API_KEY: "k" }, new Set()), true, "either alias works");
});

test("oauthProviders: an OAuth login counts, with no env key at all", () => {
  const dir = mkdtempSync(join(tmpdir(), "scope-oauth-"));
  writeFileSync(join(dir, "auth.json"), JSON.stringify({ anthropic: { type: "oauth", access: "x" } }));
  assert.equal(providerHasCredential("anthropic", {}, oauthProviders(dir)), true);
});

test("oauthProviders: a corrupt auth.json degrades to env only", () => {
  const dir = mkdtempSync(join(tmpdir(), "scope-corrupt-"));
  writeFileSync(join(dir, "auth.json"), "{ not json");
  assert.equal(oauthProviders(dir).size, 0);
  assert.equal(providerHasCredential("deepseek", { DEEPSEEK_API_KEY: "sk-x" }, oauthProviders(dir)), true);
});

// ── approval mode ───────────────────────────────────────────────────

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

