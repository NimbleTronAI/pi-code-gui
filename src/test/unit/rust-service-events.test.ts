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
  let agentRunActive = false;
  let stats: Any = { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, cost: 0 };
  let stateData: Any = { model: { id: "deepseek-v4-pro", provider: "deepseek", api: "openai-completions", reasoning: true }, thinkingLevel: "high" };
  const rustRef: { current: RustService | null } = { current: null };

  const host: RustHost = {
    emit: (e) => events.push(e),
    handleAgentEvent: (event: Any) => {
      // Mirror PiService.handleAgentEvent: translate, apply the run/stream flags + captureContext.
      const state: AgentTranslateState = {
        backendKind: "rust", agentRunActive,
        lookups: { entries: [], byMessageId: new Map(), byToolCallId: new Map() },
        userMessages: [], toolCalls: new Map(), now: 0, prepareArgs: (_n, a) => a,
      };
      const r = translateAgentEvent(event, state);
      if (r.setAgentRunActive !== undefined) { agentRunActive = r.setAgentRunActive; }
      if (r.effects.captureContext) { (rustRef.current as Any).captureContext(r.effects.captureUsage); }
      for (const ev of r.events) { events.push(ev); }
    },
    reportStatus: () => {},
    sendInitialMessages: async () => {},
    emitPostInitState: () => {},
    showDialog: () => undefined,
    getAgentRunActive: () => agentRunActive,
    setAgentRunActive: (v) => { agentRunActive = v; },
    setStreaming: () => {},
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
    setActive: (v) => { agentRunActive = v; },
    getActive: () => agentRunActive,
    setStats: (data) => { stats = data; },
    setState: (data) => { stateData = data; },
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
