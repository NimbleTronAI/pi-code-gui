// Headless tests for SdkService.initialize() — the 12-step TS-SDK resolve→load→
// adapt→auth→model→resources→tools→session sequence. This was the audits' #1
// coverage gap (the DEFAULT runtime's init had zero tests, while the Rust init is
// fully covered). SdkService is vscode-free: every environment dependency (config,
// cwd, dynamic module import, fs, bridge-tool assembly, UI nudge) is injected via
// SdkDeps, so the real init path runs here against fake SDK/AI modules + stubbed deps.
import { test } from "node:test";
import assert from "node:assert/strict";
import { SdkService, type SdkHost, type SdkDeps, type SdkConfig } from "../../sdk-service.js";

type Any = ReturnType<typeof JSON.parse>;

/** A fake pi-coding-agent SDK module — just enough surface for initialize(). */
function fakeSdk(over: Partial<Record<string, Any>> = {}): Any {
  const sessionManager = {
    getSessionFile: () => undefined,
    getEntries: () => [],
  };
  return {
    // pi-coding-agent >= 0.80.8: the unified async ModelRuntime replaced AuthStorage + ModelRegistry.
    ModelRuntime: {
      create: async () => ({
        setRuntimeApiKey: async () => {},
        getAvailable: async () => [{ provider: "anthropic", id: "claude-opus-4-8", name: "Claude Opus 4.8" }],
        getModel: () => null,
        getAuth: async () => undefined,
        refresh: async () => {},
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
    confirmRendererConsent: async () => true,
  };
  return { host, deps, notified };
}

// ── PiBackend primitives (post-init session operations) ──────────────
// SdkService implements PiBackend; these drive the raw session ops against a fake
// session installed on the (public) fields, the same way PiService reaches them.

/** An SdkService with a scriptable fake session/manager/AI installed. `calls`
 *  records what the primitive drove on the session, for assertion. */
function makeService(sessionOver: Record<string, Any> = {}): { svc: SdkService; calls: Any[]; emitted: Any[] } {
  const calls: Any[] = [];
  const emitted: Any[] = [];
  const host: SdkHost = { emit: (e) => emitted.push(e), resolvePiRoot: () => "/fake" };
  const { deps } = makeEnv();
  const svc = new SdkService(host, deps);
  const session: Any = {
    prompt: async (t: string, o: Any) => calls.push(["prompt", t, o]),
    steer: (t: string) => calls.push(["steer", t]),
    followUp: async (t: string) => calls.push(["followUp", t]),
    clearQueue: () => calls.push(["clearQueue"]),
    getSteeringMessages: () => [],
    setModel: async (m: Any) => calls.push(["setModel", m]),
    setThinkingLevel: (l: string) => calls.push(["setThinkingLevel", l]),
    setAutoCompactionEnabled: async (v: boolean) => calls.push(["setAutoCompaction", v]),
    abortBash: () => calls.push(["abortBash"]),
    agent: { abort: () => calls.push(["agentAbort"]) },
    getContextUsage: () => ({ percent: 42, contextWindow: 200000 }),
    ...sessionOver,
  };
  svc.session = session;
  svc.AI = { getModel: (provider: string, id: string) => ({ provider, id, name: id }) } as Any;
  svc.modelRuntime = { getModel: () => null };
  svc.sessionManager = {
    getEntries: () => [
      { type: "message", message: { role: "assistant", usage: { input: 10, output: 5, cacheRead: 2, cacheWrite: 1, cost: { total: 0.03 } } } },
      { type: "message", message: { role: "assistant", usage: { input: 20, output: 7 } } },
      { type: "message", message: { role: "user" } },
    ],
  } as Any;
  return { svc, calls, emitted };
}

test("sendPrompt default → session.prompt with images option", async () => {
  const { svc, calls } = makeService();
  await svc.sendPrompt("hello", [{ b64: "x" }], undefined);
  assert.deepEqual(calls, [["prompt", "hello", { images: [{ b64: "x" }] }]]);
});

test("sendPrompt steer → session.steer; queue → session.followUp", async () => {
  const { svc, calls } = makeService();
  await svc.sendPrompt("a", undefined, "steer");
  await svc.sendPrompt("b", undefined, "queue");
  assert.deepEqual(calls, [["steer", "a"], ["followUp", "b"]]);
});

test("sendPrompt steer with images → throws (can't attach while streaming)", async () => {
  const { svc } = makeService();
  await assert.rejects(() => svc.sendPrompt("a", [{ b64: "x" }], "steer"), /Cannot attach images/);
});

test("sendPrompt steer failure → surfaces a friendly error card, does not throw", async () => {
  const { svc, calls, emitted } = makeService({ steer: () => { throw new Error("extension commands cannot be queued"); } });
  await svc.sendPrompt("/tldr", undefined, "steer");
  assert.equal(calls.length, 0);
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].type, "custom-message");
  assert.equal(emitted[0].data.customType, "error");
});

test("setModel resolves + applies + returns identity", async () => {
  const { svc, calls } = makeService();
  const applied = await svc.setModel("anthropic", "claude-opus-4-8");
  assert.deepEqual(applied, { id: "claude-opus-4-8", provider: "anthropic" });
  assert.equal(calls[0][0], "setModel");
});

test("setModel unresolvable → null, no session.setModel", async () => {
  const { svc, calls } = makeService();
  svc.AI = { getModel: () => null } as Any;
  svc.modelRuntime = { getModel: () => null };
  const applied = await svc.setModel("nope", "nope");
  assert.equal(applied, null);
  assert.equal(calls.length, 0);
});

test("setThinkingLevel drives the session and echoes the level", async () => {
  const { svc, calls } = makeService();
  const eff = await svc.setThinkingLevel("high");
  assert.equal(eff, "high");
  assert.deepEqual(calls, [["setThinkingLevel", "high"]]);
});

test("abort kills bash then the agent turn", () => {
  const { svc, calls } = makeService();
  svc.abort();
  assert.deepEqual(calls, [["abortBash"], ["agentAbort"]]);
});

test("getUsage sums assistant entries + reads live context", () => {
  const { svc } = makeService();
  const u = svc.getUsage();
  assert.deepEqual(u, { input: 30, output: 12, cacheRead: 2, cacheWrite: 1, cost: 0.03, contextPercent: 42, contextWindow: 200000 });
});

test("getSlashCommands: extension-runner commands + builtin templates", () => {
  const { svc } = makeService({ _extensionRunner: { getRegisteredCommands: () => [{ invocationName: "tldr", description: "summarize", sourceInfo: { source: "pi-tldr" } }] } });
  const cmds = svc.getSlashCommands();
  assert.ok(cmds.some((c) => c.cmd === "/tldr" && c.source === "extension (pi-tldr)"), "extension command mapped");
  assert.ok(cmds.some((c) => c.cmd === "/fix-diagnostics" && c.source === "builtin"), "builtin template present");
});

test("getSlashCommands: no extension runner → just the three builtin templates", () => {
  const { svc } = makeService();
  const cmds = svc.getSlashCommands();
  assert.equal(cmds.length, 3);
  assert.ok(cmds.every((c) => c.source === "builtin"));
});

test("getAvailableModels maps the ModelRuntime catalog (provider/id/name/cost/ctx)", async () => {
  const { svc } = makeService();
  svc.modelRuntime = { getAvailable: async () => [
    { provider: "deepseek", id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", cost: { input: 0.435, output: 0.87, cacheRead: 0.0036 }, contextWindow: 1000000 },
  ] } as Any;
  const models = await svc.getAvailableModels();
  assert.deepEqual(models, [{ provider: "deepseek", id: "deepseek-v4-pro", name: "DeepSeek V4 Pro", cost: { input: 0.435, output: 0.87 }, contextWindow: 1000000 }]);
});

test("getAvailableModels: no modelRuntime → [] (and a throwing runtime → [])", async () => {
  const { svc } = makeService();
  svc.modelRuntime = null;
  assert.deepEqual(await svc.getAvailableModels(), []);
  svc.modelRuntime = { getAvailable: async () => { throw new Error("boom"); } } as Any;
  assert.deepEqual(await svc.getAvailableModels(), []);
});

test("promoteToSteer re-queues then appends the promoted text", () => {
  const { svc, calls } = makeService({ getSteeringMessages: () => ["old"] });
  svc.promoteToSteer("new");
  assert.deepEqual(calls, [["clearQueue"], ["steer", "old"], ["steer", "new"]]);
});

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
        return fakeSdk({ ModelRuntime: { create: async () => ({ setRuntimeApiKey: async () => {}, getAvailable: async () => [], getModel: () => null, getAuth: async () => undefined, refresh: async () => {} }) } });
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

test("runtime API keys from config are applied to the model runtime", async () => {
  const applied: Array<[string, string]> = [];
  const { host, deps } = makeEnv({
    config: { anthropicApiKey: "sk-ant", openaiApiKey: "sk-oai" },
    modules: (p) => {
      if (p.includes("pi-ai/dist/index.js")) { return fakeAi(); }
      if (p.includes("typebox")) { return { Type: {} }; }
      if (p.endsWith("dist/index.js")) {
        return fakeSdk({ ModelRuntime: { create: async () => ({
          setRuntimeApiKey: async (prov: string, key: string) => { applied.push([prov, key]); },
          getAvailable: async () => [{ provider: "anthropic", id: "claude-opus-4-8", name: "Claude Opus 4.8" }],
          getModel: () => null, getAuth: async () => undefined, refresh: async () => {},
        }) } });
      }
      return {};
    },
  });
  const out = await new SdkService(host, deps).initialize({ fresh: true, openPath: null });
  assert.equal(out.success, true, out.error);
  assert.deepEqual(applied, [["anthropic", "sk-ant"], ["openai", "sk-oai"]]);
});

// ── init: session-open branches + resume restore (audit H12) ─────────
// The DEFAULT runtime's most common real-world path — continueRecent after a VS Code restart —
// plus openPath resume, the EEXIST regenerate guard, the context-budget clamp and the
// default-model override, none of which had coverage.

/** An init env whose SessionManager records which open-path ran, with a capturable
 *  createAgentSession and scriptable session entries / fileExists. */
function initEnv(opts: {
  entries?: Any[];
  sessionFile?: string;
  fileExists?: (f: string) => boolean;
  continueThrows?: boolean;
  config?: Partial<SdkConfig>;
} = {}): { host: SdkHost; deps: SdkDeps; calls: string[]; agentOpts: () => Any } {
  const calls: string[] = [];
  let agentOpts: Any = null;
  const mgr = () => ({ getSessionFile: () => opts.sessionFile, getEntries: () => opts.entries ?? [] });
  const sdk = fakeSdk({
    SessionManager: {
      create: () => { calls.push("create"); return mgr(); },
      open: () => { calls.push("open"); return mgr(); },
      continueRecent: async () => {
        calls.push("continueRecent");
        if (opts.continueThrows) { throw new Error("no recent session"); }
        return mgr();
      },
    },
    createAgentSession: async (o: Any) => { agentOpts = o; return { session: { id: "session-1" } }; },
  });
  const env = makeEnv({
    config: opts.config,
    modules: (absPath: string): Any => {
      if (absPath.includes("pi-ai/dist/index.js")) { return fakeAi(); }
      if (absPath.includes("providers/all.js")) { return { getBuiltinModel: () => null, builtinModels: () => ({ getModels: () => [], complete: async () => ({}) }) }; }
      if (absPath.includes("typebox")) { return { Type: {} }; }
      if (absPath.endsWith("dist/index.js")) { return sdk; }
      throw new Error(`unexpected import: ${absPath}`);
    },
  });
  if (opts.fileExists) { (env.deps as Any).fileExists = opts.fileExists; }
  return { host: env.host, deps: env.deps, calls, agentOpts: () => agentOpts };
}

test("init (fresh=false, no openPath) CONTINUES the recent session — the VS Code restart path", async () => {
  const { host, deps, calls } = initEnv();
  const out = await new SdkService(host, deps).initialize({ fresh: false, openPath: null });
  assert.equal(out.success, true);
  assert.deepEqual(calls, ["continueRecent"]);
  assert.equal(out.isResuming, true);
});

test("continueRecent failure falls back to creating a session (no hard failure)", async () => {
  const { host, deps, calls } = initEnv({ continueThrows: true });
  const out = await new SdkService(host, deps).initialize({ fresh: false, openPath: null });
  assert.equal(out.success, true, "init still succeeds");
  assert.deepEqual(calls, ["continueRecent", "create"]);
});

test("openPath resumes through SessionManager.open (Past Sessions)", async () => {
  const { host, deps, calls } = initEnv();
  const out = await new SdkService(host, deps).initialize({ fresh: false, openPath: "/sessions/x.jsonl" });
  assert.deepEqual(calls, ["open"]);
  assert.equal(out.isResuming, true);
});

test("resume restores the LAST model_change and thinking_level_change from the session", async () => {
  const { host, deps } = initEnv({ entries: [
    { type: "model_change", provider: "anthropic", modelId: "older-model" },
    { type: "thinking_level_change", thinkingLevel: "low" },
    { type: "model_change", provider: "anthropic", modelId: "newer-model" },
    { type: "thinking_level_change", thinkingLevel: "high" },
  ]});
  const out = await new SdkService(host, deps).initialize({ fresh: false, openPath: "/sessions/x.jsonl" });
  assert.equal(out.model?.id, "newer-model", "reverse walk takes the LAST model_change");
  assert.equal(out.thinkingLevel, "high", "and the LAST thinking_level_change");
});

test("a FRESH session ignores prior entries — no restore", async () => {
  const { host, deps } = initEnv({ entries: [{ type: "model_change", provider: "anthropic", modelId: "must-not-restore" }] });
  const out = await new SdkService(host, deps).initialize({ fresh: true, openPath: null });
  assert.notEqual(out.model?.id, "must-not-restore");
  assert.equal(out.isResuming, false);
});

test("a fresh session regenerates its path while one already exists (EEXIST guard)", async () => {
  let probes = 0;
  const { host, deps, calls } = initEnv({ sessionFile: "/sessions/collide.jsonl", fileExists: () => probes++ < 2 });
  const out = await new SdkService(host, deps).initialize({ fresh: true, openPath: null });
  assert.equal(out.success, true);
  assert.equal(calls.filter((c) => c === "create").length, 3, "initial create + 2 regenerations, then the path was free");
});

test("contextBudget clamps the model's contextWindow for the session", async () => {
  const { host, deps, agentOpts } = initEnv({ config: { contextBudget: 12_345 } });
  await new SdkService(host, deps).initialize({ fresh: true, openPath: null });
  assert.equal(agentOpts()?.model?.contextWindow, 12_345);
});

test("defaultModelProvider/defaultModelId override the auto-selected model", async () => {
  const { host, deps } = initEnv({ config: { defaultModelProvider: "anthropic", defaultModelId: "my-default" } });
  const out = await new SdkService(host, deps).initialize({ fresh: true, openPath: null });
  assert.equal(out.model?.id, "my-default");
});

// ── the context budget must survive a model switch ───────────────────
// It was applied once, at init, so switching models mid-session silently dropped it: the SDK
// reads model.contextWindow for BOTH the auto-compaction trigger and the context-% denominator,
// so the user kept a budget in settings while the session quietly reverted to the model's native
// window. Rust never had the gap (applyState re-clamps on every get_state), so the same action
// behaved differently per runtime.
test("setModel re-applies the context budget, like initialize does", async () => {
  const setModels: Any[] = [];
  const { svc } = makeService();
  (svc as Any).session = { setModel: async (m: Any) => { setModels.push(m); } };
  (svc as Any).AI = { getModel: () => ({ id: "m", provider: "p", contextWindow: 1_000_000 }) };
  (svc as Any).modelRuntime = null;
  (svc as Any).deps = { ...(svc as Any).deps, config: () => ({ contextBudget: 128_000 }) };

  await svc.setModel("p", "m");
  assert.equal(setModels.length, 1);
  assert.equal(setModels[0].contextWindow, 128_000,
    "the budget must clamp the switched-to model, not just the startup one");
});

test("setModel leaves the native window alone when no budget is set", async () => {
  const setModels: Any[] = [];
  const { svc } = makeService();
  (svc as Any).session = { setModel: async (m: Any) => { setModels.push(m); } };
  (svc as Any).AI = { getModel: () => ({ id: "m", provider: "p", contextWindow: 1_000_000 }) };
  (svc as Any).modelRuntime = null;
  (svc as Any).deps = { ...(svc as Any).deps, config: () => ({ contextBudget: 0 }) };

  await svc.setModel("p", "m");
  assert.equal(setModels[0].contextWindow, 1_000_000);
});

// ── the Auto-retry toggle actually has to toggle something ────────────
// setAutoRetry was an empty method, so on TypeScript the settings toggle flipped an
// extension-local flag, told the webview it had changed, and left the session retrying exactly
// as before — a control that lied, on the DEFAULT runtime, about re-billing. The SDK exposes
// AgentSession.setAutoRetryEnabled (verified in pi-coding-agent 0.83.0); it was never wired.
test("setAutoRetry reaches the SDK session", async () => {
  const calls: Any[] = [];
  const { svc } = makeService();
  (svc as Any).session = { setAutoRetryEnabled: (v: boolean) => calls.push(v) };
  await svc.setAutoRetry(false);
  await svc.setAutoRetry(true);
  assert.deepEqual(calls, [false, true], "both directions must reach the session");
});

test("setAutoRetry degrades quietly on an SDK that lacks the method", async () => {
  const { svc } = makeService();
  (svc as Any).session = {};                       // older SDK: no setter
  await assert.doesNotReject(() => svc.setAutoRetry(false));
  (svc as Any).session = null;                     // not initialized
  await assert.doesNotReject(() => svc.setAutoRetry(false));
});

test("readSessionSettings reports the session's REAL flags, not assumed defaults", () => {
  const { svc } = makeService();
  (svc as Any).session = { autoCompactionEnabled: false, autoRetryEnabled: false };
  assert.deepEqual(svc.readSessionSettings(), { autoCompaction: false, autoRetry: false },
    "a resumed session with settings off must not display them as on");
});

test("readSessionSettings returns undefined rather than guessing when the SDK is older", () => {
  const { svc } = makeService();
  (svc as Any).session = {};
  assert.deepEqual(svc.readSessionSettings(), { autoCompaction: undefined, autoRetry: undefined });
  (svc as Any).session = null;
  assert.deepEqual(svc.readSessionSettings(), {});
});
