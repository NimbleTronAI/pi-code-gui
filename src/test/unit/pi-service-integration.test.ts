// Integration coverage across the PiService ↔ PiBackend seam. The layered unit tests cover each
// side in isolation; this drives a REAL PiService (constructed headlessly via the vscode stub —
// see scripts/vscode-stub.mjs) with a fake PiBackend injected, exercising the runtime-branch
// DECISIONS where dual-runtime bugs hide: the sendPrompt dispatch matrix and the
// optimistic-vs-eager toggle-flip divergence. This was the audits' deferred integration gap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { PiService } from "../../pi-service.js";
import { backendCapabilityDefaults, type PiBackend, type BackendUsage } from "../../pi-backend.js";
import type { Runtime, PiServiceEvent } from "../../types.js";

type Any = ReturnType<typeof JSON.parse>;

/** A recording fake PiBackend. sendPrompt/setAutoCompaction/etc. just log their calls; toggles
 *  do NOT echo back (so the test observes PiService's own eager-vs-not flip, not the backend's). */
class FakeBackend implements PiBackend {
  calls: Array<{ m: string; args: Any[] }> = [];
  usage: BackendUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextPercent: null, contextWindow: 0 };
  constructor(private kind: Runtime) {}
  private log(m: string, ...args: Any[]) { this.calls.push({ m, args }); }
  saw(m: string) { return this.calls.filter((c) => c.m === m); }

  get capabilities() { return backendCapabilityDefaults(this.kind); }
  async sendPrompt(text: string, images: Any, mode: string | undefined) { this.log("sendPrompt", text, images, mode); }
  abort() { this.log("abort"); }
  abortBash() { this.log("abortBash"); }
  async compact() { this.log("compact"); }
  getModel() { return { id: "m", provider: "p" }; }
  async setModel(provider: string, id: string) { this.log("setModel", provider, id); return { id, provider }; }
  getThinkingLevel() { return "off"; }
  async setThinkingLevel(level: string) { this.log("setThinkingLevel", level); return level; }
  applyThinkingLevel(level: string) { this.log("applyThinkingLevel", level); }
  private _active = false;
  private _streaming = false;
  getAgentRunActive() { return this._active; }
  setAgentRunActive(v: boolean) { this._active = v; }
  isStreaming() { return this._streaming; }
  setStreaming(v: boolean) { this._streaming = v; }
  async setAutoCompaction(enabled: boolean) { this.log("setAutoCompaction", enabled); }
  async setAutoRetry(enabled: boolean) { this.log("setAutoRetry", enabled); }
  async exportToHtml(p: string) { this.log("exportToHtml", p); return p; }
  getUsage() { return this.usage; }
  getEntries() { return []; }
  getSlashCommands() { return []; }
  async getAvailableModels() { return []; }
  promoteToSteer(text: string) { this.log("promoteToSteer", text); }
  clearQueue() { this.log("clearQueue"); }
  dispose() { this.log("dispose"); }
}

/** Build a PiService with a fake backend wired in as the active runtime (bypassing initialize). */
function makePi(kind: Runtime): { pi: PiService; backend: FakeBackend; events: PiServiceEvent[] } {
  (globalThis as Any).__vscodeMock.config = {};
  (globalThis as Any).__vscodeMock.calls = [];
  const pi = new PiService();
  const backend = new FakeBackend(kind);
  (pi as Any)._backendKind = kind;
  if (kind === "rust") { (pi as Any)._rust = backend; } else { (pi as Any)._sdk = backend; }
  const events: PiServiceEvent[] = [];
  pi.onEvent((e) => events.push(e));
  return { pi, backend, events };
}

// ── backend seam ─────────────────────────────────────────────────────
test("the backend accessor routes to the active runtime's backend", () => {
  assert.equal(makePi("rust").pi.runtime, "rust");
  assert.equal(makePi("typescript").pi.runtime, "typescript");
  const { pi, backend } = makePi("rust");
  void pi.abort();
  assert.equal(backend.saw("abort").length, 1, "abort delegated to the injected backend");
});

// ── sendPrompt dispatch matrix ───────────────────────────────────────
test("sendPrompt: a mode-less prompt that would preempt an in-flight turn is DROPPED (not sent)", async () => {
  const { pi, backend, events } = makePi("rust");
  backend.setAgentRunActive(true); // a turn is live (the flag is backend-owned now)
  await pi.sendPrompt("stale duplicate", undefined, undefined);
  assert.equal(backend.saw("sendPrompt").length, 0, "not forwarded to the backend");
  assert.ok(events.some((e) => e.type === "custom-message" && String((e as Any).data.content).includes("Ignored a duplicate prompt")));
});

test("sendPrompt on Rust: a slash command is forwarded RAW (Rust owns its slashes)", async () => {
  const { pi, backend } = makePi("rust"); // interceptSlashCommands = false
  await pi.sendPrompt("/whatever", undefined, undefined);
  const s = backend.saw("sendPrompt");
  assert.equal(s.length, 1);
  assert.deepEqual(s[0].args.slice(0, 3), ["/whatever", undefined, undefined], "raw-forwarded, not intercepted");
});

test("sendPrompt on TS: an unknown slash command falls through to the backend prompt path", async () => {
  const { pi, backend } = makePi("typescript"); // interceptSlashCommands = true
  await pi.sendPrompt("/notacommand", undefined, undefined);
  assert.equal(backend.saw("sendPrompt").length, 1, "unhandled slash still reaches the backend");
});

test("sendPrompt: steer/queue mode is forwarded with the mode intact", async () => {
  const { pi, backend } = makePi("rust");
  await pi.sendPrompt("follow up", undefined, "steer");
  assert.deepEqual(backend.saw("sendPrompt")[0].args.slice(0, 3), ["follow up", undefined, "steer"]);
});

test("sendPrompt: a plain turn forwards with no mode", async () => {
  const { pi, backend } = makePi("rust");
  await pi.sendPrompt("hello", undefined, undefined);
  assert.deepEqual(backend.saw("sendPrompt")[0].args.slice(0, 3), ["hello", undefined, undefined]);
});

// ── toggle flip divergence (the runtime-branch the audit flagged) ─────
test("toggleAutoCompaction: TS flips PiService state EAGERLY; Rust does NOT (waits for the echo)", async () => {
  const ts = makePi("typescript");
  const before = ts.pi.autoCompactionEnabled;
  await ts.pi.toggleAutoCompaction();
  assert.equal(ts.pi.autoCompactionEnabled, !before, "TS flipped eagerly");
  assert.equal(ts.backend.saw("setAutoCompaction").length, 1);

  const rs = makePi("rust");
  const rbefore = rs.pi.autoCompactionEnabled;
  await rs.pi.toggleAutoCompaction(); // fake backend does NOT echo via the host callback
  assert.equal(rs.pi.autoCompactionEnabled, rbefore, "Rust did NOT flip eagerly — it waits for the wire echo");
  assert.equal(rs.backend.saw("setAutoCompaction").length, 1, "but the wire call still went out");
});

test("toggleAutoRetry: same optimistic-vs-eager divergence", async () => {
  const ts = makePi("typescript");
  const before = ts.pi.autoRetryEnabled;
  await ts.pi.toggleAutoRetry();
  assert.equal(ts.pi.autoRetryEnabled, !before, "TS flipped eagerly");

  const rs = makePi("rust");
  const rbefore = rs.pi.autoRetryEnabled;
  await rs.pi.toggleAutoRetry();
  assert.equal(rs.pi.autoRetryEnabled, rbefore, "Rust did NOT flip eagerly");
});
