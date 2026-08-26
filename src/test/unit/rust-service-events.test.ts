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

type Any = ReturnType<typeof JSON.parse>;

interface Harness {
  rust: RustService;
  events: PiServiceEvent[];
  emit(event: Any): void;               // drive the REAL RustService.handleEvent
  setActive(v: boolean): void;
  getActive(): boolean;
  setStats(data: Any): void;            // control the get_session_stats reply
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
function makeHarness(opts: { contextWindow?: number } = {}): Harness {
  const events: PiServiceEvent[] = [];
  const requests: string[] = [];
  // The run flag is owned by the RustService instance now (see PiBackend); drive it through the
  // instance rather than a host callback.
  let stats: Any = { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 };
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
    config: () => CONFIG,
  } as unknown as RustDeps;

  const fakeProcess = {
    request: async (command: string): Promise<RustResponse> => {
      requests.push(command);
      if (command === "get_session_stats") { return { type: "response", success: true, data: stats } as Any; }
      if (command === "get_state") { return { type: "response", success: true, data: stateData } as Any; }
      if (command === "get_messages") { return { type: "response", success: true, data: { messages: [] } } as Any; }
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
