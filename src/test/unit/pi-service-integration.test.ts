// Integration coverage across the PiService ↔ PiBackend seam. The layered unit tests cover each
// side in isolation; this drives a REAL PiService (constructed headlessly via the vscode stub —
// see scripts/vscode-stub.mjs) with a fake PiBackend injected, exercising the runtime-branch
// DECISIONS where dual-runtime bugs hide: the sendPrompt dispatch matrix and the
// optimistic-vs-eager toggle-flip divergence. This was the audits' deferred integration gap.
import { test } from "node:test";
import { RUST_SESSION_NAME_ENTRY } from "../../session-format.js";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiService } from "../../pi-service.js";
import { backendCapabilityDefaults, type PiBackend, type BackendUsage } from "../../pi-backend.js";
import type { Runtime, PiServiceEvent } from "../../types.js";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

/** repo/src — these tests read pi-service.ts as text for the structural guards at the bottom. */
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src");

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
  async reloadContext() { this.log("reloadContext"); return this.kind === "typescript"; }
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

// ── Rust session_info append: never write while the binary owns the file ──
// rust-pi owns its session JSONL and appends to it as a turn progresses. Our name-entry append
// is O_APPEND, but if the binary writes via a tracked offset instead, an interleaved write could
// clobber ours — unknowable under the clean-room wall. So we only ever write while the binary is
// idle, and at dispose only AFTER the child is torn down.
//
// The ENTRY TYPE matters as much as the timing: these assertions read
// RUST_SESSION_NAME_ENTRY rather than a literal, because writing the literal `session_info` here
// is precisely the bug that made rust-pi reject whole sessions (see rust-session-name.test.ts).
function rustPiWithSessionFile(): { pi: PiService; backend: FakeBackend; file: string; dir: string; entries: () => Any[] } {
  const { pi, backend } = makePi("rust");
  const dir = mkdtempSync(join(tmpdir(), "pi-sessinfo-"));
  const file = join(dir, "session.jsonl");
  writeFileSync(file, JSON.stringify({ type: "message", id: "m1" }) + "\n");
  // RustService-only members PiService reaches for directly (not part of PiBackend).
  (backend as Any).getSessionPath = () => file;
  (backend as Any).clearQueueIfAny = () => {};
  (backend as Any).captureContext = () => {};
  const entries = () => readFileSync(file, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  return { pi, backend, file, dir, entries };
}
const names = (es: Any[]) => es.filter((e) => e.type === RUST_SESSION_NAME_ENTRY).map((e) => e.name);

test("setSessionName writes immediately when the binary is IDLE", () => {
  const { pi, dir, entries } = rustPiWithSessionFile();
  try {
    pi.setSessionName("idle title");
    assert.deepEqual(names(entries()), ["idle title"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("setSessionName DEFERS the write while a turn is in flight", () => {
  const { pi, backend, dir, entries } = rustPiWithSessionFile();
  try {
    backend.setAgentRunActive(true);
    pi.setSessionName("mid-turn title");
    assert.deepEqual(names(entries()), [], "nothing written into the JSONL mid-turn");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("a deferred name is flushed when the run ends", () => {
  const { pi, backend, dir, entries } = rustPiWithSessionFile();
  try {
    backend.setAgentRunActive(true);
    pi.setSessionName("deferred title");
    assert.deepEqual(names(entries()), []);
    // agent_end clears the run flag → the pending entry lands.
    (pi as Any).handleAgentEvent({ type: "agent_end", messages: [] });
    assert.deepEqual(names(entries()), ["deferred title"]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("dispose tears the child down BEFORE appending the name", () => {
  const { pi, backend, dir, entries } = rustPiWithSessionFile();
  try {
    backend.setAgentRunActive(true);
    pi.setSessionName("dispose title");
    assert.deepEqual(names(entries()), [], "still pending");
    pi.dispose();
    assert.equal(backend.saw("dispose").length, 1, "child disposed");
    assert.deepEqual(names(entries()), ["dispose title"], "appended after teardown");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

// ── regression guards for the two runtime-gated slash commands ────────────
// Both failed the same way: a code path that only ever worked on the TypeScript backend, with
// no signal on Rust. Structural checks, because both live behind private members that need a
// real vscode + a real SDK to construct.
test("/login builds its deps from the SHARED runtime, not the SDK session's", () => {
  const src = readFileSync(join(SRC, "pi-service.ts"), "utf-8");
  const body = src.slice(src.indexOf("private async makeAuthFlowDeps"));
  const decl = body.slice(0, body.indexOf("\n  }"));

  assert.match(decl, /modelRuntime: await this\.sharedModelRuntime\(\)/,
    "must use the lazily-built runtime — it is the only one that exists on Rust");
  assert.doesNotMatch(decl, /modelRuntime: this\.modelRuntime\b/,
    "this.modelRuntime is null on Rust, which made /login return before showing any prompt");
});

test("/tools' unsupported-runtime notice goes to the chat, not a notification popup", () => {
  const src = readFileSync(join(SRC, "pi-service.ts"), "utf-8");
  const body = src.slice(src.indexOf("async pickActiveTools"));
  const guard = body.slice(0, body.indexOf("if (!this.session)"));

  assert.match(guard, /this\.emit\(\{ type: "custom-message"/,
    "the answer belongs where /tools was typed");
  assert.doesNotMatch(guard, /vscode\.window\.show(Information|Warning|Error)Message/,
    "a popup for a command typed in the chat is the thing being fixed");
});

// ── /new must visibly reset the chat ─────────────────────────────────
// `sessionReset` was defined in the protocol AND fully handled in the webview (resetChat()
// clears the DOM, tool blocks, bash blocks and history) — but nothing in the extension ever
// sent it. So /new disposed and recreated the session correctly while the previous
// conversation stayed on screen, which is indistinguishable from the command being ignored.
// Reported from a live Rust session; the SDK path had the identical gap.
test("newSession() emits sessionReset so the webview actually clears", () => {
  const src = readFileSync(join(SRC, "pi-service.ts"), "utf-8");
  const body = src.slice(src.indexOf("async newSession"));
  const decl = body.slice(0, body.indexOf("\n  }"));
  const resets = [...decl.matchAll(/emit\(\{\s*type:\s*"sessionReset"/g)].length;
  assert.equal(resets, 2,
    "BOTH branches must reset: the no-in-process-session path (Rust) and the SDK path");
  // The reset has to precede the re-init, or the fresh session's replay is wiped by it.
  assert.ok(decl.indexOf('"sessionReset"') < decl.indexOf("initialize({ fresh: true })"),
    "sessionReset must be emitted BEFORE the fresh initialize replays");
});

test("sessionReset is a real protocol message the webview handles", () => {
  const proto = readFileSync(join(SRC, "shared", "protocol.ts"), "utf-8");
  assert.match(proto, /z\.literal\("sessionReset"\)/, "must stay in the outbound union");
  const handlers = readFileSync(join(SRC, "webview", "handlers", "index.ts"), "utf-8");
  assert.match(handlers, /case "sessionReset":[^\n]*resetChat\(\)/,
    "the webview must still clear on it — this is the half that already worked");
});

test("BOTH backends inject the identity block from the SAME shared builder", () => {
  // If either path grew its own copy, the two could drift into telling different stories about
  // the same architecture — the exact confusion this exists to end.
  const sdk = readFileSync(join(SRC, "sdk-service.ts"), "utf-8");
  const rust = readFileSync(join(SRC, "rust-service.ts"), "utf-8");
  for (const [name, src] of [["sdk-service", sdk], ["rust-service", rust]] as const) {
    assert.match(src, /buildRuntimeIdentityPrompt\(/, `${name} must inject the identity block`);
    assert.match(src, /from "\.\/runtime-identity\.js"/, `${name} must use the shared builder`);
  }
  assert.match(rust, /--append-system-prompt/, "Rust injects via the binary's flag");
  assert.match(sdk, /systemPromptOverride/, "the SDK injects via its prompt override");
});

test("the auth progress wrapper aborts on SUCCESS, not only on cancellation", () => {
  // Aborting only on cancel leaves an unconsumed prompt open after a successful login.
  const src = readFileSync(join(SRC, "pi-service.ts"), "utf-8");
  const body = src.slice(src.indexOf("withProgress: (title, task)"));
  const decl = body.slice(0, body.indexOf("openExternal:"));
  assert.match(decl, /finally\s*\{[\s\S]*controller\.abort\(\)/,
    "the controller must abort in a finally so completion dismisses stray prompts");
});

test("a successful login RESTARTS a Rust session that never started", () => {
  // "Start a new session for it to take effect" stranded the user in a tab that answered every
  // prompt with "this session isn't running" — while holding the credential that would fix it.
  const src = readFileSync(join(SRC, "pi-service.ts"), "utf-8");
  const body = src.slice(src.indexOf("private afterLoginForRuntime"));
  const decl = body.slice(0, body.indexOf("\n  }\n"));
  assert.match(decl, /if \(!this\.initialized\)/, "must detect the dead-session case");
  assert.match(decl, /initialize\(\{ fresh: true \}\)/, "and restart it rather than instruct the user");
  assert.match(decl, /"sessionReset"/, "clearing the failed session's chat is part of restarting it");
});

// ── abort must be acknowledged, and must not fail silently ───────────
// Reported live: two aborts mid-turn gave different results, "neither a clean interrupt".
// RustService.abort() is two fire-and-forget writes down a pipe — nothing correlates or confirms
// them — and PiService did nothing locally, so the outcome depended entirely on where the abort
// landed and whether the subprocess happened to be reading stdin.
test("abort() warns when the turn is STILL running after the grace period", async () => {
  const { pi, backend, events } = makePi("rust");
  backend.setAgentRunActive(true);          // a turn that ignores the abort
  await pi.abort();
  await new Promise((r) => setTimeout(r, 5100));
  const warned = events.filter((e: Any) =>
    e.type === "custom-message" && /still running/i.test(String(e.data?.content ?? "")));
  assert.equal(warned.length, 1, "a stop that never lands must be surfaced, not left silent");
});

test("abort() stays QUIET when the turn actually ends", async () => {
  const { pi, backend, events } = makePi("rust");
  backend.setAgentRunActive(true);
  await pi.abort();
  backend.setAgentRunActive(false);         // the abort landed
  await new Promise((r) => setTimeout(r, 5100));
  const warned = events.filter((e: Any) =>
    e.type === "custom-message" && /still running/i.test(String(e.data?.content ?? "")));
  assert.equal(warned.length, 0, "a successful abort must not produce a scary message");
});
