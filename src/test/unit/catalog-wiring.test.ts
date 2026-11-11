// Design S phase D: the catalog source (src/catalog-source.ts) wired into the running extension.
//
// What is pinned here, each against the REAL production seam (PiService, its RustDeps/SdkDeps, the
// extension's activate/deactivate helpers) with a FAKE installed Pi injected through
// configureCatalogSource — nothing here loads the real Pi, reads a real agent home or touches the
// network:
//   - the Rust start awaits catalogSource().prepare(2500) before setupRustModels (else the merge
//     always sees "not ready" and writes nothing), and logs which catalog it used (D7);
//   - the first TypeScript session reconciles against the same catalog (prepare awaited there too);
//   - pricing, thinking and the fallback picker read the catalog source, not the bundled floor;
//   - a successful session start triggers one background refresh;
//   - models.json is written ONLY by a Rust session start (C28(2)): never by a TS start or a refresh;
//   - the host configures the source at activate (globalState throttle, globalStorage path) and
//     disposes it at deactivate;
//   - the context-budget picker says it applies to TypeScript sessions only (C27 give-up 2).

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as vscode from "vscode";
import { configureCatalogSource, catalogSource, type ThrottleStore } from "../../catalog-source.js";
import { initRustModels } from "../../rust-models.js";
import { initLogger } from "../../logger.js";
import { PiService } from "../../pi-service.js";
import { RustService } from "../../rust-service.js";
import { SdkService } from "../../sdk-service.js";
import { PiWebviewPanel } from "../../webview-panel.js";
import { configureHostCatalogSource, deactivate } from "../../extension.js";
import type { BackendUsage } from "../../pi-backend.js";
import floor from "../../model-registry.generated.json";

type Any = ReturnType<typeof JSON.parse>;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
function scratch(prefix: string): string { return mkdtempSync(join(tmpdir(), `catalog-wiring-${prefix}-`)); }

/** A Pi chat model as ModelRuntime.getModels() returns it. deepseek-chat is an id the pinned rust-pi
 *  lists itself (src/rust-pi-catalog.generated.json), on the connection Pi uses, so the merge adjusts it. */
function piModel(provider: string, id: string, extra: Record<string, unknown> = {}): Any {
  return {
    provider, id, name: `${id} (from the source)`, api: "openai-completions", baseUrl: "https://api.deepseek.com",
    reasoning: true, input: ["text"], contextWindow: 131072, maxTokens: 8192,
    cost: { input: 7.77, output: 8.88, cacheRead: 0.5, cacheWrite: 0 }, ...extra,
  };
}

/** Configure the host's shared catalog source over a FAKE installed Pi. */
function fakeSource(o: { models?: Any[]; importDelayMs?: number; neverLoads?: boolean; throttle?: ThrottleStore } = {}): { calls: { refresh: number; imports: number } } {
  const root = scratch("pkg");
  writeFileSync(join(root, "package.json"), JSON.stringify({ name: "@earendil-works/pi-coding-agent", version: "9.9.9" }));
  const calls = { refresh: 0, imports: 0 };
  const models = o.models ?? [piModel("deepseek", "deepseek-chat")];
  const rt = { getModels: () => models, refresh: async () => { calls.refresh++; return { aborted: false, errors: new Map() }; } };
  let stamp: number | undefined;
  configureCatalogSource({
    piPackagePath: root,
    agentDir: scratch("agent"),
    catalogModelsPath: join(scratch("catalog-only"), "models.json"),
    importModule: async () => {
      calls.imports++;
      if (o.neverLoads) { await new Promise(() => {}); }
      if (o.importDelayMs) { await sleep(o.importDelayMs); }
      return { VERSION: "9.9.9", ModelRuntime: { create: async () => rt } };
    },
    throttle: o.throttle ?? { get: () => stamp, set: (at) => { stamp = at; } },
    log: { debug: () => {}, warn: () => {} },
  });
  return { calls };
}

/** A scratch Rust agent home (pi-code-gui.rustAgentDir) holding `models.json` = `content`. */
function rustHome(content = "{}\n"): { dir: string; file: string } {
  const dir = scratch("rusthome");
  const file = join(dir, "models.json");
  writeFileSync(file, content);
  (globalThis as Any).__vscodeMock.config = { "pi-code-gui.rustAgentDir": dir };
  initRustModels({} as Any);
  return { dir, file };
}

/** Capture the output channel (piLog/piWarn/piDebug). */
function captureLog(): string[] {
  const lines: string[] = [];
  const rec = (lvl: string) => (m: string) => { lines.push(`${lvl} ${m}`); };
  initLogger({ debug: rec("debug"), info: rec("info"), warn: rec("warn") } as Any);
  return lines;
}

const fileState = (f: string) => ({ bytes: readFileSync(f, "utf8"), mtimeMs: statSync(f).mtimeMs });

test("initializeRust awaits prepare (2500 ms) before setupModels", async () => {
  // Ready within the budget: the merge sees Pi's catalog and writes it, and the log names the source (D7).
  const log = captureLog();
  fakeSource({ importDelayMs: 300 });
  const { file } = rustHome();
  const deps = (new PiService() as Any).makeRustDeps();
  const out = await deps.setupModels();
  assert.equal(out.piEnv.PI_CODING_AGENT_DIR !== undefined, true);
  const written = JSON.parse(readFileSync(file, "utf8"));
  assert.equal(written.providers?.deepseek?.modelOverrides?.["deepseek-chat"]?.cost?.input, 7.77,
    "the Rust start waited for the catalog and merged Pi's values");
  assert.ok(log.some((l) => /^info Model catalog for this Rust session: Pi's catalog \(pi-coding-agent 9\.9\.9\)/.test(l)), log.join("\n"));

  // Not ready within 2500 ms: the start goes on after the budget and writes nothing.
  fakeSource({ neverLoads: true });
  const home2 = rustHome();
  const before = fileState(home2.file);
  const t0 = Date.now();
  await (new PiService() as Any).makeRustDeps().setupModels();
  const took = Date.now() - t0;
  assert.ok(took >= 2400 && took < 3400, `waited ${took} ms, the 2500 ms budget`);
  assert.deepEqual(fileState(home2.file), before, "nothing written when the catalog is not ready");
});

test("bundledProviders reads the catalog source", async () => {
  // The lookup seam for prices (activeCostRates), thinking (currentFullModel) and the SDK's reconcile.
  fakeSource({ models: [piModel("acme", "m1")] });
  const pi = new PiService() as Any;
  pi._backendKind = "rust";
  pi._rust = { getModel: () => ({ provider: "acme", id: "m1" }), capabilities: { thinkingLevelLive: () => true } };
  assert.equal(pi.activeCostRates(), null, "before the source is ready: the bundled floor, which has no acme");
  await catalogSource().prepare(2500);
  assert.deepEqual(pi.activeCostRates(), { input: 7.77, output: 8.88, cacheRead: 0.5, cacheWrite: 0 });
  assert.equal(pi.catalogProviders.acme.models[0].name, "m1 (from the source)");
  assert.equal(pi.supportedThinkingLevels().length > 1, true, "thinking capability from the source (reasoning: true)");
});

test("while the catalog is not ready, prices and thinking read the bundled floor", async () => {
  // Review D S3: "none" (loading, not ready, failed) keeps the pre-catalog behaviour for lookups.
  fakeSource({ neverLoads: true });
  const pi = new PiService() as Any;
  pi._backendKind = "rust";
  pi._rust = { getModel: () => ({ provider: "groq", id: "llama-3.3-70b-versatile" }), capabilities: { thinkingLevelLive: () => true } };
  const floorModel = (floor as Any).providers.groq.models.find((m: Any) => m.id === "llama-3.3-70b-versatile");
  assert.deepEqual(pi.activeCostRates(), floorModel.cost);
  assert.notEqual(pi.currentFullModel(), null);
});

test("pickModel fallback resolves against the catalog source", async () => {
  // With no runtime list, the static fallback is resolved against Pi's catalog at pick time.
  fakeSource({ models: [piModel("deepseek", "deepseek-v4-pro", { name: "Named by the source" })] });
  await catalogSource().prepare(2500);
  (globalThis as Any).__vscodeMock.config = {};
  const pi = new PiService();
  let offered: Any[] = [];
  const realPick = vscode.window.showQuickPick;
  (vscode.window as Any).showQuickPick = async (items: Any[]) => { offered = items; return undefined; };
  try { await pi.pickModel(); } finally { (vscode.window as Any).showQuickPick = realPick; }
  assert.ok(offered.some((i) => i.provider === "deepseek" && i.modelId === "deepseek-v4-pro" && /^Named by the source/.test(i.label)),
    JSON.stringify(offered.map((i) => i.label)));
});

test("the TypeScript session's catalog dep waits for the catalog source", async () => {
  // SdkService reconciles the first session's model against deps.catalogProviders() (R9): that dep
  // must wait for the source rather than read the floor while it is still loading.
  const log = captureLog();
  fakeSource({ models: [piModel("acme", "m1")], importDelayMs: 300 });
  const catalog = await (new PiService() as Any).makeSdkDeps().catalogProviders();
  assert.equal(catalog?.acme?.models?.[0]?.cost?.input, 7.77);
  assert.ok(log.some((l) => /^info Model catalog for this TypeScript session: Pi's catalog/.test(l)), log.join("\n"));
});

test("a successful session start triggers one background refresh", async () => {
  const { calls } = fakeSource();
  rustHome();
  const realInit = RustService.prototype.initialize;
  let result = { success: true };
  (RustService.prototype as Any).initialize = async () => result;
  try {
    const pi = new PiService();
    await pi.initialize({ fresh: true, runtime: "rust" });
    await sleep(50);
    assert.equal(calls.refresh, 1, "one refresh after the start");
    await pi.initialize({ fresh: true, runtime: "rust" });
    await sleep(50);
    assert.equal(calls.refresh, 1, "a second start inside the host throttle does not refresh again");

    const failed = fakeSource();
    result = { success: false };
    await new PiService().initialize({ fresh: true, runtime: "rust" });
    await sleep(50);
    assert.equal(failed.calls.refresh, 0, "a failed start does not refresh");
  } finally { (RustService.prototype as Any).initialize = realInit; }
});

test("a TS session start and a catalog refresh never write models.json", async () => {
  // C28(2): models.json is written only at a Rust session start. Our override values equal Pi's, so
  // a TS start has no reason to write it, and rust-pi reads it only at spawn.
  const { calls } = fakeSource();
  const { file } = rustHome();
  const before = fileState(file);
  const realInit = SdkService.prototype.initialize;
  (SdkService.prototype as Any).initialize = async function (this: Any) {
    await this.deps.catalogProviders();                       // the TS start's own catalog step
    this.session = { sessionId: "s1", subscribe: () => () => {} };
    this.sessionManager = { getEntries: () => [] };
    return { success: true, cycleModels: [] };
  };
  try {
    const out = await new PiService().initialize({ fresh: true, runtime: "typescript" });
    assert.equal(out.success, true, String((out as Any).error));
    await sleep(50);
    assert.equal(calls.refresh, 1, "the TS start triggered the refresh");
    await catalogSource().refreshInBackground();
    assert.deepEqual(fileState(file), before, "neither the TS start nor the refresh wrote models.json");
  } finally { (SdkService.prototype as Any).initialize = realInit; }
  // Control: the Rust start does write it, so the check above can see a write.
  await (new PiService() as Any).makeRustDeps().setupModels();
  assert.notEqual(readFileSync(file, "utf8"), before.bytes, "a Rust start writes models.json");
});

test("the host's catalog source is configured with the globalState throttle and a globalStorage path", async () => {
  const storage = scratch("globalStorage");
  const state = new Map<string, unknown>();
  const context: Any = {
    globalStorageUri: vscode.Uri.file(storage),
    globalState: { get: (k: string) => state.get(k), update: async (k: string, v: unknown) => { state.set(k, v); } },
  };
  const root = scratch("pkg");
  writeFileSync(join(root, "package.json"), JSON.stringify({ version: "9.9.9" }));
  let refreshes = 0;
  const pi = { piPackagePath: root, agentDir: scratch("agent"), log: { debug: () => {}, warn: () => {} },
    importModule: async () => ({ ModelRuntime: { create: async () => ({ getModels: () => [], refresh: async () => { refreshes++; return {}; } }) } }) };
  configureHostCatalogSource(context, pi);
  await catalogSource().refreshInBackground();
  assert.equal(refreshes, 1);
  assert.equal(typeof [...state.values()][0], "number", "the refresh time is kept in globalState");
  // A window reload: a fresh source over the same globalState is still inside the 4 h throttle.
  configureHostCatalogSource(context, pi);
  await catalogSource().refreshInBackground();
  assert.equal(refreshes, 1, "the throttle survives a reload");
  // The catalog-only models path lives under globalStorage: a file there stops the source.
  mkdirSync(join(storage, "catalog-only"), { recursive: true });
  writeFileSync(join(storage, "catalog-only", "models.json"), "{}");
  configureHostCatalogSource(context, pi);
  const snap = await catalogSource().prepare(2500);
  assert.equal(snap.kind, "none");
  assert.match((snap as Any).reason, new RegExp(join(storage, "catalog-only").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("activate configures the host's catalog source before any session can start", () => {
  // activate() needs a real VS Code (commands, trees, panels), so this half is structural.
  const ext = readFileSync(join(__dirnameOf(), "..", "..", "extension.js"), "utf-8");
  const body = ext.slice(ext.indexOf("async function activate("));
  const at = body.indexOf("configureHostCatalogSource(context)");
  assert.notEqual(at, -1, "activate() calls configureHostCatalogSource(context)");
  assert.ok(at < body.indexOf("registerEarlyCommands(context)"), "before any command can start a session");
});

test("deactivate disposes the catalog source", async () => {
  const { calls } = fakeSource();
  await deactivate();
  await catalogSource().refreshInBackground();
  assert.equal(calls.refresh, 0, "a disposed source never refreshes");
});

test("the budget picker says TypeScript sessions only", async () => {
  const opts: Any[] = [];
  const realPick = vscode.window.showQuickPick;
  (vscode.window as Any).showQuickPick = async (_items: Any, o: Any) => { opts.push(o); return undefined; };
  try {
    await PiWebviewPanel.prototype.triggerContextBudgetPicker.call({ piService: { getContextBudget: () => 0 } } as Any);
  } finally { (vscode.window as Any).showQuickPick = realPick; }
  assert.match(String(opts[0]?.placeHolder), /TypeScript sessions only/);
  const pkg = JSON.parse(readFileSync(join(__dirnameOf(), "..", "..", "..", "package.json"), "utf-8"));
  assert.match(pkg.contributes.configuration.properties["pi-code-gui.contextBudget"].description, /TypeScript sessions only/);
});

test("BackendUsage carries the Rust cost inputs, so PiService prices with them", () => {
  // C31 (phase C review N4): the Rust-only fields are part of the seam's type, so a field-by-field
  // copy cannot silently drop them.
  const usage: BackendUsage = {
    input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.5, contextPercent: null, contextWindow: 0,
    uncosted: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, uncostedOtherModel: false, uncostedUnread: false, costUnknown: "aborted",
  };
  const pi = new PiService() as Any;
  pi._backendKind = "rust";
  pi._rust = { getUsage: () => usage, getModel: () => null };
  assert.equal(pi.getUsageStats().costKnown, false);
});

function __dirnameOf(): string { return join(new URL(".", import.meta.url).pathname); }

test("a session the user closed while it was starting shows no init-failed error and offers no Retry", () => {
  // Review D R2: initSessionInBackground needs a real VS Code (panels, toasts), so this is structural. Closing the
  // only Rust tab during the catalog wait used to reach "Pi init failed … Retry", and Retry reopened the tab.
  const ext = readFileSync(join(__dirnameOf(), "..", "..", "extension.js"), "utf-8");
  const body = ext.slice(ext.indexOf("async function initSessionInBackground("));
  const guard = body.search(/if \(result\.errorKind === "closed" \|\| !sessions\.includes\(sw\)\) \{\s*return;\s*\}/);
  assert.notEqual(guard, -1, "initSessionInBackground returns quietly for a session that was closed");
  assert.ok(guard > body.indexOf("sw.piService.initialize("), "the guard follows the initialize call");
  assert.ok(guard < body.indexOf("if (!result.success)"), "and comes before any failure is shown");
});
