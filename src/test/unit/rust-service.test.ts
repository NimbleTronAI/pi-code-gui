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
    getAgentRunActive: () => false,
    setAgentRunActive: () => { /* noop */ },
    setStreaming: () => { /* noop */ },
    getModel: () => state.model,
    setModel: (m) => { state.model = m as Record<string, unknown>; },
    setThinkingLevel: (l) => { state.thinkingLevel = l; },
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
    extensionsMode: () => "auto",
    setupModels: () => ({ piEnv: {}, warnings: [] }),
    sessionDir: () => tmp,
    workspaceCwd: () => tmp,
    config: () => config,
    showError: () => { /* noop */ },
    offerReopen: () => { /* noop */ },
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
    // get_state applied
    assert.equal(state.model?.id, "deepseek-v4-pro");
    assert.equal(state.thinkingLevel, "high");        // binary's state wins over the default
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
