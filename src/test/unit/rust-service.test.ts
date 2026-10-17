// Headless integration tests for RustService.initialize() — the most complex
// sequence in the Rust subsystem (binary detection → args → spawn → 4-step RPC
// handshake → degradation tracking). RustService is vscode-free: its environment
// (config, binary detection, models.json setup, host UI) is injected via RustDeps,
// so these tests drive the REAL init path against a fake rust-pi subprocess
// speaking the RPC protocol, with stubbed deps. This was the audits' top-priority
// coverage gap (zero direct tests on initializeInner).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RustProcess, type RustProcessOpts } from "../../rust-process.js";
import { RustService, classifyStaleDefaultExit, type RustHost, type RustDeps, type RustSessionConfig } from "../../rust-service.js";
import type { PiServiceEvent } from "../../types.js";

// A fake rust-pi answering the full init handshake. Behavior switches on the
// FAKE_MODE env var so one script covers the happy path and each failure branch.
//  - "ok":         all four handshake RPCs answer with realistic shapes
//  - "no-models":  get_available_models returns an empty list  → degraded warning
//  - "bad-state":  get_state succeeds but lacks model/thinkingLevel → shape probe
const FAKE_SRC = `
const MODE = process.env.FAKE_MODE || "ok";
const argv = process.argv;
let LEVEL = argv.includes("--thinking") ? argv[argv.indexOf("--thinking") + 1] : "xhigh";
let CUR = null;
const MODELS = MODE === "unresolved-xprov"
  ? [{ id: "model-a", provider: "other-provider", name: "Model A" }]
  : MODE === "unresolved-nocred"
  ? [{ id: "deepseek-v4-flash-vision-exp", provider: "deepseek", name: "Vision Exp" }, { id: "model-a", provider: "other-provider", name: "Model A" }]
  : [{ id: "deepseek-v4-pro", provider: "deepseek", name: "DeepSeek V4 Pro" }, { id: "deepseek-v4-flash", provider: "deepseek", name: "DeepSeek V4 Flash" }];
let buf = "";
const W = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    const reply = (data) => W({ type: "response", id: o.id, command: o.type, success: true, data });
    if (o.type === "get_state") {
      // UNRESOLVED modes model rust-pi 0.8.0's real reply when --model names nothing it knows:
      // every key present, \`model: null\`, thinkingLevel still reported (black-box probe).
      if (MODE === "unresolved-statefail") {
        W({ type: "response", id: o.id, command: o.type, success: false, error: "state unavailable" });
      } else if (MODE.startsWith("unresolved")) {
        reply({ model: CUR, thinkingLevel: LEVEL, sessionFile: null, sessionId: "sess-u", autoCompactionEnabled: true, autoRetryEnabled: true });
      } else if (MODE === "no-thinking") {
        reply({ model: { id: "deepseek-v4-pro", provider: "deepseek" }, sessionId: "s" });
      } else if (MODE === "model-no-id") {
        reply({ model: {}, thinkingLevel: "off", sessionId: "s" });
      } else if (MODE === "modelid-only") {
        reply({ modelId: "deepseek-v4-pro", provider: "deepseek", thinkingLevel: "off", sessionId: "s" });
      } else {
      reply(MODE === "bad-state"
        ? { someUnknownShape: true }
        : { model: { id: "deepseek-v4-pro", provider: "deepseek", api: "openai-completions", reasoning: true, contextWindow: 131072 },
            thinkingLevel: "high", sessionFile: "/tmp/fake-session.jsonl", sessionId: "sess-42",
            autoCompactionEnabled: true, autoRetryEnabled: true });
      }
    } else if (o.type === "set_model") {
      const m = MODELS.find((x) => x.provider === o.provider && x.id === o.modelId);
      if (MODE === "unresolved-fail" || !m) { W({ type: "response", id: o.id, command: o.type, success: false, error: "Model not found: " + o.provider + "/" + o.modelId }); }
      else { CUR = m; if (MODE === "unresolved-thinkdrift") { LEVEL = "max"; } reply(m); }
    } else if (o.type === "set_thinking_level") {
      LEVEL = o.level; reply({});
    } else if (o.type === "get_available_models") {
      reply(MODE === "no-models" ? { models: [] } : { models: MODELS });
    } else if (o.type === "get_messages") {
      reply({ messages: [{ id: "m1", role: "user", content: [{ type: "text", text: "hi" }] }] });
    } else if (o.type === "get_commands") {
      reply({ commands: [{ name: "compact", description: "Compact context" }] });
    } else if (o.type === "get_session_stats") {
      reply({ tokens: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 }, cost: 0 });
    }
  }
});
setInterval(() => {}, 60000);
`;

let tmp: string;
let fakeBin: string;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "rust-service-test-"));
  fakeBin = join(tmp, "fake-rust-pi.mjs");
  writeFileSync(fakeBin, FAKE_SRC);
});
after(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

/** A recording RustHost stub: captures every state write + emitted event. */
function makeHost() {
  const state = {
    events: [] as PiServiceEvent[],
    model: null as Record<string, unknown> | null,
    thinkingLevel: "",
    sessionId: "",
    cycleModels: [] as Array<{ provider: string; id: string }>,
    autoCompaction: undefined as boolean | undefined,
    autoRetry: undefined as boolean | undefined,
    statusReports: 0,
    initialEntries: [] as unknown[],
    substituted: [] as unknown[],
  };
  const host: RustHost = {
    emit: (e) => { state.events.push(e); },
    handleAgentEvent: () => { /* not exercised at init */ },
    reportStatus: () => { state.statusReports++; },
    sendInitialMessages: async (entries) => { state.initialEntries = entries; },
    emitPostInitState: () => { /* noop */ },
    showDialog: () => undefined,
    rememberReasoning: () => { /* noop */ },
    setSessionId: (id) => { state.sessionId = id; },
    getCycleModels: () => state.cycleModels,
    setCycleModels: (l) => { state.cycleModels = l; },
    setAutoCompactionEnabled: (v) => { state.autoCompaction = v; },
    setAutoRetryEnabled: (v) => { state.autoRetry = v; },
    modelSubstituted: (info) => { state.substituted.push(info); },
  };
  return { host, state };
}

/** Stubbed deps: fake binary via node, no vscode anywhere. `mode` drives FAKE_MODE. */
function makeDeps(mode: string, overrides?: Partial<RustDeps>): RustDeps {
  const config: RustSessionConfig = {
    defaultThinkingLevel: "xhigh",
    rustExtensionPolicy: "balanced",
    contextBudget: 0,
    // Collapsed deliberately: a suite must never inherit the production 60s budget. What the
    // tests assert is the RETRY BEHAVIOUR, not the wall-clock wait.
    readyBudgetMs: 1200,
  };
  return {
    detectBinary: () => ({ installed: true, binaryPath: process.execPath }),
    shouldDisableExtensions: () => false,
    workspaceIsTrusted: () => true,
    extensionsMode: () => "auto",
    setupModels: () => ({ piEnv: {}, warnings: [] }),
    sessionDir: () => tmp,
    workspaceCwd: () => tmp,
    config: () => config,
    showError: () => { /* noop */ },
    offerReopen: () => { /* noop */ },
    exportHtml: async (_s, out) => out,
    detectMissingTools: async () => null,
    // The fake is a node script: prepend it to the args RustService built, and
    // carry FAKE_MODE through the env RustService assembled.
    createProcess: (opts: RustProcessOpts) => new RustProcess({
      ...opts,
      binaryPath: process.execPath,
      args: [fakeBin, ...opts.args],
      env: { ...opts.env, FAKE_MODE: mode },
    }),
    ...overrides,
  };
}

test("initialize (happy path): full handshake populates model, thinking, session, cycle models, history, commands", async () => {
  const { host, state } = makeHost();
  const svc = new RustService(host, makeDeps("ok"));
  const result = await svc.initialize({ fresh: true });
  try {
    assert.equal(result.success, true, JSON.stringify(result));
    // get_state applied — model is now OWNED by RustService (read via getModel()),
    // not pushed to the host.
    assert.equal(svc.getModel()?.id, "deepseek-v4-pro");
    assert.equal(svc.getThinkingLevel(), "high");     // owned by RustService; binary's state wins over the default
    assert.equal(state.sessionId, "sess-42");
    assert.equal(state.autoCompaction, true);
    assert.equal(state.autoRetry, true);
    assert.equal(svc.getSessionPath(), "/tmp/fake-session.jsonl");
    // get_available_models applied
    assert.deepEqual(state.cycleModels.map((m) => m.id), ["deepseek-v4-pro", "deepseek-v4-flash"]);
    // get_messages replayed through the host (batch framing is the host's job)
    assert.equal(state.initialEntries.length, 1);
    // get_commands parsed
    assert.equal(svc.getSlashCommands().some((c) => c.cmd === "/compact"), true);
    // no degradation warnings on the happy path
    const warnings = state.events.filter((e) => e.type === "custom-message");
    assert.deepEqual(warnings, []);
  } finally { svc.dispose(); }
});

test("initialize (no models): init still succeeds but the models capability degrades with ONE warning", async () => {
  const { host, state } = makeHost();
  const svc = new RustService(host, makeDeps("no-models"));
  const result = await svc.initialize({ fresh: true });
  try {
    assert.equal(result.success, true);
    assert.deepEqual(state.cycleModels, []);
    const warnings = state.events.filter((e) =>
      e.type === "custom-message" && String((e.data as { content?: unknown })?.content ?? "").includes("model list"));
    assert.equal(warnings.length, 1, "exactly one degraded-models warning");
  } finally { svc.dispose(); }
});

test("initialize (shape drift): a get_state reply without model/thinkingLevel triggers the drift warning", async () => {
  const { host, state } = makeHost();
  const svc = new RustService(host, makeDeps("bad-state"));
  const result = await svc.initialize({ fresh: true });
  try {
    assert.equal(result.success, true);
    const drift = state.events.filter((e) =>
      e.type === "custom-message" && String((e.data as { content?: unknown })?.content ?? "").includes("RPC shape may have drifted"));
    assert.equal(drift.length, 1, "exactly one shape-drift warning");
  } finally { svc.dispose(); }
});

test("initialize: binary not installed fails fast with the detector's error", async () => {
  const { host } = makeHost();
  const svc = new RustService(host, makeDeps("ok", {
    detectBinary: () => ({ installed: false, error: "Rust Pi binary not found (test)" }),
  }));
  const result = await svc.initialize({ fresh: true });
  assert.equal(result.success, false);
  assert.match(result.error ?? "", /not found \(test\)/);
});

test("initialize: fatal models.json setup failure surfaces in chat + showError but init continues", async () => {
  const { host, state } = makeHost();
  let shown = "";
  const svc = new RustService(host, makeDeps("ok", {
    setupModels: () => { throw new Error("disk full (test)"); },
    showError: (m) => { shown = m; },
  }));
  const result = await svc.initialize({ fresh: true });
  try {
    assert.equal(result.success, true, "built-in models still work — init must continue");
    assert.match(shown, /disk full \(test\)/);
    const chat = state.events.filter((e) =>
      e.type === "custom-message" && String((e.data as { content?: unknown })?.content ?? "").includes("disk full"));
    assert.equal(chat.length, 1);
  } finally { svc.dispose(); }
});

test("initialize (fresh): passes --thinking with the configured default, INCLUDING for 'off'", async () => {
  // rust-pi defaults a reasoning model to 'high' when --thinking is absent, so the
  // flag must be explicit even for off (verified live against 0.1.20).
  for (const level of ["off", "xhigh"]) {
    const { host } = makeHost();
    let seenArgs: string[] = [];
    const svc = new RustService(host, makeDeps("ok", {
      config: () => ({ defaultThinkingLevel: level, rustExtensionPolicy: "balanced", contextBudget: 0 }),
      createProcess: (opts: RustProcessOpts) => {
        seenArgs = opts.args;
        return new RustProcess({ ...opts, binaryPath: process.execPath, args: [fakeBin, ...opts.args], env: { ...opts.env, FAKE_MODE: "ok" } });
      },
    }));
    const result = await svc.initialize({ fresh: true });
    try {
      assert.equal(result.success, true);
      const i = seenArgs.indexOf("--thinking");
      assert.notEqual(i, -1, `--thinking present for ${level}`);
      assert.equal(seenArgs[i + 1], level);
    } finally { svc.dispose(); }
  }
});

// ── Workspace trust (rust-pi 0.3.0) ──────────────────────────────────
// 0.3.0 gates project-local `.pi/settings.json` packages and `.pi/extensions/` behind
// workspace trust and fails CLOSED for non-interactive launches. Measured against the real
// binary, "fails closed" means the process still starts and RPC still answers — the config is
// silently skipped — so no crash test would ever have caught this. The flag is the only signal.
test("initialize: passes --trust exactly when VS Code trusts the workspace", async () => {
  for (const trusted of [true, false]) {
    const { host } = makeHost();
    let seenArgs: string[] = [];
    const svc = new RustService(host, makeDeps("ok", {
      workspaceIsTrusted: () => trusted,
      createProcess: (opts: RustProcessOpts) => {
        seenArgs = opts.args;
        return new RustProcess({ ...opts, binaryPath: process.execPath, args: [fakeBin, ...opts.args], env: { ...opts.env, FAKE_MODE: "ok" } });
      },
    }));
    const result = await svc.initialize({ fresh: true });
    try {
      assert.equal(result.success, true);
      assert.equal(seenArgs.includes("--trust"), trusted,
        trusted ? "--trust present in a trusted workspace" : "--trust withheld in an untrusted workspace (fail closed)");
    } finally { svc.dispose(); }
  }
});

// ── Spawn-failure teardown (audit: orphaned child) ───────────────────
// RustProcess.spawn() rejects when the readiness probe (get_state) times out — and in that
// case the child is still ALIVE. Nulling this.process without disposing orphaned it: PiService
// also nulls _rust on a failed init, so the Retry path's dispose() had nothing left to kill,
// and the orphan lingered holding its fds, --session-dir and SQLite index.
test("a spawn failure disposes the subprocess instead of orphaning it", async () => {
  const { host } = makeHost();
  let disposed = 0;
  const svc = new RustService(host, makeDeps("ok", {
    // A process that is constructed (so this.process is set) but fails to become ready.
    createProcess: (_opts: RustProcessOpts) => ({
      spawn: async () => { throw new Error("Rust process did not become ready in time"); },
      dispose: () => { disposed++; },
      isAlive: () => true,
      request: async () => ({ type: "response", success: false }),
      send: () => {},
    } as unknown as RustProcess),
  }));

  const result = await svc.initialize({ fresh: true });
  assert.equal(result.success, false, "init reports failure");
  assert.equal(disposed, 1, "the still-alive child was disposed, not orphaned");
});

test("a spawn failure on the --no-extensions retry also disposes (both failure paths)", async () => {
  const { host } = makeHost();
  let disposed = 0;
  let attempts = 0;
  const svc = new RustService(host, makeDeps("ok", {
    extensionsMode: () => "auto",
    createProcess: (_opts: RustProcessOpts) => ({
      // First attempt fails with the extension-conflict signature → RustService retries with
      // --no-extensions; the retry fails too. BOTH paths must dispose.
      // The real conflict signature (isRustExtensionConflict: "missing field" + "parameters").
      spawn: async () => { attempts++; throw new Error("invalid extension manifest: missing field `parameters` at line 3"); },
      dispose: () => { disposed++; },
      isAlive: () => true,
      request: async () => ({ type: "response", success: false }),
      send: () => {},
    } as unknown as RustProcess),
  }));

  const result = await svc.initialize({ fresh: true });
  assert.equal(result.success, false);
  assert.equal(attempts, 2, "retried once with --no-extensions");
  assert.equal(disposed, 2, "both the original and the retry child were disposed");
});

// ── handshake-timeout recovery ───────────────────────────────────────
// A project-local package can HANG init rather than fail the spawn: the process starts, reports
// its load failure on stderr, then never answers get_state. Observed live with a package
// importing `node:dns/promises` — the user saw "RPC 'get_state' timed out after 15000ms" with
// nothing naming the package. The spawn-time retry cannot help: spawn() never threw.
function makeHangingProcess(opts: RustProcessOpts, state: { attempts: number; disposed: number }) {
  state.attempts++;
  const first = state.attempts === 1;
  return {
    // Report the load failure the way RustProcess does — during startup, before the handshake —
    // then never answer get_state.
    spawn: async () => {
      if (first) {
        opts.onLoadError?.({
          kind: "unsupported-module", packageName: "pi-web-access",
          detail: "Imports node:dns/promises, which the Rust runtime's module loader doesn't support.",
        });
      }
    },
    dispose: () => { state.disposed++; },
    isAlive: () => true,
    request: async (command: string) => {
      if (command === "get_state" && first) { throw new Error("RPC 'get_state' timed out after 15000ms"); }
      return { type: "response", success: true, data: {} };
    },
    send: () => {},
  } as unknown as RustProcess;
}

test("a handshake timeout after a package load failure retries without project extensions", async () => {
  const { host, state: hostState } = makeHost();
  const state = { attempts: 0, disposed: 0 };
  const svc = new RustService(host, makeDeps("ok", {
    extensionsMode: () => "auto",
    createProcess: (opts: RustProcessOpts) => makeHangingProcess(opts, state),
  }));

  const result = await svc.initialize({ fresh: true });
  assert.equal(result.success, true, "recovered instead of failing the session");
  assert.ok(state.attempts >= 2, "respawned with --no-extensions after the readiness budget was spent");
  const messages = hostState.events.map((e) => String(((e as { data?: { content?: string } }).data)?.content ?? ""));
  // The recovery notice is the one that explains the cost — distinct from the plain load-error
  // line RustProcess already emits, which names the package but not what the extension DID.
  const notice = messages.find((c) => c.includes("rustExtensions"));
  assert.ok(notice, "the user is told a retry happened and how to skip it next time");
  assert.ok(notice.includes("pi-web-access"), "names the package responsible");
  assert.ok(/\.pi\/settings\.json/.test(notice), "points at the file declaring the package");
  assert.ok(/15 seconds/.test(notice), "names the start-up cost it just paid");
  svc.dispose();
});

test("a non-timeout start failure with NO load failure is reported, not retried", async () => {
  // Nothing to blame on extensions and no hang to escape: respawning would just fail the same
  // way. Only a timeout or a classified load error earns a retry.
  const { host } = makeHost();
  let attempts = 0;
  const svc = new RustService(host, makeDeps("ok", {
    extensionsMode: () => "auto",
    createProcess: (_opts: RustProcessOpts) => ({
      spawn: async () => { attempts++; },
      dispose: () => {},
      isAlive: () => true,
      request: async () => { throw new Error("binary exited with code 1"); },
      send: () => {},
    } as unknown as RustProcess),
  }));

  const result = await svc.initialize({ fresh: true });
  assert.equal(result.success, false);
  assert.equal(attempts, 1, "no pointless respawn");
  svc.dispose();
});

test("a readiness-probe timeout after a package load failure retries without project extensions", async () => {
  // The REAL door. spawn() runs the readiness probe (readyCommand: get_state), so a package that
  // wedges the binary rejects spawn() with "RPC 'get_state' timed out after 15000ms" — the exact
  // string users saw as "Failed to start Rust Pi: ...". It matches no conflict signature, so
  // before this the session just died. _loadErrors is what names the culprit.
  const { host, state: hostState } = makeHost();
  let attempts = 0;
  const svc = new RustService(host, makeDeps("ok", {
    extensionsMode: () => "auto",
    createProcess: (opts: RustProcessOpts) => {
      attempts++;
      // Fails PERSISTENTLY until extensions are switched off. A single timeout is now absorbed
      // by the readiness budget — which is the point of that budget: a transient slow start
      // must not disable the user's extensions.
      const withoutExtensions = (opts.args ?? []).includes("--no-extensions");
      return {
        spawn: async () => {
          if (!withoutExtensions) {
            opts.onLoadError?.({
              kind: "unsupported-module", packageName: "pi-web-access",
              detail: "Imports node:dns/promises, which the Rust runtime's module loader doesn't support.",
            });
            throw new Error("RPC 'get_state' timed out after 15000ms");
          }
        },
        dispose: () => {},
        isAlive: () => true,
        request: async () => ({ type: "response", success: true, data: {} }),
        send: () => {},
      } as unknown as RustProcess;
    },
  }));

  const result = await svc.initialize({ fresh: true });
  assert.equal(result.success, true, "recovered instead of failing the session");
  // Not an exact count: the readiness budget legitimately retries the timeout several
  // times before the extensions fallback is reached. What matters is that it GOT there.
  assert.ok(attempts >= 2, "respawned with --no-extensions after the readiness budget was spent");
  const notice = hostState.events
    .map((e) => String(((e as { data?: { content?: string } }).data)?.content ?? ""))
    .find((c) => c.includes("pi-web-access") && c.includes("rustExtensions"));
  assert.ok(notice, "names the package AND the setting that avoids the retry next time");
  svc.dispose();
});

test("a cold-cache startup timeout retries blind, with no load error to name", async () => {
  // The case that broke the first fix: on a cold package cache the binary prints NOTHING within
  // the 15s probe, so there is no classified load error to trigger on. The timeout alone has to
  // be enough, and the notice must not name a culprit it has not identified.
  const { host, state: hostState } = makeHost();
  let attempts = 0;
  const svc = new RustService(host, makeDeps("ok", {
    extensionsMode: () => "auto",
    createProcess: (_opts: RustProcessOpts) => {
      attempts++;
      return {
        // Persistent until extensions are off — see the note above.
        spawn: async () => { if (!(_opts.args ?? []).includes("--no-extensions")) { throw new Error("RPC 'get_state' timed out after 15000ms"); } },
        dispose: () => {},
        isAlive: () => true,
        request: async () => ({ type: "response", success: true, data: {} }),
        send: () => {},
      } as unknown as RustProcess;
    },
  }));

  const result = await svc.initialize({ fresh: true });
  assert.equal(result.success, true, "recovered rather than failing the session");
  assert.ok(attempts >= 2, "retried with --no-extensions once the readiness budget was spent");
  const notice = hostState.events
    .map((e) => String(((e as { data?: { content?: string } }).data)?.content ?? ""))
    .find((c) => c.includes("rustExtensions"));
  assert.ok(notice, "tells the user what happened and how to avoid the cost");
  assert.ok(!/pi-web-access|failed to load/.test(notice), "does not invent a culprit it never identified");
  svc.dispose();
});

test("a slow start is retried within the budget, not failed on the first timeout", async () => {
  // Healthy spawns have been observed taking 39s and 90s while a 15s probe called them dead.
  const { host } = makeHost();
  let attempts = 0;
  const svc = new RustService(host, makeDeps("ok", {
    createProcess: (_opts: RustProcessOpts) => ({
      // Times out twice, then comes up — the shape of a slow start, not a broken one.
      spawn: async () => { attempts++; if (attempts <= 2) { throw new Error("RPC 'get_state' timed out after 15000ms"); } },
      dispose: () => {}, isAlive: () => true,
      request: async () => ({ type: "response", success: true, data: {} }),
      send: () => {},
    } as unknown as RustProcess),
  }));
  const result = await svc.initialize({ fresh: true });
  assert.equal(result.success, true, "recovered instead of failing the session");
  assert.equal(attempts, 3, "retried twice, then succeeded");
  svc.dispose();
});

test("a never-ready process fails WITHIN its budget rather than hanging", async () => {
  // The guard on the mistake that reverted the first attempt: if this regresses it fails fast
  // instead of stalling the whole suite.
  const { host } = makeHost();
  let attempts = 0;
  const svc = new RustService(host, makeDeps("ok", {
    createProcess: (_opts: RustProcessOpts) => ({
      spawn: async () => { attempts++; throw new Error("RPC 'get_state' timed out after 15000ms"); },
      dispose: () => {}, isAlive: () => true,
      request: async () => ({ type: "response", success: false }),
      send: () => {},
    } as unknown as RustProcess),
  }));
  const t0 = Date.now();
  const result = await svc.initialize({ fresh: true });
  const took = Date.now() - t0;
  assert.equal(result.success, false);
  assert.ok(took < 8000, `gave up in ${took}ms — bounded by the injected budget, not hanging`);
  assert.ok(attempts > 1, "it did retry before giving up");
  svc.dispose();
});

test("an error reply is NOT retried — only a timeout is", async () => {
  // Retrying a binary that answered is a busy loop, not patience.
  const { host } = makeHost();
  let attempts = 0;
  const svc = new RustService(host, makeDeps("ok", {
    createProcess: (_opts: RustProcessOpts) => ({
      spawn: async () => { attempts++; throw new Error("Rust process exited immediately (code 1)"); },
      dispose: () => {}, isAlive: () => false,
      request: async () => ({ type: "response", success: false }),
      send: () => {},
    } as unknown as RustProcess),
  }));
  const result = await svc.initialize({ fresh: true });
  assert.equal(result.success, false);
  assert.equal(attempts, 1, "failed immediately; a dead process is not a slow one");
  svc.dispose();
});

test("the model list stays credential-scoped after the cache ages out", async () => {
  // Two fetch paths: init, and the TTL refresh the picker triggers. Scoping only the first made
  // the bug time-dependent — the first picker of a session was scoped, every later one showed
  // all ~94 built-ins, so it read as "changing the default broke the picker".
  const { host } = makeHost();
  const wide = { models: [
    { provider: "deepseek", id: "deepseek-v4-flash" },
    { provider: "anthropic", id: "claude-sonnet-3-5" },
    { provider: "amazon-bedrock", id: "llama-4-scout" },
  ] };
  const svc = new RustService(host, makeDeps("ok", {
    // Stated, not inherited from whatever the machine happens to hold. This test passed locally
    // and failed in CI purely because the dev box had DEEPSEEK_API_KEY set.
    hasCredential: (prov: string) => prov === "deepseek",
    createProcess: (_opts: RustProcessOpts) => ({
      spawn: async () => {}, dispose: () => {}, isAlive: () => true,
      request: async (cmd: string) => cmd === "get_available_models"
        ? { type: "response", success: true, data: wide }
        : { type: "response", success: true, data: {} },
      send: () => {},
    } as unknown as RustProcess),
  }));
  await svc.initialize({ fresh: true });

  // Force the refresh path the picker uses.
  (svc as unknown as { _modelsFetchedAt: number })._modelsFetchedAt = 0;
  const after = await svc.getAvailableModels();
  const providers = [...new Set(after.map((m) => m.provider))];
  assert.deepEqual(providers, ["deepseek"], `refresh stayed scoped, got ${providers.join(",")}`);
  svc.dispose();
});


// ── Unit 5: a stale DEFAULT model on a new session; the false drift warning ─────────────
// Founder-reported on rust-pi 0.8.0: a configured default the catalog no longer carries left a
// NEW session inert ("could not be resolved") — the substitute-a-model recovery only ran for a
// resumed session — and a "RPC shape may have drifted" card blamed the binary's version.

const STALE = { defaultModelProvider: "deepseek", defaultModelId: "deepseek-v4-flash-vision-exp" };
const cards = (events: PiServiceEvent[]) => events
  .filter((e) => e.type === "custom-message")
  .map((e) => ({ type: String((e.data as { customType?: unknown }).customType), content: String((e.data as { content?: unknown }).content ?? "") }));
const DRIFT = "RPC shape may have drifted";

function staleDeps(mode: string, extra?: Partial<RustDeps>): RustDeps {
  const base = makeDeps(mode, { hasCredential: () => true, ...extra });
  const cfg = { ...base.config(), ...STALE };
  return { ...base, config: () => cfg };
}

test("unit5 drift: get_state with model:null (no model resolved) does NOT raise the drift warning", async () => {
  const { host, state } = makeHost();
  const svc = new RustService(host, staleDeps("unresolved-fail"));
  try {
    await svc.initialize({ fresh: true });
    assert.equal(cards(state.events).filter((c) => c.content.includes(DRIFT)).length, 0, JSON.stringify(cards(state.events)));
  } finally { svc.dispose(); }
});

test("unit5 drift: a modelId-only reply (applyState's fallback) is not drift", async () => {
  const { host, state } = makeHost();
  const svc = new RustService(host, makeDeps("modelid-only"));
  try {
    await svc.initialize({ fresh: true });
    assert.equal(cards(state.events).filter((c) => c.content.includes(DRIFT)).length, 0);
  } finally { svc.dispose(); }
});

test("unit5 drift: still fires — naming only thinkingLevel — when a model is active but thinkingLevel is missing", async () => {
  const { host, state } = makeHost();
  const svc = new RustService(host, makeDeps("no-thinking"));
  try {
    await svc.initialize({ fresh: true });
    const d = cards(state.events).filter((c) => c.content.includes(DRIFT));
    assert.equal(d.length, 1);
    assert.match(d[0].content, /missing expected fields \(thinkingLevel\)/);
  } finally { svc.dispose(); }
});

test("unit5 drift: still fires when model is an object without an id", async () => {
  const { host, state } = makeHost();
  const svc = new RustService(host, makeDeps("model-no-id"));
  try {
    await svc.initialize({ fresh: true });
    const d = cards(state.events).filter((c) => c.content.includes(DRIFT));
    assert.equal(d.length, 1);
    assert.match(d[0].content, /missing expected fields \(model\)/);
  } finally { svc.dispose(); }
});

test("unit5 new session: a stale default recovers onto a same-provider substitute and SAYS so", async () => {
  const { host, state } = makeHost();
  const svc = new RustService(host, staleDeps("unresolved"));
  try {
    const r = await svc.initialize({ fresh: true });
    assert.equal(r.success, true);
    assert.equal(svc.getModel()?.id, "deepseek-v4-pro", "same provider first");
    const c = cards(state.events);
    assert.equal(c.filter((x) => x.type === "error").length, 0, JSON.stringify(c));
    const notice = c.find((x) => x.type === "warning");
    assert.ok(notice, "a visible notice");
    assert.match(notice.content, /default model `deepseek\/deepseek-v4-flash-vision-exp`/);
    assert.match(notice.content, /no longer in the model catalog/);
    assert.match(notice.content, /`deepseek\/deepseek-v4-pro`/);
    assert.deepEqual(state.substituted, [{
      stale: { provider: "deepseek", id: "deepseek-v4-flash-vision-exp" },
      substitute: { provider: "deepseek", id: "deepseek-v4-pro", name: "DeepSeek V4 Pro" },
      offerDefault: true,
    }]);
    assert.ok(state.statusReports >= 2, "status re-reported after the substitution");
  } finally { svc.dispose(); }
});

test("unit5 new session: a cross-provider substitute names both providers", async () => {
  const { host, state } = makeHost();
  const svc = new RustService(host, staleDeps("unresolved-xprov"));
  try {
    await svc.initialize({ fresh: true });
    assert.equal(svc.getModel()?.id, "model-a");
    const notice = cards(state.events).find((x) => x.type === "warning");
    assert.ok(notice);
    assert.match(notice.content, /from provider `other-provider` instead of `deepseek`/);
    // S1 (Unit 5 review): the template appended the cross-provider clause AND a literal " instead".
    assert.doesNotMatch(notice.content, /instead[^—]*instead/);
  } finally { svc.dispose(); }
});

test("unit5 new session: a default still in the catalog but without a credential is not called withdrawn", async () => {
  const { host, state } = makeHost();
  const svc = new RustService(host, staleDeps("unresolved-nocred", { hasCredential: (p: string) => p !== "deepseek" }));
  try {
    await svc.initialize({ fresh: true });
    const notice = cards(state.events).find((x) => x.type === "warning");
    assert.ok(notice);
    assert.doesNotMatch(notice.content, /no longer in the model catalog/);
    assert.match(notice.content, /no credential/);
  } finally { svc.dispose(); }
});

test("unit5 new session: the configured thinking level is re-applied if the substitution moved it", async () => {
  const { host } = makeHost();
  const svc = new RustService(host, staleDeps("unresolved-thinkdrift"));
  try {
    await svc.initialize({ fresh: true });
    assert.equal(svc.getModel()?.id, "deepseek-v4-pro");
    assert.equal(svc.getThinkingLevel(), "xhigh", "the configured default, not the binary's pick");
  } finally { svc.dispose(); }
});

test("unit5 failed substitution: the reason is logged AND carried in the ONE error card; no offer", async () => {
  const { host, state } = makeHost();
  const svc = new RustService(host, staleDeps("unresolved-fail"));
  try {
    await svc.initialize({ fresh: true });
    const errs = cards(state.events).filter((x) => x.type === "error");
    assert.equal(errs.length, 1, JSON.stringify(errs));
    assert.match(errs[0].content, /Model not found: deepseek\/deepseek-v4-pro/);
    assert.deepEqual(state.substituted, [], "never offer a default after a failed substitution");
  } finally { svc.dispose(); }
});

test("unit5 resumed session: recovery unchanged, but the notice no longer names the configured default as the recorded model; no default offer", async () => {
  const { host, state } = makeHost();
  const svc = new RustService(host, staleDeps("unresolved"));
  try {
    await svc.initialize({ openPath: join(tmp, "resumed.jsonl") });
    assert.equal(svc.getModel()?.id, "deepseek-v4-pro");
    const notice = cards(state.events).find((x) => x.type === "warning");
    assert.ok(notice);
    assert.match(notice.content, /This session's recorded model is no longer available/);
    assert.doesNotMatch(notice.content, /deepseek-v4-flash-vision-exp/);
    assert.equal((state.substituted as Array<{ offerDefault: boolean }>)[0]?.offerDefault, false);
  } finally { svc.dispose(); }
});


test("unit5 new session: no configured default -> nothing went stale: no substitution, the existing error", async () => {
  const { host, state } = makeHost();
  const base = makeDeps("unresolved", { hasCredential: () => true });
  const cfg = { ...base.config(), defaultModelProvider: "", defaultModelId: "" };
  const svc = new RustService(host, { ...base, config: () => cfg });
  try {
    await svc.initialize({ fresh: true });
    const c = cards(state.events);
    assert.equal(c.filter((x) => x.type === "warning").length, 0);
    const errs = c.filter((x) => x.type === "error");
    assert.equal(errs.length, 1);
    assert.match(errs[0].content, /your configured model could not be resolved/);
    assert.deepEqual(state.substituted, []);
  } finally { svc.dispose(); }
});

test("unit5 new session: a configured default that IS listed (get_state failed) is re-selected — never called stale, never offered", async () => {
  const { host, state } = makeHost();
  const base = makeDeps("unresolved-statefail", { hasCredential: () => true });
  const cfg = { ...base.config(), defaultModelProvider: "deepseek", defaultModelId: "deepseek-v4-flash" };
  const svc = new RustService(host, { ...base, config: () => cfg });
  try {
    await svc.initialize({ fresh: true });
    assert.equal(svc.getModel()?.id, "deepseek-v4-flash", "the user's own default, not a substitute");
    const c = cards(state.events).filter((x) => /default model|could not be resolved/.test(x.content));
    assert.deepEqual(c, [], JSON.stringify(c));
    assert.ok((state.substituted as Array<{ offerDefault: boolean }>).every((x) => x.offerDefault === false), "never offer to overwrite a working default");
  } finally { svc.dispose(); }
});

test("unit5 new session: a provider-less default still in the catalog is not called withdrawn", async () => {
  const { host, state } = makeHost();
  const base = makeDeps("unresolved-nocred", { hasCredential: (p: string) => p !== "deepseek" });
  const cfg = { ...base.config(), defaultModelProvider: "", defaultModelId: "deepseek-v4-flash-vision-exp" };
  const svc = new RustService(host, { ...base, config: () => cfg });
  try {
    await svc.initialize({ fresh: true });
    const notice = cards(state.events).find((x) => x.type === "warning");
    assert.ok(notice);
    assert.doesNotMatch(notice.content, /no longer in the model catalog/);
  } finally { svc.dispose(); }
});


// ── Unit 5b: a stale default the binary REJECTS AT SPAWN (review N8/R3, C25) ─────────────
// Probed black-box on rust-pi 0.8.0 (scratch agent home, no prompt sent): some stale defaults
// never reach get_state's `model: null` — the binary exits rc 1 at startup with
// "No API key found for provider P. …" or "Model P/I not found". And a start with NO
// --provider/--model comes up on the binary's OWN built-in default (another provider, possibly
// without a key), so the retry must always be followed by the announced substitution.

const exitMsg = (stderr: string) => `Rust process exited immediately (code 1) — last stderr: ${stderr}`;
const NOKEY = (p: string) => `No API key found for provider ${p}. Set env var or use --api-key.`;
const R3_MODELS = [
  { id: "deepseek-v4-pro", provider: "deepseek", name: "DeepSeek V4 Pro" },
  { id: "deepseek-v4-flash", provider: "deepseek", name: "DeepSeek V4 Flash" },
  { id: "model-a", provider: "other-provider", name: "Model A" },
  { id: "bin-default", provider: "binprov", name: "Binary Default" },
];

interface R3Step { spawnError?: string; loadError?: boolean; hangState?: boolean; setModelFails?: boolean; omitProvider?: string; addModels?: Array<{ id: string; provider: string; name: string }> }

/** Fake processes whose behaviour per spawn comes from `plan(args, n)`; records every argv. */
function r3Deps(def: { provider: string; id: string; cfg?: Partial<RustSessionConfig> }, plan: (args: string[], n: number) => R3Step | undefined, extra?: Partial<RustDeps>) {
  const spawns: string[][] = [];
  const rec = { disposed: 0, setModelCalls: 0 };
  const base = makeDeps("ok", {
    hasCredential: () => true,
    createProcess: (opts: RustProcessOpts) => {
      const args = [...(opts.args ?? [])];
      spawns.push(args);
      const step = plan(args, spawns.length) ?? {};
      const flag = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
      const level = flag("--thinking") ?? "max";
      const known = [...R3_MODELS, ...(step.addModels ?? [])];
      let cur: Record<string, unknown> | null = flag("--model")
        ? (R3_MODELS.find((m) => m.id === flag("--model") && (!flag("--provider") || m.provider === flag("--provider"))) ?? null)
        : flag("--provider") ? null : R3_MODELS[3]; // no flags: the binary's own default (probe H/I)
      return {
        spawn: async () => {
          if (step.loadError) { opts.onLoadError?.({ kind: "unsupported-module", packageName: "pkg-x", detail: "Imports node:dns/promises." }); }
          if (step.spawnError) { throw new Error(step.spawnError); }
        },
        dispose: () => { rec.disposed++; },
        isAlive: () => true,
        send: () => {},
        request: async (command: string, params: Record<string, unknown>) => {
          const ok = (data: unknown) => ({ type: "response", success: true, data });
          if (command === "get_state") {
            if (step.hangState) { throw new Error("RPC 'get_state' timed out after 15000ms"); }
            return ok({ model: cur, thinkingLevel: level, sessionFile: null, sessionId: "s-r3", autoCompactionEnabled: true, autoRetryEnabled: true });
          }
          if (command === "set_model") {
            rec.setModelCalls++;
            const m = known.find((x) => x.provider === params.provider && x.id === params.modelId);
            if (!m || step.setModelFails) { return { type: "response", success: false, error: `Model not found: ${String(params.provider)}/${String(params.modelId)}` }; }
            cur = m; return ok(m);
          }
          if (command === "get_available_models") { return ok({ models: known.filter((m) => m.provider !== step.omitProvider) }); }
          if (command === "get_messages") { return ok({ messages: [] }); }
          if (command === "get_commands") { return ok({ commands: [] }); }
          if (command === "get_session_stats") { return ok({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 }); }
          return ok({});
        },
      } as unknown as RustProcess;
    },
    ...extra,
  });
  const cfg = { ...base.config(), defaultModelProvider: def.provider, defaultModelId: def.id, ...def.cfg };
  return { deps: { ...base, config: () => cfg } as RustDeps, spawns, rec };
}
const hasFlags = (a: string[]) => a.includes("--provider") || a.includes("--model");
const identityOf = (a: string[]) => a[a.indexOf("--append-system-prompt") + 1] ?? "";

test("unit5b classifier: exactly the two stale-default startup exits, matched by equality", () => {
  const c = classifyStaleDefaultExit;
  assert.equal(c(exitMsg(NOKEY("deepseek")), "deepseek", "deepseek-v4-pro"), "missing-key");
  assert.equal(c(exitMsg(NOKEY("deepseek")), undefined, "deepseek-flash"), "missing-key", "provider-less: the binary derived it from --model");
  assert.equal(c(exitMsg("Model sap-ai-core/gone-model not found"), "sap-ai-core", "gone-model"), "model-not-found");
  assert.equal(c(exitMsg("Model gone-model not found"), undefined, "gone-model"), "model-not-found");
  assert.equal(c(exitMsg("Model p.x/org/m.1 not found"), "p.x", "org/m.1"), "model-not-found", "ids with / and . compare by equality");
  // The failAllPending form, with the hint doubled by the readiness rejection.
  const doubled = `Rust process exited (code 1) — last stderr: ${NOKEY("deepseek")} — last stderr: ${NOKEY("deepseek")}`;
  assert.equal(c(doubled, "deepseek", "deepseek-v4-pro"), "missing-key");
  // Never: another provider, another model, a usage error (rc 2), an OAuth exit, a timeout whose
  // "Command:" argv carries the stale flags and stale-looking text, or no configured model id.
  assert.equal(c(exitMsg(NOKEY("anthropic")), "deepseek", "deepseek-v4-pro"), null);
  assert.equal(c(exitMsg("Model deepseek/other not found"), "deepseek", "deepseek-v4-pro"), null);
  assert.equal(c(exitMsg("Model x.gone-model not found"), "x", "gone-model"), null, "no regex built from the id");
  assert.equal(c(`Rust process exited immediately (code 2) — last stderr: ${NOKEY("deepseek")}`, "deepseek", "deepseek-v4-pro"), null);
  assert.equal(c(exitMsg("OAuth token expired or invalid"), "deepseek", "deepseek-v4-pro"), null);
  assert.equal(c(`RPC 'get_state' timed out after 15000ms — the binary produced no output. Command: pi --provider deepseek --model deepseek-v4-pro --append-system-prompt Rust process exited (code 1)\n${NOKEY("deepseek")}`, "deepseek", "deepseek-v4-pro"), null);
  assert.equal(c(exitMsg(NOKEY("deepseek")), "deepseek", ""), null, "a provider-only default is not retried");
  assert.equal(c(exitMsg(NOKEY("deepseek")), "deepseek", undefined), null);
});

test("unit5b missing key at spawn: ONE retry without --provider/--model, then an announced substitute from another provider; no offer to overwrite an in-catalog default", async () => {
  const { host, state } = makeHost();
  const { deps, spawns } = r3Deps({ provider: "deepseek", id: "deepseek-v4-pro" },
    (a) => (hasFlags(a) ? { spawnError: exitMsg(NOKEY("deepseek")) } : undefined),
    { hasCredential: (p: string) => p !== "deepseek" });
  const svc = new RustService(host, deps);
  try {
    const r = await svc.initialize({ fresh: true });
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(spawns.length, 2);
    assert.equal(hasFlags(spawns[1]), false, "the retry drops --provider/--model");
    assert.equal(spawns[1][spawns[1].indexOf("--thinking") + 1], "xhigh", "the retry keeps the configured thinking level");
    assert.doesNotMatch(identityOf(spawns[1]), /- Model/, "nothing is requested at launch on the retry");
    assert.equal(svc.getModel()?.id, "model-a", "never the provider the binary said has no key, never the binary's own pick");
    const notice = cards(state.events).find((x) => x.type === "warning");
    assert.ok(notice, JSON.stringify(cards(state.events)));
    assert.match(notice.content, /`deepseek\/deepseek-v4-pro`/);
    assert.match(notice.content, /found no API key for its provider `deepseek`/);
    // Unit 5c S3: the card is the only channel (no offer), so it must say what fixes it for good.
    assert.match(notice.content, /add an API key for `deepseek`/);
    assert.match(notice.content, /change `pi-code-gui\.defaultModelProvider` and `pi-code-gui\.defaultModelId`/,
      "the binary checks --provider first, so changing only the id repeats the missing-key exit");
    assert.doesNotMatch(notice.content, /no longer in the model catalog/,
      "0.8.0 lists no model of a key-based provider that has no key, so the catalog can't call it withdrawn");
    assert.equal(cards(state.events).filter((x) => x.type === "error").length, 0, JSON.stringify(cards(state.events)));
    assert.equal((state.substituted as Array<{ offerDefault: boolean }>)[0]?.offerDefault, false,
      "only the key is missing HERE — do not offer to overwrite the default");
  } finally { svc.dispose(); }
});

test("unit5b missing key, with the model list omitting the key-based provider that has no key, as 0.8.0 does: key wording, never 'withdrawn', no offer", async () => {
  // Probed: without a key, 0.8.0's get_available_models lists none of that provider's models,
  // so catalog membership cannot tell "withdrawn" from "no key here".
  const { host, state } = makeHost();
  const { deps } = r3Deps({ provider: "deepseek", id: "deepseek-v4-pro" },
    (a) => (hasFlags(a) ? { spawnError: exitMsg(NOKEY("deepseek")) } : { omitProvider: "deepseek" }),
    { hasCredential: (p: string) => p !== "deepseek" });
  const svc = new RustService(host, deps);
  try {
    assert.equal((await svc.initialize({ fresh: true })).success, true);
    const notice = cards(state.events).find((x) => x.type === "warning");
    assert.ok(notice);
    assert.match(notice.content, /found no API key for its provider `deepseek`/);
    assert.doesNotMatch(notice.content, /no longer in the model catalog/);
    assert.equal((state.substituted as Array<{ offerDefault: boolean }>)[0]?.offerDefault, false);
  } finally { svc.dispose(); }
});

test("unit5b model not found at spawn: one retry, same-provider substitute, 'no longer in the catalog', offer made", async () => {
  const { host, state } = makeHost();
  const { deps, spawns } = r3Deps({ provider: "deepseek", id: "deepseek-v4-flash-vision-exp" },
    (a) => (hasFlags(a) ? { spawnError: exitMsg("Model deepseek/deepseek-v4-flash-vision-exp not found") } : undefined));
  const svc = new RustService(host, deps);
  try {
    const r = await svc.initialize({ fresh: true });
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(spawns.length, 2);
    assert.equal(svc.getModel()?.id, "deepseek-v4-pro");
    const notice = cards(state.events).find((x) => x.type === "warning");
    assert.ok(notice);
    assert.match(notice.content, /no longer in the model catalog/);
    assert.equal((state.substituted as Array<{ offerDefault: boolean }>)[0]?.offerDefault, true);
  } finally { svc.dispose(); }
});

test("unit5b a substitute that equals the binary's own pick is still switched to and announced", async () => {
  const { host, state } = makeHost();
  const { deps, rec } = r3Deps({ provider: "deepseek", id: "deepseek-v4-pro" },
    (a) => (hasFlags(a) ? { spawnError: exitMsg(NOKEY("deepseek")) } : undefined),
    { hasCredential: (p: string) => p === "binprov" });
  const svc = new RustService(host, deps);
  try {
    assert.equal((await svc.initialize({ fresh: true })).success, true);
    assert.equal(svc.getModel()?.id, "bin-default");
    assert.equal(rec.setModelCalls, 1);
    const notice = cards(state.events).find((x) => x.type === "warning");
    assert.ok(notice);
    assert.match(notice.content, /`binprov\/bin-default`/);
  } finally { svc.dispose(); }
});

test("unit5b an unrelated startup exit is not retried and fails exactly as before", async () => {
  for (const stderr of ["OAuth token expired or invalid", NOKEY("anthropic")]) {
    const { host } = makeHost();
    const msg = exitMsg(stderr);
    const { deps, spawns } = r3Deps({ provider: "deepseek", id: "deepseek-v4-pro" }, () => ({ spawnError: msg }));
    const svc = new RustService(host, deps);
    try {
      const r = await svc.initialize({ fresh: true });
      assert.equal(r.success, false);
      assert.equal(spawns.length, 1, `no retry for: ${stderr}`);
      assert.equal(r.error, `Failed to start Rust Pi: ${msg}`);
    } finally { svc.dispose(); }
  }
});

test("unit5b retried ONCE only: a failing retry reports the original cause and the retry's", async () => {
  const { host } = makeHost();
  const { deps, spawns } = r3Deps({ provider: "deepseek", id: "deepseek-v4-pro" },
    (a) => ({ spawnError: exitMsg(NOKEY(hasFlags(a) ? "deepseek" : "binprov")) }));
  const svc = new RustService(host, deps);
  try {
    const r = await svc.initialize({ fresh: true });
    assert.equal(r.success, false);
    assert.equal(spawns.length, 2);
    assert.match(r.error ?? "", /provider deepseek\..*retried once without --provider\/--model, which also failed: .*provider binprov/);
  } finally { svc.dispose(); }
});

test("unit5b after a stale retry with no credentialed substitute, init fails loudly instead of running on the binary's pick", async () => {
  const { host, state } = makeHost();
  const { deps, rec } = r3Deps({ provider: "deepseek", id: "deepseek-v4-pro" },
    (a) => (hasFlags(a) ? { spawnError: exitMsg(NOKEY("deepseek")) } : undefined),
    { hasCredential: () => false }); // fail-open scope: no credential detectable anywhere
  const svc = new RustService(host, deps);
  try {
    const r = await svc.initialize({ fresh: true });
    assert.equal(r.success, false);
    assert.match(r.error ?? "", /No API key found for provider `deepseek`/);
    assert.match(r.error ?? "", /change `pi-code-gui\.defaultModelProvider` and `pi-code-gui\.defaultModelId`/);
    assert.equal(rec.setModelCalls, 0, "never switch onto an uncredentialed model");
    assert.ok(rec.disposed >= 2, "both children disposed");
    assert.equal(cards(state.events).filter((x) => /No model is active/.test(x.content)).length, 0);
    assert.deepEqual(state.substituted, []);
  } finally { svc.dispose(); }
});

test("unit5b after a stale retry whose substitution fails, init fails loudly with the reason", async () => {
  const { host, state } = makeHost();
  const { deps, rec } = r3Deps({ provider: "deepseek", id: "deepseek-v4-flash-vision-exp" },
    (a) => (hasFlags(a) ? { spawnError: exitMsg("Model deepseek/deepseek-v4-flash-vision-exp not found") } : { setModelFails: true }));
  const svc = new RustService(host, deps);
  try {
    const r = await svc.initialize({ fresh: true });
    assert.equal(r.success, false);
    assert.match(r.error ?? "", /Retried without your default model `deepseek\/deepseek-v4-flash-vision-exp`.*switching to deepseek\/deepseek-v4-pro failed \(Model not found/);
    assert.equal(rec.setModelCalls, 1);
    assert.equal(cards(state.events).filter((x) => /No model is active/.test(x.content)).length, 0);
    assert.deepEqual(state.substituted, []);
  } finally { svc.dispose(); }
});

test("unit5b a stale exit then an extension conflict on the retry: three starts, the third flag-free with --no-extensions", async () => {
  const { host, state } = makeHost();
  const { deps, spawns } = r3Deps({ provider: "deepseek", id: "deepseek-v4-pro" }, (a, n) =>
    n === 1 ? { spawnError: exitMsg(NOKEY("deepseek")) }
      : n === 2 ? { spawnError: "invalid extension manifest: missing field `parameters` at line 3" } : undefined,
  { hasCredential: (p: string) => p !== "deepseek" });
  const svc = new RustService(host, deps);
  try {
    const r = await svc.initialize({ fresh: true });
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(spawns.length, 3);
    assert.equal(hasFlags(spawns[2]), false);
    assert.ok(spawns[2].includes("--no-extensions"));
    assert.equal(svc.getModel()?.id, "model-a");
    assert.ok(cards(state.events).find((x) => x.type === "warning" && /deepseek-v4-pro/.test(x.content)));
  } finally { svc.dispose(); }
});

test("unit5b a stale exit on the handshake-timeout --no-extensions respawn is retried too", async () => {
  const { host } = makeHost();
  const { deps, spawns } = r3Deps({ provider: "deepseek", id: "deepseek-v4-pro" }, (a, n) =>
    n === 1 ? { loadError: true, hangState: true }
      : hasFlags(a) ? { spawnError: exitMsg(NOKEY("deepseek")) } : undefined,
  { hasCredential: (p: string) => p !== "deepseek" });
  const svc = new RustService(host, deps);
  try {
    const r = await svc.initialize({ fresh: true });
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(spawns.length, 3);
    assert.ok(spawns[1].includes("--no-extensions") && hasFlags(spawns[1]));
    assert.ok(spawns[2].includes("--no-extensions") && !hasFlags(spawns[2]));
    assert.equal(svc.getModel()?.id, "model-a");
  } finally { svc.dispose(); }
});

test("unit5b the once-guard holds across the --no-extensions respawn: a stale-looking exit there is not retried again", async () => {
  const { host } = makeHost();
  const { deps, spawns } = r3Deps({ provider: "deepseek", id: "deepseek-v4-pro" }, (_a, n) =>
    n === 1 ? { spawnError: exitMsg(NOKEY("deepseek")) }
      : n === 2 ? { spawnError: "invalid extension manifest: missing field `parameters` at line 3" }
        : { spawnError: exitMsg(NOKEY("deepseek")) });
  const svc = new RustService(host, deps);
  try {
    const r = await svc.initialize({ fresh: true });
    assert.equal(r.success, false);
    assert.equal(spawns.length, 3, "one stale retry per initialize, never a second");
  } finally { svc.dispose(); }
});

test("unit5b missing key: even when key detection disagrees with the binary, never the provider it rejected", async () => {
  const { host } = makeHost();
  const { deps } = r3Deps({ provider: "deepseek", id: "deepseek-v4-pro" },
    (a) => (hasFlags(a) ? { spawnError: exitMsg(NOKEY("deepseek")) } : undefined),
    { hasCredential: () => true });
  const svc = new RustService(host, deps);
  try {
    assert.equal((await svc.initialize({ fresh: true })).success, true);
    assert.notEqual(svc.getModel()?.provider, "deepseek");
  } finally { svc.dispose(); }
});

test("unit5b model not found at spawn although the catalog lists it: never re-selected, never called withdrawn", async () => {
  const { host, state } = makeHost();
  const { deps, rec } = r3Deps({ provider: "deepseek", id: "deepseek-v4-pro" },
    (a) => (hasFlags(a) ? { spawnError: exitMsg("Model deepseek/deepseek-v4-pro not found") } : undefined));
  const svc = new RustService(host, deps);
  try {
    assert.equal((await svc.initialize({ fresh: true })).success, true);
    assert.notEqual(svc.getModel()?.id, "deepseek-v4-pro", "the rejected default is not a substitute for itself");
    assert.equal(rec.setModelCalls, 1);
    const notice = cards(state.events).find((x) => x.type === "warning");
    assert.ok(notice, "announced, not a quiet re-select");
    assert.match(notice.content, /rejected it at startup as not found/);
    assert.doesNotMatch(notice.content, /no credential/);
  } finally { svc.dispose(); }
});

test("unit5b a resumed session's startup exit is never treated as a stale default (it passed no --provider/--model)", async () => {
  const { host } = makeHost();
  const msg = exitMsg(NOKEY("deepseek"));
  const { deps, spawns } = r3Deps({ provider: "deepseek", id: "deepseek-v4-pro" }, () => ({ spawnError: msg }));
  const svc = new RustService(host, deps);
  try {
    const r = await svc.initialize({ openPath: join(tmp, "resumed-r3.jsonl") });
    assert.equal(r.success, false);
    assert.equal(spawns.length, 1, "no retry for a resumed session");
    assert.equal(r.error, `Failed to start Rust Pi: ${msg}`);
  } finally { svc.dispose(); }
});

test("unit5b R1: a resumed session's identity block names no launch model (none was requested)", async () => {
  const { host } = makeHost();
  const { deps, spawns } = r3Deps({ provider: "deepseek", id: "deepseek-v4-pro" }, () => undefined);
  const svc = new RustService(host, deps);
  try {
    await svc.initialize({ openPath: join(tmp, "resumed-r1.jsonl") });
    assert.equal(hasFlags(spawns[0]), false);
    assert.doesNotMatch(identityOf(spawns[0]), /- Model/);
  } finally { svc.dispose(); }
  const fresh = r3Deps({ provider: "deepseek", id: "deepseek-v4-pro" }, () => undefined);
  const svc2 = new RustService(makeHost().host, fresh.deps);
  try {
    await svc2.initialize({ fresh: true });
    assert.match(identityOf(fresh.spawns[0]), /`deepseek\/deepseek-v4-pro`/, "a fresh session names what it requested");
  } finally { svc2.dispose(); }
});

// ── Unit 5c: fold of the 5b review of record (S1, S2, S3) ─────────────────────────────────

const ANTH = { id: "a1", provider: "anthropic", name: "Anthropic One" };

test("unit5c S1: a key the extension injects from SecretStorage counts as a credential for the substitute", async () => {
  // Review R5 (unstubbed): no env keys, an Anthropic key only in SecretStorage (cfg.anthropicApiKey,
  // injected into the binary's env as ANTHROPIC_API_KEY). The binary lists anthropic and can use it,
  // yet the recovery said "no model from a provider with a credential is available".
  const { host, state } = makeHost();
  const { deps } = r3Deps({ provider: "deepseek", id: "x", cfg: { anthropicApiKey: "k" } },
    (a) => (hasFlags(a) ? { spawnError: exitMsg(NOKEY("deepseek")) } : { addModels: [ANTH] }),
    { hasCredential: () => false });
  const svc = new RustService(host, deps);
  try {
    const r = await svc.initialize({ fresh: true });
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(`${svc.getModel()?.provider}/${svc.getModel()?.id}`, "anthropic/a1");
    assert.equal((state.substituted as Array<{ offerDefault: boolean }>)[0]?.offerDefault, false);
  } finally { svc.dispose(); }
});

test("unit5c S1: the OpenAI key injected from SecretStorage counts too", async () => {
  const { host } = makeHost();
  const OAI = { id: "o1", provider: "openai", name: "OpenAI One" };
  const { deps } = r3Deps({ provider: "deepseek", id: "x", cfg: { openaiApiKey: "k" } },
    (a) => (hasFlags(a) ? { spawnError: exitMsg(NOKEY("deepseek")) } : { addModels: [OAI] }),
    { hasCredential: () => false });
  const svc = new RustService(host, deps);
  try {
    const r = await svc.initialize({ fresh: true });
    assert.equal(r.success, true, JSON.stringify(r));
    assert.equal(`${svc.getModel()?.provider}/${svc.getModel()?.id}`, "openai/o1");
  } finally { svc.dispose(); }
});

test("unit5c S1: the model picker keeps a provider whose only key is the injected SecretStorage one", async () => {
  // Same predicate, other consumer (scopeModels): with another provider credentialed in the env,
  // the scope is not fail-open, so an injected-key provider used to vanish from the picker.
  const { host, state } = makeHost();
  const { deps } = r3Deps({ provider: "deepseek", id: "deepseek-v4-pro", cfg: { anthropicApiKey: "k" } },
    () => ({ addModels: [ANTH] }),
    { hasCredential: (p: string) => p === "deepseek" });
  const svc = new RustService(host, deps);
  try {
    assert.equal((await svc.initialize({ fresh: true })).success, true);
    assert.ok(state.cycleModels.some((m) => m.provider === "anthropic"), JSON.stringify(state.cycleModels));
    assert.ok(!state.cycleModels.some((m) => m.provider === "other-provider"), "scoping still applies");
  } finally { svc.dispose(); }
});

test("unit5d SF-A: the picker keeps the running model's provider even when the predicate cannot see its credentials", async () => {
  // A provider credentialed outside what the predicate checks (e.g. cloud config or a role) plus an
  // injected key for another provider makes the scope non-fail-open; the session's own provider
  // must not vanish from /model.
  const { host, state } = makeHost();
  const { deps } = r3Deps({ provider: "binprov", id: "bin-default", cfg: { anthropicApiKey: "k" } },
    () => ({ addModels: [ANTH] }),
    { hasCredential: () => false });
  const svc = new RustService(host, deps);
  try {
    assert.equal((await svc.initialize({ fresh: true })).success, true);
    assert.equal(svc.getModel()?.provider, "binprov");
    assert.ok(state.cycleModels.some((m) => m.provider === "binprov"), JSON.stringify(state.cycleModels));
    assert.ok(state.cycleModels.some((m) => m.provider === "anthropic"), JSON.stringify(state.cycleModels));
    assert.ok(!state.cycleModels.some((m) => m.provider === "other-provider"), "scoping still applies to the rest");
  } finally { svc.dispose(); }
});

// Observed verbatim from rust-pi 0.8.0 as RustProcess reports the tail (scratch agent home,
// models.json with a duplicate canonical identity plus a custom provider; no prompt; only the File
// path shortened): the binary rejects the WHOLE file, so a custom default it defined reads
// "not found". That is not a stale default.
const MODELS_JSON_REJECTED = [
  'Warning: models.json error: JSON error: models.json provider "deepseek" contains model IDs "deepseek-flash" and "deepseek-flash" with duplicate canonical model identity ("deepseek", "deepseek-flash") at line 1 column 605',
  "File: /home/u/.pi/agent/models.json",
  "Model my-custom/my-model not found",
].join("\n");

test("unit5d SF-B: a provider-less missing-key loud failure names only defaultModelId, no placeholder", async () => {
  const { host } = makeHost();
  const { deps } = r3Deps({ provider: "deepseek", id: "deepseek-v4-pro", cfg: { defaultModelProvider: undefined } },
    (a) => (hasFlags(a) ? { spawnError: exitMsg(NOKEY("deepseek")) } : undefined),
    { hasCredential: () => false });
  const svc = new RustService(host, deps);
  try {
    const r = await svc.initialize({ fresh: true });
    assert.equal(r.success, false);
    assert.match(r.error ?? "", /No API key found for its provider — add a key, or change `pi-code-gui\.defaultModelId`/);
    assert.doesNotMatch(r.error ?? "", /defaultModelProvider|`\?`|\?\//);
  } finally { svc.dispose(); }
});

test("unit5c S2 classifier: a models.json the binary rejected is never a stale default", () => {
  assert.equal(classifyStaleDefaultExit(exitMsg(MODELS_JSON_REJECTED), "my-custom", "my-model"), null);
  assert.equal(classifyStaleDefaultExit(exitMsg("Warning: models.json error: JSON error: key must be a string at line 1 column 2\n\nFile: /x/models.json\nModel my-custom/my-model not found"), "my-custom", "my-model"), null);
  // Either line alone marks it: the Warning line without a File line (not observed; pins the
  // review's own condition, which the File-line fallback would otherwise mask).
  assert.equal(classifyStaleDefaultExit(exitMsg("Warning: models.json error: JSON error: x\nModel my-custom/my-model not found"), "my-custom", "my-model"), null);
  // Control: the same "not found" alone is still classified.
  assert.equal(classifyStaleDefaultExit(exitMsg("Model my-custom/my-model not found"), "my-custom", "my-model"), "model-not-found");
});

test("unit5c S2: a rejected models.json is not retried, offered or called withdrawn; the error names the file's problem", async () => {
  const { host, state } = makeHost();
  const { deps, spawns, rec } = r3Deps({ provider: "my-custom", id: "my-model" },
    () => ({ spawnError: exitMsg(MODELS_JSON_REJECTED) }));
  const svc = new RustService(host, deps);
  try {
    const r = await svc.initialize({ fresh: true });
    assert.equal(r.success, false);
    assert.equal(spawns.length, 1, "no retry");
    assert.equal(rec.setModelCalls, 0);
    assert.match(r.error ?? "", /Warning: models\.json error: JSON error: .*duplicate canonical model identity/);
    assert.deepEqual(state.substituted, [], "no overwrite offer");
    assert.equal(cards(state.events).filter((x) => /no longer in the model catalog/.test(x.content)).length, 0);
  } finally { svc.dispose(); }
});

test("unit5c S3: a provider-less missing-key default gets plain wording, not a fake provider id", async () => {
  const { host, state } = makeHost();
  const { deps } = r3Deps({ provider: "deepseek", id: "deepseek-v4-pro", cfg: { defaultModelProvider: undefined } },
    (a) => (hasFlags(a) ? { spawnError: exitMsg(NOKEY("deepseek")) } : undefined),
    { hasCredential: (p: string) => p !== "deepseek" });
  const svc = new RustService(host, deps);
  try {
    assert.equal((await svc.initialize({ fresh: true })).success, true);
    const notice = cards(state.events).find((x) => x.type === "warning");
    assert.ok(notice, JSON.stringify(cards(state.events)));
    assert.match(notice.content, /add an API key for its provider;/);
    assert.match(notice.content, /change `pi-code-gui\.defaultModelId`\./);
    assert.doesNotMatch(notice.content, /defaultModelProvider/, "no provider is configured, so there is none to change");
  } finally { svc.dispose(); }
});

test("unit5c S2: a stderr tail cut mid-warning (RustProcess keeps the last 500 chars) is still a models.json rejection", () => {
  // The cut removes the leading "Warning: models.json error:" first; the File line survives.
  const cut = "…canonical model identity (\"deepseek\", \"deepseek-flash\") at line 1 column 605\nFile: /x/models.json\nModel my-custom/my-model not found";
  assert.equal(classifyStaleDefaultExit(exitMsg(cut), "my-custom", "my-model"), null);
  assert.equal(classifyStaleDefaultExit(exitMsg("…\nFile: C:\\u\\.pi\\agent\\models.json\nModel my-custom/my-model not found"), "my-custom", "my-model"), null);
});
