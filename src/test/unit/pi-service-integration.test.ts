// Integration coverage across the PiService ↔ PiBackend seam. The layered unit tests cover each
// side in isolation; this drives a REAL PiService (constructed headlessly via the vscode stub —
// see scripts/vscode-stub.mjs) with a fake PiBackend injected, exercising the orchestration
// DECISIONS: the sendPrompt dispatch matrix, the toggles, abort and naming. This was the audits'
// deferred integration gap.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PiService } from "../../pi-service.js";
import bundledRegistry from "../../model-registry.generated.json";
import type { PiBackend, BackendUsage } from "../../pi-backend.js";
import type { PiServiceEvent } from "../../types.js";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";

/** repo/src — these tests read pi-service.ts as text for the structural guards at the bottom. */
const SRC = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src");

type Any = ReturnType<typeof JSON.parse>;

/** A recording fake PiBackend. sendPrompt/setAutoCompaction/etc. just log their calls; toggles
 *  do NOT echo back (so the test observes PiService's own flip, not the backend's). */
class FakeBackend implements PiBackend {
  namedAs: string | null = null;
  async setSessionName(name: string): Promise<boolean> { this.namedAs = name; return true; }

  calls: Array<{ m: string; args: Any[] }> = [];
  usage: BackendUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextPercent: null, contextWindow: 0 };
  private log(m: string, ...args: Any[]) { this.calls.push({ m, args }); }
  saw(m: string) { return this.calls.filter((c) => c.m === m); }

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
  async reloadContext() { this.log("reloadContext"); return true; }
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

/** Build a PiService with a fake backend wired in (bypassing initialize). */
function makePi(): { pi: PiService; backend: FakeBackend; events: PiServiceEvent[] } {
  (globalThis as Any).__vscodeMock.config = {};
  (globalThis as Any).__vscodeMock.calls = [];
  const pi = new PiService();
  const backend = new FakeBackend();
  (pi as Any)._sdk = backend;
  const events: PiServiceEvent[] = [];
  pi.onEvent((e) => events.push(e));
  return { pi, backend, events };
}

// ── backend seam ─────────────────────────────────────────────────────
test("the backend accessor routes to the injected backend", () => {
  const { pi, backend } = makePi();
  void pi.abort();
  assert.equal(backend.saw("abort").length, 1, "abort delegated to the injected backend");
});

// ── the model catalog is the bundled registry ──────────────────────────
// Thinking-capability reconcile, the registry-miss fallback and the cost rates all read
// PiService.catalogProviders, and the SDK backend reads it through SdkDeps.catalogProviders.
// Both must be the bundled registry generated from pi-ai, synchronously, with no other source.
test("catalogProviders is the bundled registry, and SdkDeps hands the SDK the same object", () => {
  const { pi } = makePi();
  const bundled = (bundledRegistry as Any).providers;
  assert.equal((pi as Any).catalogProviders, bundled, "the getter returns the bundled registry");
  assert.equal((pi as Any).makeSdkDeps().catalogProviders(), bundled, "the SDK backend sees the same catalog");
});

// ── sendPrompt dispatch matrix ───────────────────────────────────────
test("sendPrompt: a mode-less prompt that would preempt an in-flight turn is DROPPED (not sent)", async () => {
  const { pi, backend, events } = makePi();
  backend.setAgentRunActive(true); // a turn is live (the flag is backend-owned now)
  await pi.sendPrompt("stale duplicate", undefined, undefined);
  assert.equal(backend.saw("sendPrompt").length, 0, "not forwarded to the backend");
  assert.ok(events.some((e) => e.type === "custom-message" && String((e as Any).data.content).includes("Ignored a duplicate prompt")));
});

test("sendPrompt: a builtin slash command is intercepted, never sent to the model", async () => {
  const { pi, backend } = makePi();
  await pi.sendPrompt("/tree", undefined, undefined);
  assert.equal(backend.saw("sendPrompt").length, 0, "handled by PiService, not forwarded raw");
});

test("sendPrompt: an unknown slash command falls through to the backend prompt path", async () => {
  const { pi, backend } = makePi();
  await pi.sendPrompt("/notacommand", undefined, undefined);
  assert.equal(backend.saw("sendPrompt").length, 1, "unhandled slash still reaches the backend");
});

test("sendPrompt: steer/queue mode is forwarded with the mode intact", async () => {
  const { pi, backend } = makePi();
  await pi.sendPrompt("follow up", undefined, "steer");
  assert.deepEqual(backend.saw("sendPrompt")[0].args.slice(0, 3), ["follow up", undefined, "steer"]);
});

test("sendPrompt: a plain turn forwards with no mode", async () => {
  const { pi, backend } = makePi();
  await pi.sendPrompt("hello", undefined, undefined);
  assert.deepEqual(backend.saw("sendPrompt")[0].args.slice(0, 3), ["hello", undefined, undefined]);
});

// ── toggles flip PiService state eagerly ─────────────────────────────
test("toggleAutoCompaction: flips PiService state EAGERLY and pushes it to the backend", async () => {
  const ts = makePi();
  const before = ts.pi.autoCompactionEnabled;
  await ts.pi.toggleAutoCompaction();
  assert.equal(ts.pi.autoCompactionEnabled, !before, "flipped eagerly");
  assert.deepEqual(ts.backend.saw("setAutoCompaction").map((c) => c.args[0]), [!before]);
});

test("toggleAutoRetry: flips eagerly and pushes it to the backend", async () => {
  const ts = makePi();
  const before = ts.pi.autoRetryEnabled;
  await ts.pi.toggleAutoRetry();
  assert.equal(ts.pi.autoRetryEnabled, !before, "flipped eagerly");
  assert.deepEqual(ts.backend.saw("setAutoRetry").map((c) => c.args[0]), [!before]);
});

// ── regression guard for /login ───────────────────────────────────────
// Structural, because it lives behind private members that need a real vscode + a real SDK.
test("/login builds its deps from the SHARED runtime, not the SDK session's", () => {
  const src = readFileSync(join(SRC, "pi-service.ts"), "utf-8");
  const body = src.slice(src.indexOf("private async makeAuthFlowDeps"));
  const decl = body.slice(0, body.indexOf("\n  }"));

  assert.match(decl, /modelRuntime: await this\.sharedModelRuntime\(\)/,
    "must use the lazily-built runtime — it exists even before a session starts");
  assert.doesNotMatch(decl, /modelRuntime: this\.modelRuntime\b/,
    "this.modelRuntime is null before a session starts, which made /login return before showing any prompt");
});

// ── /new must visibly reset the chat ─────────────────────────────────
// `sessionReset` was defined in the protocol AND fully handled in the webview (resetChat()
// clears the DOM, tool blocks, bash blocks and history) — but nothing in the extension ever
// sent it. So /new disposed and recreated the session correctly while the previous
// conversation stayed on screen, which is indistinguishable from the command being ignored.
test("newSession() emits sessionReset so the webview actually clears", () => {
  const src = readFileSync(join(SRC, "pi-service.ts"), "utf-8");
  const body = src.slice(src.indexOf("async newSession"));
  const decl = body.slice(0, body.indexOf("\n  }"));
  const resets = [...decl.matchAll(/emit\(\{\s*type:\s*"sessionReset"/g)].length;
  assert.equal(resets, 2,
    "BOTH branches must reset: the no-in-process-session path and the live-session path");
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

test("the auth progress wrapper aborts on SUCCESS, not only on cancellation", () => {
  // Aborting only on cancel leaves an unconsumed prompt open after a successful login.
  const src = readFileSync(join(SRC, "pi-service.ts"), "utf-8");
  const body = src.slice(src.indexOf("withProgress: (title, task)"));
  const decl = body.slice(0, body.indexOf("openExternal:"));
  assert.match(decl, /finally\s*\{[\s\S]*controller\.abort\(\)/,
    "the controller must abort in a finally so completion dismisses stray prompts");
});

// ── abort must be acknowledged, and must not fail silently ───────────
// Reported live: two aborts mid-turn gave different results, "neither a clean interrupt". A stop
// that never lands must be surfaced rather than leave a silently "stopping" turn.
test("abort() warns when the turn is STILL running after the grace period", async () => {
  const { pi, backend, events } = makePi();
  backend.setAgentRunActive(true);          // a turn that ignores the abort
  await pi.abort();
  await new Promise((r) => setTimeout(r, 5100));
  const warned = events.filter((e: Any) =>
    e.type === "custom-message" && /still running/i.test(String(e.data?.content ?? "")));
  assert.equal(warned.length, 1, "a stop that never lands must be surfaced, not left silent");
});

test("abort() stays QUIET when the turn actually ends", async () => {
  const { pi, backend, events } = makePi();
  backend.setAgentRunActive(true);
  await pi.abort();
  backend.setAgentRunActive(false);         // the abort landed
  await new Promise((r) => setTimeout(r, 5100));
  const warned = events.filter((e: Any) =>
    e.type === "custom-message" && /still running/i.test(String(e.data?.content ?? "")));
  assert.equal(warned.length, 0, "a successful abort must not produce a scary message");
});

// ── session naming goes through the seam ────────────────────────────
test("setSessionName delegates to the backend", async () => {
  const { pi, backend } = makePi();
  pi.setSessionName("TS Session");
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(backend.namedAs, "TS Session");
});

// The outdated-SDK notice's text is decided (and pinned verbatim) in version-compare.ts's
// piAiNoticeMessage; this pins that the production vscode call site actually uses it.
test("notifyOutdatedPiAi shows piAiNoticeMessage's text, not an inline copy", () => {
  const src = readFileSync(join(SRC, "pi-service.ts"), "utf-8");
  const body = src.slice(src.indexOf("notifyOutdatedPiAi: (installed, supported, belowFloor) =>"));
  const decl = body.slice(0, body.indexOf("\n      },"));
  assert.match(decl, /piAiNoticeMessage\(installed, supported, belowFloor\)/);
  assert.doesNotMatch(decl, /legacy path/);
});

// ── /tools keeps the session's history (C13) ─────────────────────────
// setActiveTools appends a tools_active_change entry straight to the session file. Pi rebuilds a
// reopened session from its LAST entry, walking parentId back to the root (SessionManager
// _buildIndex sets the leaf to the last entry; getBranch follows parentId — session-manager.js,
// pi-coding-agent 1.5.2). An entry written with parentId:null was therefore a root of its own:
// a session closed right after /tools reopened with no model history at all.
test("setActiveTools chains its entry to the current leaf, so a reopened session keeps its history", () => {
  const { pi, backend } = makePi();
  const dir = mkdtempSync(join(tmpdir(), "pi-tools-"));
  const file = join(dir, "s.jsonl");
  writeFileSync(file, [
    { type: "session", id: "s", timestamp: "t" },
    { type: "message", id: "m1", parentId: null, message: { role: "user", content: "hi" } },
    { type: "message", id: "m2", parentId: "m1", message: { role: "assistant", content: "hello" } },
  ].map((e) => JSON.stringify(e)).join("\n") + "\n");
  let active: string[] = [];
  (backend as Any).session = {
    setActiveToolsByName: (names: string[]) => { active = names; },
    getActiveToolNames: () => active,
  };
  (backend as Any).sessionManager = { getSessionFile: () => file, getLeafId: () => "m2" };

  pi.setActiveTools(["read", "bash"]);

  const entries = readFileSync(file, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
  const tools = entries[entries.length - 1];
  assert.equal(tools.type, "tools_active_change");
  assert.equal(tools.parentId, "m2", "the entry hangs off the leaf it was written after");
  // Reopen the way Pi does: leaf = last entry, then walk parentId to the root.
  const byId = new Map(entries.filter((e) => e.type !== "session").map((e) => [e.id, e]));
  const branch: string[] = [];
  for (let cur = tools; cur; cur = cur.parentId ? byId.get(cur.parentId) : undefined) { branch.unshift(cur.id); }
  assert.deepEqual(branch, ["m1", "m2", tools.id], "the reopened branch still holds the conversation");
});
