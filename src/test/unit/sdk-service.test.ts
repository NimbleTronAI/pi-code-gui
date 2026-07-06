// Headless tests for SdkService.initialize() — the 12-step TS-SDK resolve→load→
// adapt→auth→model→resources→tools→session sequence. This was the audits' #1
// coverage gap (the DEFAULT runtime's init had zero tests, while the Rust init is
// fully covered). SdkService is vscode-free: every environment dependency (config,
// cwd, dynamic module import, fs, bridge-tool assembly, UI nudge) is injected via
// SdkDeps, so the real init path runs here against fake SDK/AI modules + stubbed deps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SdkService, type SdkHost, type SdkDeps, type SdkConfig } from "../../sdk-service.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

/** A fake pi-coding-agent SDK module — just enough surface for initialize(). */
function fakeSdk(over: Partial<Record<string, Any>> = {}): Any {
  const sessionManager = {
    getSessionFile: () => undefined,
    getEntries: () => [],
  };
  return {
    AuthStorage: { create: () => ({ setRuntimeApiKey: () => {} }) },
    ModelRegistry: {
      create: () => ({
        getAvailable: async () => [{ provider: "anthropic", id: "claude-opus-4-8", name: "Claude Opus 4.8" }],
        find: () => null,
      }),
    },
    SettingsManager: { create: () => ({}) },
    DefaultResourceLoader: class {
      async reload() {}
      getSkills() { return { skills: [] }; }
    },
    createCodingTools: () => [],
    createReadOnlyTools: () => [],
    defineTool: () => ({}),
    getAgentDir: () => "/agent",
    createSyntheticSourceInfo: () => ({}),
    SessionManager: {
      create: () => sessionManager,
      open: () => sessionManager,
      continueRecent: async () => sessionManager,
    },
    createAgentSession: async () => ({ session: { id: "session-1" } }),
    ...over,
  };
}

/** A fake pi-ai module. getModel present ⇒ the >=0.80 providers/all adapter is skipped. */
function fakeAi(over: Partial<Record<string, Any>> = {}): Any {
  return {
    getModel: (provider: string, id: string) => ({ provider, id, name: id, reasoning: true }),
    getProviders: () => [],
    complete: async () => ({}),
    ...over,
  };
}

const baseConfig: SdkConfig = { defaultThinkingLevel: "off", contextBudget: 0 };

/** Build (host, deps) with per-path module stubs and overridable behavior. */
function makeEnv(opts: {
  piRoot?: string | (() => string);
  modules?: (absPath: string) => Any;   // override module resolution
  config?: Partial<SdkConfig>;
} = {}): { host: SdkHost; deps: SdkDeps; notified: string[] } {
  const notified: string[] = [];
  const host: SdkHost = {
    emit: () => {},
    resolvePiRoot: typeof opts.piRoot === "function" ? opts.piRoot : () => (opts.piRoot as string) ?? "/fake/piroot",
  };
  const defaultModules = (absPath: string): Any => {
    if (absPath.includes("pi-ai/dist/index.js")) { return fakeAi(); }
    if (absPath.includes("providers/all.js")) { return { getBuiltinModel: () => null, builtinModels: () => ({ getModels: () => [], complete: async () => ({}) }) }; }
    if (absPath.includes("typebox")) { return { Type: {} }; }
    if (absPath.endsWith("dist/index.js")) { return fakeSdk(); }
    throw new Error(`unexpected import: ${absPath}`);
  };
  const deps: SdkDeps = {
    workspaceCwd: () => "/fake/cwd",
    config: () => ({ ...baseConfig, ...opts.config }),
    importModule: async (absPath) => (opts.modules ?? defaultModules)(absPath),
    fileExists: () => false,
    readFileUtf8: async () => { throw new Error("no pkg (skip version check)"); },
    notifyOutdatedPiAi: (installed) => notified.push(installed),
    buildBridgeTools: () => [],
    catalogProviders: () => ({}),
  };
  return { host, deps, notified };
}

test("happy path → success, model + cycleModels + clamped thinking level", async () => {
  const { host, deps } = makeEnv();
  const out = await new SdkService(host, deps).initialize({ fresh: true, openPath: null });
  assert.equal(out.success, true, out.error);
  assert.equal(out.model?.id, "claude-opus-4-8");
  assert.deepEqual(out.cycleModels, [{ provider: "anthropic", id: "claude-opus-4-8" }]);
  assert.equal(typeof out.thinkingLevel, "string");
  assert.equal(out.isResuming, false);
});

test("resolvePiRoot throwing → success:false 'SDK not found'", async () => {
  const { host, deps } = makeEnv({ piRoot: () => { throw new Error("nope"); } });
  const out = await new SdkService(host, deps).initialize({ fresh: true, openPath: null });
  assert.equal(out.success, false);
  assert.match(out.error ?? "", /SDK not found/);
});

test("pi-coding-agent module import failure → 'Failed to load pi-coding-agent'", async () => {
  const { host, deps } = makeEnv({
    modules: (p) => { if (p.endsWith("dist/index.js") && !p.includes("pi-ai")) { throw new Error("boom"); } return {}; },
  });
  const out = await new SdkService(host, deps).initialize({ fresh: true, openPath: null });
  assert.equal(out.success, false);
  assert.match(out.error ?? "", /Failed to load pi-coding-agent/);
});

test("pi-ai >=0.80 (no getModel) + providers/all import fails → actionable error", async () => {
  const { host, deps } = makeEnv({
    modules: (p) => {
      if (p.includes("pi-ai/dist/index.js")) { return { complete: async () => ({}) }; } // no getModel
      if (p.includes("providers/all.js")) { throw new Error("all.js missing"); }
      if (p.includes("typebox")) { return { Type: {} }; }
      if (p.endsWith("dist/index.js")) { return fakeSdk(); }
      return {};
    },
  });
  const out = await new SdkService(host, deps).initialize({ fresh: true, openPath: null });
  assert.equal(out.success, false);
  assert.match(out.error ?? "", /providers\/all entrypoint could not load/);
});

test("no model available (empty registry + no built-ins) → 'No model available'", async () => {
  const { host, deps } = makeEnv({
    modules: (p) => {
      if (p.includes("pi-ai/dist/index.js")) { return fakeAi({ getModel: () => null }); }
      if (p.includes("typebox")) { return { Type: {} }; }
      if (p.endsWith("dist/index.js")) {
        return fakeSdk({ ModelRegistry: { create: () => ({ getAvailable: async () => [], find: () => null }) } });
      }
      return {};
    },
  });
  const out = await new SdkService(host, deps).initialize({ fresh: true, openPath: null });
  assert.equal(out.success, false);
  assert.match(out.error ?? "", /No model available/);
});

test("createAgentSession throwing → 'createAgentSession failed'", async () => {
  const { host, deps } = makeEnv({
    modules: (p) => {
      if (p.includes("pi-ai/dist/index.js")) { return fakeAi(); }
      if (p.includes("typebox")) { return { Type: {} }; }
      if (p.endsWith("dist/index.js")) { return fakeSdk({ createAgentSession: async () => { throw new Error("no session"); } }); }
      return {};
    },
  });
  const out = await new SdkService(host, deps).initialize({ fresh: true, openPath: null });
  assert.equal(out.success, false);
  assert.match(out.error ?? "", /createAgentSession failed/);
});

test("runtime API keys from config are applied to auth storage", async () => {
  const applied: Array<[string, string]> = [];
  const { host, deps } = makeEnv({
    config: { anthropicApiKey: "sk-ant", openaiApiKey: "sk-oai" },
    modules: (p) => {
      if (p.includes("pi-ai/dist/index.js")) { return fakeAi(); }
      if (p.includes("typebox")) { return { Type: {} }; }
      if (p.endsWith("dist/index.js")) {
        return fakeSdk({ AuthStorage: { create: () => ({ setRuntimeApiKey: (prov: string, key: string) => applied.push([prov, key]) }) } });
      }
      return {};
    },
  });
  const out = await new SdkService(host, deps).initialize({ fresh: true, openPath: null });
  assert.equal(out.success, true, out.error);
  assert.deepEqual(applied, [["anthropic", "sk-ant"], ["openai", "sk-oai"]]);
});
