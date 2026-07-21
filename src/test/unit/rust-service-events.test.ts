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
