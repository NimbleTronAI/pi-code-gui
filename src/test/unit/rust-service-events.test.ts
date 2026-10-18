// Headless tests for RustService's EVENT LOOP and usage accounting — the stateful shell the
// audits flagged as the subsystem's most bug-prone, most-churned code with zero direct coverage
// (rust-service.test.ts stops at initialize(); rust-ingress/agent-events test only the pure
// decision layer). RustService is vscode-free (host + deps injected), so we drive the REAL
// handleEvent / accumulateUsage / applyUsage / getUsage / refreshState here against a fake
// process and a host that applies translateAgentEvent's effects exactly as PiService does.
import { test } from "node:test";
import assert from "node:assert/strict";
import { RustService, type RustHost, type RustDeps, type RustSessionConfig } from "../../rust-service.js";
import type { RustResponse } from "../../rust-process.js";
import type { PiServiceEvent } from "../../types.js";
import { translateAgentEvent, type AgentTranslateState } from "../../agent-events.js";
import { computeUsageStats } from "../../usage-stats.js";

type Any = ReturnType<typeof JSON.parse>;

interface Harness {
  rust: RustService;
  events: PiServiceEvent[];
  emit(event: Any): void;               // drive the REAL RustService.handleEvent
  setActive(v: boolean): void;
  getActive(): boolean;
  setStats(data: Any): void;            // control the get_session_stats reply
  setMessages(list: Any[]): void;       // control the get_messages reply
  setModels(list: Any[]): void;         // control the get_available_models reply
  setModelsFail(v: boolean): void;
  setState(data: Any): void;            // control the get_state reply
  requests: string[];                   // command names the fake process saw
}

const CONFIG: RustSessionConfig = { defaultThinkingLevel: "off", rustExtensionPolicy: "balanced", contextBudget: 0 };

/** Build a RustService wired to a fake process + a host that mirrors PiService's
 *  handleAgentEvent (applies setAgentRunActive/setStreaming and the rust captureContext effect),
 *  so the dedupe latch and context% behave as in production. contextWindow is preset so the
 *  %-context recompute is observable. */
function makeHarness(opts: { contextWindow?: number; config?: Partial<RustSessionConfig> } = {}): Harness {
  const events: PiServiceEvent[] = [];
  const requests: string[] = [];
  // The run flag is owned by the RustService instance now (see PiBackend); drive it through the
  // instance rather than a host callback.
  let stats: Any = { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 };
  let messages: Any[] = [];
  let models: Any[] = [{ provider: "p", id: "m1" }];
  let modelsFail = false;
  let stateData: Any = { model: { id: "deepseek-v4-pro", provider: "deepseek", api: "openai-completions", reasoning: true }, thinkingLevel: "high" };
  const rustRef: { current: RustService | null } = { current: null };

  const host: RustHost = {
    emit: (e) => events.push(e),
    handleAgentEvent: (event: Any) => {
      // Mirror PiService.handleAgentEvent: translate, apply the run flag through the backend
      // instance (which now owns it) + captureContext.
      const rust = rustRef.current as Any;
      const state: AgentTranslateState = {
        backendKind: "rust", agentRunActive: rust.getAgentRunActive(),
        lookups: { entries: [], byMessageId: new Map(), byToolCallId: new Map() },
        userMessages: [], toolCalls: new Map(), now: 0, prepareArgs: (_n, a) => a,
      };
      const r = translateAgentEvent(event, state);
      if (r.setAgentRunActive !== undefined) { rust.setAgentRunActive(r.setAgentRunActive); }
      if (r.setStreaming !== undefined) { rust.setStreaming(r.setStreaming); }
      if (r.effects.captureContext) { rust.captureContext(r.effects.captureUsage); }
      for (const ev of r.events) { events.push(ev); }
    },
    reportStatus: () => {},
    sendInitialMessages: async () => {},
    emitPostInitState: () => {},
    showDialog: () => undefined,
    rememberReasoning: () => {},
    setSessionId: () => {},
    getCycleModels: () => [],
    setCycleModels: () => {},
    setAutoCompactionEnabled: () => {},
    setAutoRetryEnabled: () => {},
  };

  const deps = {
    config: () => ({ ...CONFIG, ...opts.config }),
  } as unknown as RustDeps;

  const fakeProcess = {
    request: async (command: string): Promise<RustResponse> => {
      requests.push(command);
      if (command === "get_session_stats") { return { type: "response", success: true, data: stats } as Any; }
      if (command === "get_state") { return { type: "response", success: true, data: stateData } as Any; }
      if (command === "get_messages") { return { type: "response", success: true, data: { messages } } as Any; }
      if (command === "get_available_models") {
        if (modelsFail) { throw new Error("rpc down"); }
        return { type: "response", success: true, data: { models } } as Any;
      }
      return { type: "response", success: true, data: {} } as Any;
    },
  };

  const rust = new RustService(host, deps);
  rustRef.current = rust;
  (rust as Any).process = fakeProcess;
  (rust as Any).contextWindow = opts.contextWindow ?? 0;

  return {
    rust, events, requests,
    emit: (event) => (rust as Any).handleEvent(event),
    setActive: (v) => { (rust as Any).setAgentRunActive(v); },
    getActive: () => (rust as Any).getAgentRunActive(),
    setStats: (data) => { stats = data; },
    setMessages: (list) => { messages = list; },
    setState: (data) => { stateData = data; },
    setModels: (list: Any[]) => { models = list; },
    setModelsFail: (v: boolean) => { modelsFail = v; },
  };
}

const flush = () => new Promise((r) => setTimeout(r, 0));
const assistantMsgEnd = (u: Any) => ({ type: "message_end", message: { role: "assistant", usage: u } });
const statsCalls = (h: Harness) => h.requests.filter((r) => r === "get_session_stats").length;

// ── Item 1: usage arithmetic (direct) ────────────────────────────────
test("accumulateUsage climbs additively from the current base", () => {
  const h = makeHarness();
  (h.rust as Any).accumulateUsage({ input: 100, output: 20, cacheRead: 5, cacheWrite: 1 });
  (h.rust as Any).accumulateUsage({ input: 50, output: 10, cacheRead: 0, cacheWrite: 0 });
  const u = h.rust.getUsage();
  assert.deepEqual([u.input, u.output, u.cacheRead, u.cacheWrite], [150, 30, 5, 1]);
});

test("applyUsage REPLACES this.usage wholesale (authoritative snap, not additive)", () => {
  const h = makeHarness();
  (h.rust as Any).accumulateUsage({ input: 999, output: 999, cacheRead: 9, cacheWrite: 9 });
  (h.rust as Any).applyUsage({ tokens: { input: 10, output: 2, cacheRead: 1, cacheWrite: 0 }, cost: 5 });
  const u = h.rust.getUsage();
  assert.deepEqual([u.input, u.output, u.cacheRead, u.cacheWrite], [10, 2, 1, 0]);
});

test("getUsage recomputes contextPercent live from lastContextTokens / contextWindow", () => {
  const h = makeHarness({ contextWindow: 100_000 });
  (h.rust as Any).captureContext({ input: 20_000, cacheRead: 5_000 }); // ctx = 25000 → 25%
  assert.equal(h.rust.getUsage().contextPercent, 25);
});

test("captureContext updates lastContextTokens only when the turn's context tokens are > 0", () => {
  const h = makeHarness({ contextWindow: 100_000 });
  (h.rust as Any).captureContext({ input: 10_000, cacheRead: 0 });
  assert.equal(h.rust.getUsage().contextPercent, 10);
  (h.rust as Any).captureContext({ input: 0, cacheRead: 0 }); // ctx=0 → leave the prior fill
  assert.equal(h.rust.getUsage().contextPercent, 10);
});

// ── Item 1: full handleEvent trajectory ──────────────────────────────
test("full turn: live cost climbs per message_end, terminal snaps authoritative, dup agent_end doesn't double-refresh, agent_settled is latch-proof", async () => {
  const h = makeHarness({ contextWindow: 100_000 });

  h.emit({ type: "agent_start" });
  assert.equal(h.getActive(), true, "agent_start latched the run active");

  h.emit(assistantMsgEnd({ input: 100, output: 20, cacheRead: 0, cacheWrite: 0 }));
  assert.equal(h.rust.getUsage().input, 100);
  h.emit(assistantMsgEnd({ input: 50, output: 10, cacheRead: 0, cacheWrite: 0 }));
  h.emit(assistantMsgEnd({ input: 30, output: 5, cacheRead: 0, cacheWrite: 0 }));
  assert.equal(h.rust.getUsage().input, 180, "live accumulate climbs across each message_end");

  // Terminal agent_end: get_session_stats carries the authoritative cumulative.
  h.setStats({ tokens: { input: 500, output: 120, cacheRead: 10, cacheWrite: 2 }, cost: 0 });
  h.emit({ type: "agent_end", messages: [] });
  await flush();
  assert.equal(h.getActive(), false, "agent_end un-latched active");
  assert.equal(h.rust.getUsage().input, 500, "terminal snapped to the authoritative total");
  const afterFirstEnd = statsCalls(h);
  assert.equal(afterFirstEnd, 1, "one authoritative refresh at the real agent_end");

  // Duplicate agent_end (rust error-path double-emit) → deduped, no second refresh.
  h.emit({ type: "agent_end", messages: [] });
  await flush();
  assert.equal(statsCalls(h), afterFirstEnd, "duplicate agent_end did not double-refresh");

  // agent_settled terminal → authoritative refresh EVEN THOUGH active is already false (the
  // latch-proof path: a duplicate agent_end that starved isRealAgentEnd can't starve this).
  h.setStats({ tokens: { input: 600, output: 150, cacheRead: 10, cacheWrite: 2 }, cost: 0 });
  h.emit({ type: "agent_settled" });
  await flush();
  assert.equal(statsCalls(h), afterFirstEnd + 1, "agent_settled took its own authoritative snap");
  assert.equal(h.rust.getUsage().input, 600, "final total landed via agent_settled");
});

// ── Item 6: compact() mid-turn wipe guard ────────────────────────────
test("refreshUsage is skipped while a turn is active — /compact mid-turn can't wipe live usage", async () => {
  const h = makeHarness();
  (h.rust as Any).accumulateUsage({ input: 500, output: 100, cacheRead: 0, cacheWrite: 0 });
  assert.equal(h.rust.getUsage().input, 500);

  // get_session_stats would report the pending (~0) total mid-turn — applying it would wipe.
  h.setStats({ tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 });
  h.setActive(true);
  await (h.rust as Any).refreshUsage();
  assert.equal(h.rust.getUsage().input, 500, "live accumulate preserved while the turn is active");
  assert.equal(h.requests.includes("get_session_stats"), false, "no stats RPC issued mid-turn");

  // Idle → the authoritative snap applies.
  h.setActive(false);
  h.setStats({ tokens: { input: 900, output: 200, cacheRead: 0, cacheWrite: 0 }, cost: 0 });
  await (h.rust as Any).refreshUsage();
  assert.equal(h.rust.getUsage().input, 900, "authoritative snap applied when idle");
});

// ── Item 3: non-blocking setThinkingLevel ────────────────────────────
test("setThinkingLevel returns the optimistic level, then reconciles via a fire-and-forget get_state", async () => {
  const h = makeHarness();
  h.setState({ model: { id: "deepseek-v4-pro", provider: "deepseek" }, thinkingLevel: "high" });
  const returned = await h.rust.setThinkingLevel("high");
  assert.equal(returned, "high", "returns without waiting on the clamp re-read");
  await flush();
  assert.equal(h.requests.includes("get_state"), true, "reconcile issued get_state fire-and-forget");
});

test("setThinkingLevel: a model clamp reconciles async + emits a chat info notice", async () => {
  const h = makeHarness();
  // Non-reasoning model: the binary forces the level to "off" on the re-read.
  h.setState({ model: { id: "gpt-4o", provider: "openai" }, thinkingLevel: "off" });
  const returned = await h.rust.setThinkingLevel("high");
  assert.equal(returned, "high", "optimistic first");
  await flush();
  assert.equal(h.rust.getThinkingLevel(), "off", "clamp reconciled from get_state");
  const notice = h.events.find((e) => e.type === "custom-message" && String((e as Any).data.content).includes("doesn't support thinking levels"));
  assert.ok(notice, "async clamp notice emitted");
  assert.ok(String((notice as Any).data.content).includes('staying at "off"'));
});

test("setThinkingLevel: no clamp → no notice", async () => {
  const h = makeHarness();
  h.setState({ model: { id: "deepseek-v4-pro", provider: "deepseek" }, thinkingLevel: "high" });
  await h.rust.setThinkingLevel("high");
  await flush();
  assert.equal(h.rust.getThinkingLevel(), "high");
  assert.ok(!h.events.some((e) => e.type === "custom-message" && String((e as Any).data.content).includes("doesn't support thinking levels")), "no clamp notice when the level holds");
});

// ── Item 2: usage-drift probe ────────────────────────────────────────
test("refreshUsage warns and does NOT wipe usage when the stats reply drifts (silent $0.00 guard)", async () => {
  const h = makeHarness();
  (h.rust as Any).accumulateUsage({ input: 500, output: 100, cacheRead: 0, cacheWrite: 0 });
  h.setActive(false);
  h.setStats({ cost: 0, sessionId: "x" }); // success reply but NO tokens block → drift
  await (h.rust as Any).refreshUsage();
  assert.equal(h.rust.getUsage().input, 500, "drifted reply must not replace the accumulated usage");
  assert.ok(h.events.some((e) => e.type === "custom-message" && String((e as Any).data.content).includes("usage wire-shape may have drifted")), "authoritative drift warned");
});

test("a message_end with drifted usage warns once (live path) and doesn't accumulate", () => {
  const h = makeHarness();
  h.emit({ type: "agent_start" });
  h.emit({ type: "message_end", message: { role: "assistant", usage: { promptTokens: 10, completionTokens: 2 } } }); // renamed fields
  assert.equal(h.rust.getUsage().input, 0, "drifted usage not accumulated");
  const stuck = (e: PiServiceEvent) => e.type === "custom-message" && String((e as Any).data.content).includes("live cost estimate may be stuck");
  assert.equal(h.events.filter(stuck).length, 1, "warned once");
  h.emit({ type: "message_end", message: { role: "assistant", usage: { promptTokens: 5 } } });
  assert.equal(h.events.filter(stuck).length, 1, "one-shot — no repeat warning");
});

// ── getAvailableModels refresh (audit H8) ────────────────────────────
test("getAvailableModels re-queries the binary, so a mid-session key add isn't stale", async () => {
  const h = makeHarness();
  assert.deepEqual((await h.rust.getAvailableModels()).map((m) => m.id), ["m1"]);
  // A provider key added mid-session → the binary now reports another model.
  h.setModels([{ provider: "p", id: "m1" }, { provider: "p", id: "m2" }]);
  (h.rust as Any)._modelsFetchedAt = 0; // expire the TTL
  assert.deepEqual((await h.rust.getAvailableModels()).map((m) => m.id), ["m1", "m2"], "picker sees the new model");
});

test("getAvailableModels serves the cache inside the TTL (no RPC storm)", async () => {
  const h = makeHarness();
  await h.rust.getAvailableModels();
  const n = h.requests.filter((c) => c === "get_available_models").length;
  await h.rust.getAvailableModels();
  await h.rust.getAvailableModels();
  assert.equal(h.requests.filter((c) => c === "get_available_models").length, n, "no extra round-trips");
});

test("getAvailableModels falls back to the cached list when the refresh fails", async () => {
  const h = makeHarness();
  assert.deepEqual((await h.rust.getAvailableModels()).map((m) => m.id), ["m1"]);
  h.setModelsFail(true);
  (h.rust as Any)._modelsFetchedAt = 0;
  assert.deepEqual((await h.rust.getAvailableModels()).map((m) => m.id), ["m1"], "keeps the last good list");
});

// ── a crashed subprocess must not leave an interactive-looking zombie ────
// handleExit surfaced the crash but left the dead RustProcess in place, so `initialized` stayed
// true, the webview kept accepting input, and every later prompt died silently inside
// RustProcess.writeLine at the `stdin.writable` check with only a debug line. The user typed
// into a session that no longer existed and saw nothing happen at all.
test("after an unexpected exit, sendPrompt FAILS LOUDLY instead of dropping the text", async () => {
  const h = makeHarness();
  (h.rust as Any).initializing = false;
  (h.rust as Any).handleExit(1);

  assert.equal((h.rust as Any).process, null, "the dead process must be dropped, not retained");
  await assert.rejects(
    () => h.rust.sendPrompt("this must not vanish"),
    /no longer running|exited with code/i,
    "a prompt after a crash must raise an error the user can see",
  );
});

test("the crash message names the exit code rather than saying 'not initialized'", async () => {
  const h = makeHarness();
  (h.rust as Any).initializing = false;
  (h.rust as Any).handleExit(9);
  await assert.rejects(() => h.rust.sendPrompt("x"), /code 9/,
    "'not initialized' is misleading for a session that WAS running and then died");
});

// ── ask_request (rust-pi 0.3.0) ──────────────────────────────────────
// The `ask` tool joined 0.3.0's default tool set and BLOCKS the turn until answered. The wire
// contract below was established by probing the real 0.3.0 binary — its source is behind the
// clean-room wall — and is enforced by the binary itself: `answers` must be a sequence of
// AskAnswer structs carrying `questionId` and a `selected` list, or `dismissed: true`.
function makeAskHarness(dialogAnswer: unknown) {
  const sent: Array<{ command: string; payload: Any }> = [];
  const host = {
    emit: () => {}, handleAgentEvent: () => {}, reportStatus: () => {},
    sendInitialMessages: async () => {}, emitPostInitState: () => {},
    showDialog: () => (dialogAnswer === undefined ? undefined : Promise.resolve(dialogAnswer)),
    rememberReasoning: () => {}, setSessionId: () => {},
    getCycleModels: () => [], setCycleModels: () => {},
    setAutoCompactionEnabled: () => {}, setAutoRetryEnabled: () => {},
  } as unknown as RustHost;
  const deps = { config: () => CONFIG } as unknown as RustDeps;
  const rust = new RustService(host, deps);
  (rust as Any).process = { send: (command: string, payload: Any) => sent.push({ command, payload }), request: async () => ({ type: "response", success: true, data: {} }), dispose: () => {} };
  return { rust, sent };
}

const ASK_EVENT: Any = {
  type: "ask_request", id: "req-1", timeoutMs: 300000,
  questions: [{ id: "pref", header: "A or B?", question: "Which option?", multi: false,
                options: [{ label: "Option A", description: "first" }, { label: "Option B", description: "second" }] }],
};

test("ask_request: a chosen option answers on the wire in the binary's AskAnswer shape", async () => {
  const { rust, sent } = makeAskHarness("Option B");
  (rust as Any).handleEvent(ASK_EVENT);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].command, "ask_response");
  assert.deepEqual(sent[0].payload, { id: "req-1", answers: [{ questionId: "pref", selected: ["Option B"] }] });
  rust.dispose();
});

test("ask_request: a question with no id is answered by its position, not by an empty id", async () => {
  // `id` is optional in the ask tool's arguments, and the model often leaves it out. Probed on
  // rust-pi 0.5.1 and 0.8.0: the binary then matches an answer whose questionId is the question's
  // zero-based index as a string ("0", "1", …). An empty questionId matches nothing, and the
  // binary reports the question as "(unanswered)" to the model — the user's choice silently lost.
  const { rust, sent } = makeAskHarness("Option A");
  const q = (question: string): Any => ({ question, multi: false, options: [{ label: "Option A" }, { label: "Option B" }] });
  (rust as Any).handleEvent({ type: "ask_request", id: "req-3", questions: [q("First?"), { ...q("Second?"), id: "named" }, q("Third?")] });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sent[0].payload, { id: "req-3", answers: [
    { questionId: "0", selected: ["Option A"] },
    { questionId: "named", selected: ["Option A"] },
    { questionId: "2", selected: ["Option A"] },
  ] });
  rust.dispose();
});

test("ask_request: cancelling sends dismissed — omitting it would leave the turn blocked", async () => {
  // `{id}` alone is rejected by the binary ("Missing answers field (or dismissed: true)"), so a
  // cancelled card MUST say so explicitly; staying silent is the stall this whole path fixes.
  const { rust, sent } = makeAskHarness(undefined);
  (rust as Any).handleEvent(ASK_EVENT);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].command, "ask_response");
  assert.deepEqual(sent[0].payload, { id: "req-1", dismissed: true });
  rust.dispose();
});

test("ask_request: a card with no questions is dismissed rather than left hanging", async () => {
  const { rust, sent } = makeAskHarness("x");
  (rust as Any).handleEvent({ type: "ask_request", id: "req-2", questions: [] });
  await new Promise((r) => setTimeout(r, 0));
  assert.deepEqual(sent[0].payload, { id: "req-2", dismissed: true });
  rust.dispose();
});

// ── load-failure severity matches what was asked for ────────────────
// rust-pi still attempts .pi/settings.json packages when --no-extensions is passed, so the
// failure arrives either way. A red "Error" card for a thing the user deliberately turned off
// is noise they cannot act on — but the package really did not load, so the card stays.
function captureLoadNotice(extraArgs: string[]) {
  const events: Any[] = [];
  const host = {
    emit: (e: Any) => events.push(e), handleAgentEvent: () => {}, reportStatus: () => {},
    sendInitialMessages: async () => {}, emitPostInitState: () => {}, showDialog: () => undefined,
    rememberReasoning: () => {}, setSessionId: () => {}, getCycleModels: () => [],
    setCycleModels: () => {}, setAutoCompactionEnabled: () => {}, setAutoRetryEnabled: () => {},
  } as unknown as RustHost;
  const rust = new RustService(host, { config: () => CONFIG } as unknown as RustDeps);
  let fired: ((e: Any) => void) | undefined;
  (rust as Any).deps.createProcess = (opts: Any) => { fired = opts.onLoadError; return {
    spawn: async () => {}, dispose: () => {}, isAlive: () => true,
    request: async () => ({ type: "response", success: true, data: {} }), send: () => {},
  }; };
  void (rust as Any).spawn("/bin/true", ["--mode", "rpc", ...extraArgs], "/tmp", {});
  fired?.({ kind: "digest-mismatch", packageName: "pi-web-access",
            detail: "Package contents changed since they were last trusted.",
            remediation: "Run `pi update npm:pi-web-access`, or reinstall it, to re-trust the new version." });
  return events.map((e) => e.data).filter((d: Any) => d && d.customType);
}

test("a load failure is an Error when extensions were meant to load", async () => {
  const [card] = captureLoadNotice([]);
  assert.equal(card.customType, "error");
  assert.match(String(card.content), /pi-web-access/);
});

test("with --no-extensions it is softened to a note, but still shown", async () => {
  const [card] = captureLoadNotice(["--no-extensions"]);
  assert.equal(card.customType, "notice", "not an error — the user turned extensions off");
  assert.match(String(card.content), /expected here/);
  assert.match(String(card.content), /pi-web-access/, "still names the package");
  assert.ok(!String(card.content).startsWith("\u26a0"), "no warning glyph");
});

// ── Unit 7 phase C: cost from the binary (D4/R4) and the real context window ──
// PROVEN against rust-pi 0.8.0 on a local mock (design v1 D4): message_end carries
// message.usage.cost = {input, output, cacheRead, cacheWrite, total}, and get_session_stats
// carries data.cost = the sum of the STORED per-turn costs.
const turnEnd = (tokens: Any, total: number) => assistantMsgEnd({ ...tokens, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } });
const RATES = { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 };

test("accumulateUsage sums message_end usage.cost.total", () => {
  const h = makeHarness();
  h.emit({ type: "agent_start" });
  h.emit(turnEnd({ input: 100, output: 20, cacheRead: 0, cacheWrite: 0 }, 1.5));
  h.emit(turnEnd({ input: 50, output: 10, cacheRead: 0, cacheWrite: 0 }, 2.25));
  assert.equal(h.rust.getUsage().cost, 3.75, "the live cost climbs from the binary's own per-turn figure");
  // A binary that reports cost as a bare number, or not at all, still accumulates tokens.
  h.emit(assistantMsgEnd({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0, cost: 0.25 }));
  h.emit(assistantMsgEnd({ input: 1, output: 1, cacheRead: 0, cacheWrite: 0 }));
  assert.equal(h.rust.getUsage().cost, 4);
  assert.equal(h.rust.getUsage().input, 152);
});

// R4 (review of record B1): the legacy offset comes from get_messages' per-turn STORED costs —
// an assistant turn with tokens stored at 0 is one an older binary wrote. initializeInner hands
// the reply to takeStoredTurns; here we hand it over directly.
const CUR = { provider: "deepseek", id: "deepseek-v4-pro" };
const storedTurn = (input: number, total: number, model = CUR) => ({
  role: "assistant", provider: model.provider, model: model.id,
  usage: { input, output: 0, cacheRead: 0, cacheWrite: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total } },
});
function resumed(h: Harness, messages: Any[]): void {
  (h.rust as Any).resetSessionUsage();   // as initializeInner does before it reads the history
  (h.rust as Any)._model = { ...CUR };
  (h.rust as Any).takeStoredTurns({ messages });
  h.setMessages(messages);                 // what get_messages lists from here on
}

test("a resumed zero-cost session keeps its earlier turns' cost after the next turn", async () => {
  // R4 (PROVEN, design review §1.5): a session written by a pre-0.8.0 binary stores every turn at
  // cost 0, and 0.8.0 resumes it reporting cost 0 with its tokens intact. The binary's next turn is
  // priced (here at 4, deliberately not tokens x RATES, so re-pricing everything cannot pass).
  const h = makeHarness();
  resumed(h, [{ role: "user", content: [] }, storedTurn(4_000_000, 0)]);
  h.setStats({ tokens: { input: 4_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 });
  await (h.rust as Any).refreshUsage();                     // the resume snapshot
  const before = computeUsageStats(h.rust.getUsage(), RATES, "rust");
  assert.equal(before.cost, 12, "old turns priced from their tokens before any new turn");

  h.emit({ type: "agent_start" });
  h.emit(turnEnd({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, 4));
  assert.equal(computeUsageStats(h.rust.getUsage(), RATES, "rust").cost, 16, "live: binary turn + legacy offset");

  h.setStats({ tokens: { input: 5_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 4 });
  h.setMessages([{ role: "user", content: [] }, storedTurn(4_000_000, 0), storedTurn(1_000_000, 4)]);
  h.emit({ type: "agent_end", messages: [] });
  await flush();
  const after = computeUsageStats(h.rust.getUsage(), RATES, "rust");
  assert.equal(after.cost, 16, "after the snap: the binary's 4 + the old turns' 12");
  assert.equal(after.costKnown, true);
});

test("a session whose history holds only priced turns, or none, adds no legacy offset", async () => {
  for (const [label, messages, first] of [
    ["resumed 0.8.0 session", [storedTurn(1_000_000, 5)], { tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 5 }],
    ["fresh session", [], { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 }],
    // Stats alone say "tokens at cost 0", but no stored turn is at 0: nothing is guessed from them.
    ["no zero-cost turn in the history", [storedTurn(1_000_000, 5)], { tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 }],
  ] as Array<[string, Any[], Any]>) {
    const h = makeHarness();
    resumed(h, messages);
    h.setStats(first);
    await (h.rust as Any).refreshUsage();
    assert.equal(h.rust.getUsage().uncosted, undefined, label);
    // The next turn's snapshot is the stored turns' own figure, with nothing added.
    h.setMessages([...messages, storedTurn(1_000_000, 4)]);
    h.setStats({ tokens: { input: first.tokens.input + 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: first.cost + 4 });
    h.emit({ type: "agent_start" });
    h.emit(turnEnd({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, 4));
    h.emit({ type: "agent_end", messages: [] });
    await flush(); await flush();
    const s = computeUsageStats(h.rust.getUsage(), RATES, "rust");
    assert.deepEqual([s.cost, s.costKnown], [messages.length ? 9 : 4, true], label);
  }
});

test("legacy turns on another model than the current one are flagged, so their cost is not guessed", () => {
  const h = makeHarness();
  resumed(h, [storedTurn(1_000_000, 0, { provider: "other", id: "m-x" }), storedTurn(1_000_000, 0)]);
  assert.equal(h.rust.getUsage().uncostedOtherModel, true, "one old turn ran on another model");
  resumed(h, [storedTurn(1_000_000, 0), storedTurn(1_000_000, 3)]);
  assert.equal(h.rust.getUsage().uncostedOtherModel, undefined, "all old turns on the current model");
  resumed(h, [storedTurn(0, 0, { provider: "other", id: "m-x" }), storedTurn(1_000_000, 0)]);
  assert.equal(h.rust.getUsage().uncostedOtherModel, undefined, "a turn with no tokens is not an old turn");
  // The flag follows the CURRENT model: a later switch makes the same old turns foreign.
  (h.rust as Any)._model = { provider: "other", id: "m-x" };
  assert.equal(h.rust.getUsage().uncostedOtherModel, true, "after a model switch");
  (h.rust as Any)._model = null;
  assert.equal(h.rust.getUsage().uncostedOtherModel, true, "no resolved model: nothing to match");
  // A turn stored without provider/model cannot be matched either.
  resumed(h, [{ role: "assistant", usage: { input: 5, output: 0, cacheRead: 0, cacheWrite: 0 } }]);
  assert.equal(h.rust.getUsage().uncostedOtherModel, true, "unknown model");
});

test("a turn the binary stores at cost 0 counts as an old turn live, exactly as it will after a reopen", async () => {
  // Reload stability: get_messages on the next open will list this turn at cost 0, so the live
  // total must already treat it the same way — not drop it now and price it after a reload.
  const h = makeHarness();
  resumed(h, []);
  const live = (provider: string, id: string, input: number, total: number) => ({ type: "message_end",
    message: { ...storedTurn(input, total, { provider, id }) } });
  h.emit({ type: "agent_start" });
  h.emit(live(CUR.provider, CUR.id, 1_000_000, 4));
  h.emit(live(CUR.provider, CUR.id, 1_000_000, 0));
  assert.equal(computeUsageStats(h.rust.getUsage(), RATES, "rust").cost, 7, "the binary's 4 + the zero-cost turn's 3");
  const reopened = makeHarness();
  resumed(reopened, [storedTurn(1_000_000, 4), storedTurn(1_000_000, 0)]);
  reopened.setStats({ tokens: { input: 2_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 4 });
  await (reopened.rust as Any).refreshUsage();
  assert.equal(computeUsageStats(reopened.rust.getUsage(), RATES, "rust").cost, 7, "the same total after a reopen");
  // A zero-cost turn on another model: unknown live, as it is after a reopen.
  h.emit(live("other", "m-x", 1_000_000, 0));
  assert.equal(computeUsageStats(h.rust.getUsage(), RATES, "rust").costKnown, false);
});

test("a re-init (/new) clears the legacy offset", async () => {
  const h = makeHarness();
  resumed(h, [storedTurn(4_000_000, 0)]);
  h.setStats({ tokens: { input: 4_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 });
  await (h.rust as Any).refreshUsage();
  assert.equal(computeUsageStats(h.rust.getUsage(), RATES, "rust").cost, 12);
  (h.rust as Any).resetSessionUsage();
  // Before the new session's first snapshot (e.g. its init snapshot failed), a live turn must not
  // inherit the previous session's offset.
  h.emit({ type: "agent_start" });
  h.emit(turnEnd({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, 2));
  assert.equal(computeUsageStats(h.rust.getUsage(), RATES, "rust").cost, 2, "live, before any snapshot");
  h.setStats({ tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 2 });
  h.emit({ type: "agent_end", messages: [] });
  await flush();
  assert.equal(computeUsageStats(h.rust.getUsage(), RATES, "rust").cost, 2, "after the snapshot");
});

test("the Rust context window shown is the model's real window whatever contextBudget is", () => {
  // Design S (C27 give-up 2): pi-code-gui.contextBudget is TypeScript-only. rust-pi compacts
  // against the model's own window, so the % shown must use that window too.
  for (const contextBudget of [0, 50_000, 500_000]) {
    const h = makeHarness({ config: { contextBudget } });
    h.rust.applyState({ model: { id: "m", provider: "p", contextWindow: 200_000 }, thinkingLevel: "off" });
    (h.rust as Any).captureContext({ input: 100_000, cacheRead: 0 });
    const u = h.rust.getUsage();
    assert.equal(u.contextWindow, 200_000, `budget ${contextBudget}`);
    assert.equal(u.contextPercent, 50, `budget ${contextBudget}`);
  }
});

// ── Review Cc (unit7-Cb-review.md SF1): cost and tokens from the per-turn record, not the kept context ──
// PROVEN on rust-pi 0.8.0 (a real auto-compaction under a local mock): after a compaction
// get_session_stats counts only the kept context, while get_messages lists every turn with its
// stored cost; the summary calls are billed but reported nowhere.

test("after a turn the cost and tokens are every stored turn's, even when the stats count only the kept context", async () => {
  const h = makeHarness();
  (h.rust as Any)._model = { ...CUR };
  resumed(h, [storedTurn(1_000_000, 1), storedTurn(1_000_000, 2)]);
  h.setStats({ tokens: { input: 2_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 3 });
  await (h.rust as Any).refreshUsage();
  assert.equal(h.rust.getUsage().cost, 3);
  h.emit({ type: "agent_start" });
  h.emit(turnEnd({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, 4));
  assert.equal(h.rust.getUsage().cost, 7, "live");
  // The binary compacted the first turn away: its stats drop to the kept 2 + 4.
  h.setMessages([storedTurn(1_000_000, 1), storedTurn(1_000_000, 2), storedTurn(1_000_000, 4)]);
  h.setStats({ tokens: { input: 2_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 6 });
  h.emit({ type: "agent_end", messages: [] });
  await flush(); await flush();
  const u = h.rust.getUsage();
  assert.deepEqual([u.cost, u.input], [7, 3_000_000], "the stored turns' 1+2+4 and 3M tokens, not the kept 6 and 2M");
  // A live message the binary does not keep is not counted once the turn ends — the figure a
  // reopen will show (get_messages is the record).
  h.emit({ type: "agent_start" });
  h.emit(turnEnd({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, 5));
  assert.equal(h.rust.getUsage().cost, 12, "live");
  h.emit({ type: "agent_end", messages: [] });
  await flush(); await flush();
  assert.equal(h.rust.getUsage().cost, 7, "after the turn: the stored record");
});

test("a compaction makes the cost unknown at once, and stays unknown", async () => {
  // Its summary calls are billed but appear in no reply, so every later figure would under-count.
  for (const type of ["auto_compaction_start", "compaction_start"]) {
    const h = makeHarness();
    (h.rust as Any)._model = { ...CUR };
    resumed(h, [storedTurn(1_000_000, 1)]);
    h.setStats({ tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 1 });
    await (h.rust as Any).refreshUsage();
    assert.equal(computeUsageStats(h.rust.getUsage(), RATES, "rust").costKnown, true, type);
    h.emit({ type, reason: "threshold" });
    const s = computeUsageStats(h.rust.getUsage(), RATES, "rust");
    assert.equal(s.costKnown, false, `${type}: shown ${s.cost}`);
    assert.match(String(s.costNote), /compacted/);
    await (h.rust as Any).refreshUsage();
    assert.equal(computeUsageStats(h.rust.getUsage(), RATES, "rust").costKnown, false, `${type}: still unknown after a refresh`);
    (h.rust as Any).resetSessionUsage();
    assert.equal(h.rust.getUsage().costUnknown, undefined, `${type}: a new session starts clean`);
  }
});

test("a manual /compact that succeeds makes the cost unknown", async () => {
  const h = makeHarness();
  (h.rust as Any)._model = { ...CUR };
  resumed(h, [storedTurn(1_000_000, 1)]);
  await h.rust.compact();
  assert.equal(computeUsageStats(h.rust.getUsage(), RATES, "rust").costKnown, false);
});

test("stats above the per-turn sum make the cost unknown (the per-turn figures drifted)", async () => {
  // Review Cc N2: the stats count a subset of the same stored turns, so they can never exceed them.
  const h = makeHarness();
  (h.rust as Any)._model = { ...CUR };
  resumed(h, [storedTurn(1_000_000, 0)]);
  h.setStats({ tokens: { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 4 });
  await (h.rust as Any).refreshUsage();
  assert.equal(computeUsageStats(h.rust.getUsage(), RATES, "rust").costKnown, false);
});

test("a history read that races a new turn does not drop that turn's live cost", async () => {
  // refreshEntries runs after the status snap, outside the refresh guard, so the next turn can
  // stream while its get_messages is in flight; a reply taken before that turn must not replace it.
  const h = makeHarness();
  (h.rust as Any)._model = { ...CUR };
  resumed(h, [storedTurn(1_000_000, 1)]);
  const proc = (h.rust as Any).process;
  const inner = proc.request;
  proc.request = async (command: string): Promise<RustResponse> => {
    const r = await inner(command);
    if (command === "get_messages") { h.emit(turnEnd({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, 2)); }
    return r;                                // the reply lists only the first turn
  };
  await (h.rust as Any).refreshEntries();
  assert.equal(h.rust.getUsage().cost, 3, "the stored 1 + the racing turn's 2");
});
