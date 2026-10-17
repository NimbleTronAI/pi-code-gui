// The catalog source (Design S v4, phase A): where the Rust models.json merge gets "Pi's own values".
// The rule it serves: on Rust the extension only adjusts models rust-pi already supports, using
// exactly the values Pi itself uses. So the source is the INSTALLED Pi's catalog — read through a
// catalog-only ModelRuntime (no models.json of its own, the shared models-store.json) — or, only when
// no TypeScript Pi is installed at all, the bundled floor. Anything in between is "none": the merge
// writes nothing that start. The only network-capable call is refreshInBackground(), which inherits
// Pi's own PI_OFFLINE, TTL and ETags (it never passes allowNetwork, force or catalogBaseUrl — C24),
// and whose credentials are read-only, so a catalog refresh can never rotate an OAuth token in the
// user's auth.json.
//
// Every test injects a fake Pi SDK; nothing here loads the real Pi or touches the network.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCatalogSource, slimCatalog, rustExpressibleProvider, REFRESH_INTERVAL_MS, type ThrottleStore } from "../../catalog-source.js";
import registry from "../../model-registry.generated.json";

function scratch(prefix: string): string { return mkdtempSync(join(tmpdir(), `catalog-source-${prefix}-`)); }

/** A Pi chat model as ModelRuntime.getModels() returns it (only the fields the slim transform reads). */
function model(provider: string, id: string, extra: Record<string, unknown> = {}): any {
  return {
    provider, id, name: `${id} name`, api: "openai-completions", baseUrl: `https://${provider}.example/v1`,
    reasoning: false, input: ["text"], contextWindow: 128000, maxTokens: 8192,
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0, tiers: [{ above: 1, input: 9, output: 9 }] },
    headers: { "x-unwritten": "1" }, ...extra,
  };
}

interface FakePi {
  root: string; agentDir: string;
  calls: { create: any[]; refresh: any[]; imports: string[] };
  creds: () => any;
  setModels(models: any[]): void;
  importModule(p: string): Promise<any>;
}

/** A fake installed TS Pi: a package dir with package.json, and an SDK whose ModelRuntime is scripted. */
function fakePi(o: {
  version?: string; models?: any[];
  create?: (opts: any) => Promise<void>;          // runs before create() resolves (delay / throw)
  refresh?: (opts: any, creds: any) => Promise<any>;
  noModelRuntime?: boolean;
} = {}): FakePi {
  const root = scratch("pkg");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: o.version ?? "1.3.0" }));
  const agentDir = scratch("agent");
  const calls = { create: [] as any[], refresh: [] as any[], imports: [] as string[] };
  let models = o.models ?? [model("acme", "m1")];
  let creds: any;
  const rt = {
    getModels: () => models,
    refresh: async (opts: any) => {
      calls.refresh.push(opts);
      return o.refresh ? o.refresh(opts, creds) : { aborted: false, errors: new Map() };
    },
  };
  const SDK: any = {
    VERSION: o.version ?? "1.3.0",
    getAgentDir: () => agentDir,
    ModelRuntime: o.noModelRuntime ? undefined : {
      create: async (opts: any) => {
        calls.create.push(opts);
        creds = opts?.credentials;
        if (o.create) { await o.create(opts); }
        return rt;
      },
    },
  };
  return {
    root, agentDir, calls, creds: () => creds,
    setModels: (m) => { models = m; },
    importModule: async (p: string) => { calls.imports.push(p); return SDK; },
  };
}

function memoryThrottle(): ThrottleStore & { value?: number } {
  const t: ThrottleStore & { value?: number } = { get: () => t.value, set: (at: number) => { t.value = at; } };
  return t;
}

const quiet = { debug: () => {}, warn: () => {} };

function sourceFor(pi: FakePi, extra: Record<string, unknown> = {}) {
  return createCatalogSource({
    piPackagePath: pi.root, importModule: (p) => pi.importModule(p),
    catalogModelsPath: join(scratch("absent"), "never", "models.json"), log: quiet, ...extra,
  });
}

// ── 1 ────────────────────────────────────────────────────────────────────────────────────────────

test("providers() returns the installed Pi's catalog whatever its age", { timeout: 10_000 }, async () => {
  // An OLD Pi (the 0.80.8 floor of support) whose catalog prices acme/m1 at 7/70 — and a provider the
  // bundled floor has never heard of. No freshness gate: what the installed Pi says is what we use,
  // because that is what its own CLI and TypeScript sessions show.
  const pi = fakePi({ version: "0.80.8", models: [model("acme", "m1", { cost: { input: 7, output: 70, cacheRead: 0.7, cacheWrite: 0 } })] });
  const src = sourceFor(pi);
  const snap = await src.prepare(2500);
  assert.equal(snap.kind, "pi");
  assert.deepEqual(src.providers(), snap);
  if (snap.kind !== "pi") { return; }
  assert.deepEqual(Object.keys(snap.providers), ["acme"]);
  assert.deepEqual(snap.providers.acme.models[0].cost, { input: 7, output: 70, cacheRead: 0.7, cacheWrite: 0 });
  assert.match(snap.label, /0\.80\.8/);
  // The runtime is catalog-only: a models.json path that does not exist, and Pi's shared store.
  const opts = pi.calls.create[0];
  assert.equal(existsSync(opts.modelsPath), false);
  assert.equal(opts.modelsStorePath, join(pi.agentDir, "models-store.json"));
  // A later catalog (after a refresh) is what the next call returns — never a cached copy.
  pi.setModels([model("acme", "m1", { cost: { input: 8, output: 80, cacheRead: 0.8, cacheWrite: 0 } })]);
  const again = src.providers();
  assert.equal(again.kind === "pi" && again.providers.acme.models[0].cost?.input, 8);
});

// ── 2 ────────────────────────────────────────────────────────────────────────────────────────────

test("providers() is \"none\" while not ready and the floor only when no TS Pi is installed", { timeout: 10_000 }, async () => {
  // Not ready within the budget: none (the merge writes nothing this start; the last file stays).
  let release!: () => void;
  const slow = fakePi({ create: () => new Promise<void>((r) => { release = r; }) });
  const s1 = sourceFor(slow);
  assert.equal(s1.providers().kind, "none", "before prepare");
  const t0 = Date.now();
  assert.equal((await s1.prepare(30)).kind, "none", "budget elapsed");
  assert.ok(Date.now() - t0 < 2000, "prepare honours its budget");
  release();
  assert.equal((await s1.prepare(2500)).kind, "pi", "ready once create resolves");

  // Installed but failed to load: none, never the floor.
  const broken = fakePi({ create: async () => { throw new Error("boom"); } });
  const s2 = await sourceFor(broken).prepare(2500);
  assert.equal(s2.kind, "none");
  assert.match(s2.kind === "none" ? s2.reason : "", /boom/);

  const tooOld = fakePi({ noModelRuntime: true, version: "0.79.0" });
  assert.equal((await sourceFor(tooOld).prepare(2500)).kind, "none", "a Pi without ModelRuntime");

  const throwsOnImport = fakePi();
  const s3 = createCatalogSource({ piPackagePath: throwsOnImport.root, importModule: async () => { throw new Error("import failed"); },
    catalogModelsPath: join(scratch("absent"), "m.json"), log: quiet });
  assert.equal((await s3.prepare(2500)).kind, "none", "an import failure");

  // The catalog-only models.json path exists: that runtime would read a user's file — none, not the floor.
  const exists = fakePi();
  const present = join(scratch("present"), "models.json");
  writeFileSync(present, "{}");
  assert.equal((await sourceFor(exists, { catalogModelsPath: present }).prepare(2500)).kind, "none");
  assert.equal(exists.calls.create.length, 0, "never created over an existing models.json");

  // No TS Pi installed: the bundled floor, exactly.
  const absent = createCatalogSource({ piPackagePath: join(scratch("nopi"), "pi-coding-agent"),
    importModule: async () => { throw new Error("must not import"); }, log: quiet });
  const floor = await absent.prepare(2500);
  assert.equal(floor.kind, "floor");
  assert.deepEqual(floor.kind === "floor" ? floor.providers : null, (registry as any).providers);
  assert.match(floor.label, /not installed/);

  // Pi installed while the window is open (pi-code-gui.installPi): the next prepare finds it — only
  // "ready" is cached, never "absent" or "failed".
  const later = fakePi();
  const laterRoot = join(scratch("later"), "pi-coding-agent");
  const s4 = createCatalogSource({ piPackagePath: laterRoot, importModule: (p) => later.importModule(p),
    catalogModelsPath: join(scratch("absent"), "m.json"), log: quiet });
  assert.equal((await s4.prepare(2500)).kind, "floor");
  mkdirSync(laterRoot, { recursive: true });
  writeFileSync(join(laterRoot, "package.json"), JSON.stringify({ version: "1.3.0" }));
  assert.equal((await s4.prepare(2500)).kind, "pi", "an install after the first start is picked up");

  // The catalog-only models.json appearing AFTER create: Pi re-reads it on every refresh, so the
  // source stops — no refresh, and "none" from then on.
  const appears = fakePi();
  const appearsPath = join(scratch("appears"), "models.json");
  const s5 = sourceFor(appears, { catalogModelsPath: appearsPath, throttle: memoryThrottle() });
  assert.equal((await s5.prepare(2500)).kind, "pi");
  writeFileSync(appearsPath, "{}");
  await s5.refreshInBackground();
  assert.equal(appears.calls.refresh.length, 0, "no refresh over an existing models.json");
  assert.equal(s5.providers().kind, "none");
});

// ── 3 ────────────────────────────────────────────────────────────────────────────────────────────

test("providers() excludes a provider with a templated baseUrl, a special api or github-copilot", { timeout: 10_000 }, async () => {
  const pi = fakePi({ models: [
    model("acme", "m1"),
    model("cloudflare-workers-ai", "c1", { baseUrl: "https://api.cloudflare.com/client/v4/accounts/{CLOUDFLARE_ACCOUNT_ID}/ai/v1" }),
    model("amazon-bedrock", "b1", { api: "bedrock-converse-stream" }),
    model("azure-openai-responses", "a1", { api: "azure-openai-responses", baseUrl: "" }),
    model("google-vertex", "v1", { api: "google-vertex" }),
    model("openai-codex", "x1", { api: "openai-codex-responses" }),
    model("github-copilot", "g1"),
    model("emptyurl", "e1", { baseUrl: "" }),
  ] });
  const snap = await sourceFor(pi).prepare(2500);
  assert.deepEqual(snap.kind === "pi" ? Object.keys(snap.providers) : null, ["acme"]);
  assert.equal(rustExpressibleProvider("acme", { baseUrl: "https://x/v1", api: "openai-completions" }), true);
  assert.equal(rustExpressibleProvider("github-copilot", { baseUrl: "https://x/v1", api: "openai-completions" }), false);

  // The slim shape is the generator's, field for field: no tiers, no headers, no api/baseUrl per model.
  const slim = snap.kind === "pi" ? snap.providers.acme : null;
  assert.deepEqual(slim, { baseUrl: "https://acme.example/v1", api: "openai-completions", models: [{
    id: "m1", name: "m1 name", reasoning: false, contextWindow: 128000, maxTokens: 8192, input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
  }] });

  // SHARED WITH THE GENERATOR: the same predicate and transform, applied to the devDep pi-ai the
  // bundled floor was generated from, reproduce model-registry.generated.json exactly. A change to
  // either side that the other does not mirror turns this red.
  const all = await import("@earendil-works/pi-ai/providers/all");
  const builtins = all.getBuiltinProviders().flatMap((p: string) => all.getBuiltinModels(p as never) ?? []);
  assert.deepEqual(slimCatalog(builtins), (registry as any).providers);
});

// ── 4 ────────────────────────────────────────────────────────────────────────────────────────────

test("refreshInBackground never passes allowNetwork, force or catalogBaseUrl", { timeout: 10_000 }, async () => {
  const pi = fakePi();
  const src = sourceFor(pi, { throttle: memoryThrottle() });
  await src.refreshInBackground();
  assert.equal(pi.calls.refresh.length, 1);
  const r = pi.calls.refresh[0];
  assert.deepEqual(Object.keys(r), ["signal"], "refresh carries only an abort signal");
  assert.ok(r.signal instanceof AbortSignal);
  // create(): no network of its own, no catalog endpoint, never Pi's default credential store.
  const c = pi.calls.create[0];
  for (const k of ["allowNetwork", "force", "catalogBaseUrl", "authPath"]) { assert.equal(k in c, false, `create got ${k}`); }
  assert.equal(c.allowModelNetwork, false, "create restores the store locally; the network is refreshInBackground's alone");
  assert.ok(c.credentials, "read-only credentials are injected");
});

// ── 5 ────────────────────────────────────────────────────────────────────────────────────────────

test("refreshInBackground dedupes and throttles", { timeout: 10_000 }, async () => {
  let release!: () => void;
  const pi = fakePi({ refresh: () => new Promise((r) => { release = () => r({ aborted: false, errors: new Map() }); }) });
  let now = 1_000_000;
  const throttle = memoryThrottle();
  const src = sourceFor(pi, { throttle, now: () => now });
  const a = src.refreshInBackground();
  const b = src.refreshInBackground();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(pi.calls.refresh.length, 1, "concurrent calls share one refresh");
  release();
  await Promise.all([a, b]);
  assert.equal(throttle.value, 1_000_000);

  now += REFRESH_INTERVAL_MS - 1;
  await src.refreshInBackground();
  assert.equal(pi.calls.refresh.length, 1, "within the host interval: no refresh");

  // The throttle is per HOST (the store outlives a window reload): a new source sharing it waits too.
  const reloaded = fakePi();
  await sourceFor(reloaded, { throttle, now: () => now }).refreshInBackground();
  assert.equal(reloaded.calls.refresh.length, 0, "a reloaded window inherits the throttle");

  now += 2;
  const p = src.refreshInBackground();
  await new Promise((r) => setTimeout(r, 20));
  release();
  await p;
  assert.equal(pi.calls.refresh.length, 2, "after the interval: refreshed again");

  // dispose() aborts the in-flight refresh's signal, the promise settles, and nothing refreshes after.
  let signal!: AbortSignal;
  const disposing = fakePi({ refresh: (o) => new Promise((r) => { signal = o.signal; o.signal.addEventListener("abort", () => r({ aborted: true, errors: new Map() })); }) });
  const sd = sourceFor(disposing, { throttle: memoryThrottle() });
  const pending = sd.refreshInBackground();
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(signal.aborted, false, "a refresh starts with a live signal");
  sd.dispose();
  await pending;
  assert.equal(signal.aborted, true, "dispose aborts it");
  await sd.refreshInBackground();
  assert.equal(disposing.calls.refresh.length, 1, "no refresh after dispose");

  // A refresh that rejects is logged, never thrown — and a source with no TS Pi never refreshes.
  const warned: string[] = [];
  const failing = fakePi({ refresh: async () => { throw new Error("catalog 500"); } });
  await sourceFor(failing, { throttle: memoryThrottle(), log: { debug: () => {}, warn: (m: string) => warned.push(m) } }).refreshInBackground();
  assert.ok(warned.some((m) => m.includes("catalog 500")));
  const none = createCatalogSource({ piPackagePath: join(scratch("nopi"), "x"), importModule: async () => { throw new Error("no"); }, log: quiet, throttle: memoryThrottle() });
  await none.refreshInBackground();
});

// ── 6 ────────────────────────────────────────────────────────────────────────────────────────────

test("catalog refresh never writes auth.json", { timeout: 10_000 }, async () => {
  // An expired OAuth login and a literal API key, as Pi's /login writes them.
  const expired = { type: "oauth", access: "old-access", refresh: "old-refresh", expires: 1 };
  let updaterCalls = 0;
  let modifyResult: unknown = "not run";
  let readBack: any;
  let listed: any;
  let deleteError: unknown;
  const pi = fakePi({
    refresh: async (_opts, creds) => {
      // What pi-ai does for an expiring OAuth token: modify() with an updater that would call the
      // provider's token endpoint and rotate the refresh token. Read-only means it never runs.
      modifyResult = await creds.modify("anthropic", async () => { updaterCalls++; return { ...expired, access: "new" }; });
      try { await creds.delete("openrouter"); } catch (e) { deleteError = e; }
      readBack = await creds.read("openrouter");
      listed = await creds.list();
      return { aborted: false, errors: new Map() };
    },
  });
  const authPath = join(pi.agentDir, "auth.json");
  const bytes = JSON.stringify({ anthropic: expired, openrouter: { type: "api_key", key: "sk-or-literal-key" }, cmd: { type: "api_key", key: "!security find-generic-password" }, tmpl: { type: "api_key", key: "$OPENROUTER_KEY" } }, null, 2);
  writeFileSync(authPath, bytes);
  const before = statSync(authPath).mtimeMs;
  const entriesBefore = readdirSync(pi.agentDir).sort();

  await sourceFor(pi, { throttle: memoryThrottle() }).refreshInBackground();
  assert.equal(pi.calls.refresh.length, 1);
  assert.equal(modifyResult, undefined, "modify reports no credential, so the provider is skipped");
  assert.equal(updaterCalls, 0, "the OAuth updater is never invoked");
  assert.equal(deleteError, undefined, "delete is a no-op, not a throw");
  assert.deepEqual(readBack, { type: "api_key", key: "sk-or-literal-key" }, "stored credentials are readable");
  // A command-backed or templated key is never resolved by a background refresh — and read REJECTS
  // rather than reporting "nothing stored", or pi-ai would fall back to an ambient env key that is not
  // the key the user's Pi uses for that provider, and store that key's personal catalog.
  await assert.rejects(pi.creds().read("cmd"), /not resolved/);
  await assert.rejects(pi.creds().read("tmpl"), /not resolved/);
  assert.deepEqual(listed.map((e: any) => e.providerId).sort(), ["anthropic", "cmd", "openrouter", "tmpl"]);
  assert.equal(readFileSync(authPath, "utf8"), bytes, "auth.json bytes unchanged");
  assert.equal(statSync(authPath).mtimeMs, before, "auth.json mtime unchanged");
  assert.deepEqual(readdirSync(pi.agentDir).sort(), entriesBefore, "no lock or temp file left");

  // With no auth.json at all, none is created (Pi's own AuthStorage would create one).
  let freshRead: unknown = "not run"; let freshList: unknown = "not run";
  const fresh = fakePi({ refresh: async (_o, creds) => { freshRead = await creds.read("x"); freshList = await creds.list(); return { aborted: false, errors: new Map() }; } });
  mkdirSync(fresh.agentDir, { recursive: true });
  await sourceFor(fresh, { throttle: memoryThrottle() }).refreshInBackground();
  assert.equal(freshRead, undefined);
  assert.deepEqual(freshList, []);
  assert.equal(existsSync(join(fresh.agentDir, "auth.json")), false);
});

// ── 7 ────────────────────────────────────────────────────────────────────────────────────────────

test("an auth.json that exists but cannot be read makes read and list reject, so no ambient key is used", { timeout: 10_000 }, async () => {
  // Pi's own CLI rewrites auth.json in place (/login, token rotation), so a lockless read can see an
  // empty or partial file. "No credentials" there would let pi-ai fall back to an ambient env key
  // and store that key's personalized catalog in the shared store. ONLY a missing file is "none".
  const SECRET = "sk-or-secret-do-not-log";
  const cases: Array<[string, (p: string) => void]> = [
    ["empty (as mid-write)", (p) => writeFileSync(p, "")],
    ["whitespace only", (p) => writeFileSync(p, "  \n")],
    ["truncated JSON", (p) => writeFileSync(p, `{"openrouter":{"type":"api_key","key":"${SECRET}"`)],
    ["not JSON", (p) => writeFileSync(p, `garbage ${SECRET}`)],
    ["a non-object root (array)", (p) => writeFileSync(p, "[]")],
    ["a non-object root (null)", (p) => writeFileSync(p, "null")],
    ["unreadable (a directory)", (p) => mkdirSync(p)],
  ];
  for (const [name, plant] of cases) {
    let readError: unknown = "not run";
    let listError: unknown = "not run";
    const pi = fakePi({
      refresh: async (_o, creds) => {
        try { await creds.read("openrouter"); readError = undefined; } catch (e) { readError = e; }
        try { await creds.list(); listError = undefined; } catch (e) { listError = e; }
        return { aborted: false, errors: new Map() };
      },
    });
    plant(join(pi.agentDir, "auth.json"));
    const warned: string[] = [];
    const src = sourceFor(pi, { throttle: memoryThrottle(), log: { debug: (m: string) => warned.push(m), warn: (m: string) => warned.push(m) } });
    assert.equal((await src.prepare(2500)).kind, "pi", `${name}: the catalog still loads`);
    await src.refreshInBackground();
    assert.ok(readError instanceof Error, `${name}: read rejects`);
    assert.ok(listError instanceof Error, `${name}: list rejects`);
    assert.match(readError.message, /auth\.json exists/, `${name}: read rejects from the auth.json check`);
    assert.match(listError.message, /auth\.json exists/, `${name}: list rejects from the auth.json check`);
    assert.ok(!readError.message.includes(SECRET) && !listError.message.includes(SECRET), `${name}: the errors never carry file content`);
    assert.ok(!warned.some((m) => m.includes(SECRET)), `${name}: nothing logged carries file content`);
  }

  // A MISSING auth.json (ENOENT) is the one "no credentials": read gives undefined, list gives [].
  // (Results are captured and asserted OUTSIDE the callback: refreshInBackground swallows its throws.)
  let noneRead: unknown = "not run"; let noneList: unknown = "not run";
  const none = fakePi({
    refresh: async (_o, creds) => { noneRead = await creds.read("openrouter"); noneList = await creds.list(); return { aborted: false, errors: new Map() }; },
  });
  await sourceFor(none, { throttle: memoryThrottle() }).refreshInBackground();
  assert.equal(noneRead, undefined);
  assert.deepEqual(noneList, []);
  assert.equal(existsSync(join(none.agentDir, "auth.json")), false, "a missing auth.json stays missing");

  // A valid file with a BOM is still readable (the existing behaviour).
  let bomRead: unknown = "not run";
  const bom = fakePi({
    refresh: async (_o, creds) => { bomRead = await creds.read("openrouter"); return { aborted: false, errors: new Map() }; },
  });
  writeFileSync(join(bom.agentDir, "auth.json"), "\uFEFF" + JSON.stringify({ openrouter: { type: "api_key", key: "k" } }));
  await sourceFor(bom, { throttle: memoryThrottle() }).refreshInBackground();
  assert.deepEqual(bomRead, { type: "api_key", key: "k" });
});
