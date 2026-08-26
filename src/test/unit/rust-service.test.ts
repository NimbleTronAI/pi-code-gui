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
import { RustService, type RustHost, type RustDeps, type RustSessionConfig } from "../../rust-service.js";
import type { PiServiceEvent } from "../../types.js";

// A fake rust-pi answering the full init handshake. Behavior switches on the
// FAKE_MODE env var so one script covers the happy path and each failure branch.
//  - "ok":         all four handshake RPCs answer with realistic shapes
//  - "no-models":  get_available_models returns an empty list  → degraded warning
//  - "bad-state":  get_state succeeds but lacks model/thinkingLevel → shape probe
const FAKE_SRC = `
const MODE = process.env.FAKE_MODE || "ok";
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
      reply(MODE === "bad-state"
        ? { someUnknownShape: true }
        : { model: { id: "deepseek-v4-pro", provider: "deepseek", api: "openai-completions", reasoning: true, contextWindow: 131072 },
            thinkingLevel: "high", sessionFile: "/tmp/fake-session.jsonl", sessionId: "sess-42",
            autoCompactionEnabled: true, autoRetryEnabled: true });
    } else if (o.type === "get_available_models") {
      reply(MODE === "no-models" ? { models: [] } : { models: [
        { id: "deepseek-v4-pro", provider: "deepseek", name: "DeepSeek V4 Pro" },
        { id: "deepseek-v4-flash", provider: "deepseek", name: "DeepSeek V4 Flash" },
      ]});
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
  };
  return { host, state };
}

/** Stubbed deps: fake binary via node, no vscode anywhere. `mode` drives FAKE_MODE. */
function makeDeps(mode: string, overrides?: Partial<RustDeps>): RustDeps {
  const config: RustSessionConfig = {
    defaultThinkingLevel: "xhigh",
    rustExtensionPolicy: "balanced",
    contextBudget: 0,
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
  assert.equal(state.attempts, 2, "respawned once");
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
      const first = attempts === 1;
      return {
        spawn: async () => {
          if (first) {
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
  assert.equal(attempts, 2, "respawned once with --no-extensions");
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
      const first = attempts === 1;
      return {
        spawn: async () => { if (first) { throw new Error("RPC 'get_state' timed out after 15000ms"); } },
        dispose: () => {},
        isAlive: () => true,
        request: async () => ({ type: "response", success: true, data: {} }),
        send: () => {},
      } as unknown as RustProcess;
    },
  }));

  const result = await svc.initialize({ fresh: true });
  assert.equal(result.success, true, "recovered rather than failing the session");
  assert.equal(attempts, 2, "retried with --no-extensions on the timeout alone");
  const notice = hostState.events
    .map((e) => String(((e as { data?: { content?: string } }).data)?.content ?? ""))
    .find((c) => c.includes("rustExtensions"));
  assert.ok(notice, "tells the user what happened and how to avoid the cost");
  assert.ok(!/pi-web-access|failed to load/.test(notice), "does not invent a culprit it never identified");
  svc.dispose();
});
