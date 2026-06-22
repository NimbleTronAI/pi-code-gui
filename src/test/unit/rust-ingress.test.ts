// Headless tests for the Rust event-ingress seam: the pure routing/dedupe/queue
// decisions (routeRustEvent, extractMessageText) plus an end-to-end pass of a
// realistic turn through a real subprocess speaking the RPC protocol. This is the
// safety net that gates extracting RustService — it locks down the Rust-only
// dispatch behaviour (synthetic-queue clearing, ui-request/error short-circuits,
// sessionId capture, double-agent_end dedupe) without the binary or vscode.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RustProcess, type RustEvent } from "../../rust-process.js";
import { normalizeRustEvent, routeRustEvent, extractMessageText, dropQueuedMessage } from "../../rust-events.js";

// ── extractMessageText (pure) ─────────────────────────────────────────
test("extractMessageText: bare string passes through", () => {
  assert.equal(extractMessageText("hello"), "hello");
});

test("extractMessageText: null/undefined/number/object -> ''", () => {
  assert.equal(extractMessageText(null), "");
  assert.equal(extractMessageText(undefined), "");
  assert.equal(extractMessageText(42), "");
  assert.equal(extractMessageText({ text: "x" }), "");
});

test("extractMessageText: joins only text blocks with newlines", () => {
  const content = [{ type: "text", text: "a" }, { type: "toolCall", name: "read" }, { type: "text", text: "b" }];
  assert.equal(extractMessageText(content), "a\nb");
});

test("extractMessageText: tolerates a null array entry (no throw)", () => {
  const content = [null, { type: "text", text: "ok" }];
  assert.equal(extractMessageText(content), "ok");
});

// ── routeRustEvent (pure) ─────────────────────────────────────────────
const route = (e: RustEvent, queueNonEmpty = false, active = false) => routeRustEvent(e, queueNonEmpty, active);

test("routeRustEvent: user message_start with a non-empty queue yields the drop candidate", () => {
  const e: RustEvent = { type: "message_start", message: { role: "user", content: [{ type: "text", text: "steer me" }] } };
  const r = route(e, true);
  assert.equal(r.dropQueuedText, "steer me");
  assert.equal(r.action, "delegate");
});

test("routeRustEvent: user message_start with an EMPTY queue does not attempt a drop", () => {
  const e: RustEvent = { type: "message_start", message: { role: "user", content: "hi" } };
  assert.equal(route(e, false).dropQueuedText, null);
});

test("routeRustEvent: assistant message_start never drops from the queue", () => {
  const e: RustEvent = { type: "message_start", message: { role: "assistant", content: "x" } };
  assert.equal(route(e, true).dropQueuedText, null);
});

test("routeRustEvent: extension_ui_request short-circuits to ui-request", () => {
  assert.equal(route({ type: "extension_ui_request", method: "confirm" }).action, "ui-request");
});

test("routeRustEvent: extension_error short-circuits to extension-error", () => {
  assert.equal(route({ type: "extension_error", error: "boom" }).action, "extension-error");
});

test("routeRustEvent: agent_start captures a string sessionId and still delegates", () => {
  const r = route({ type: "agent_start", sessionId: "sess-1" });
  assert.equal(r.captureSessionId, "sess-1");
  assert.equal(r.action, "delegate");
});

test("routeRustEvent: agent_start without a string sessionId captures nothing", () => {
  assert.equal(route({ type: "agent_start" }).captureSessionId, null);
  assert.equal(route({ type: "agent_start", sessionId: 5 }).captureSessionId, null);
});

test("routeRustEvent: first agent_end (run active) is the real one", () => {
  assert.equal(route({ type: "agent_end" }, false, true).isRealAgentEnd, true);
});

test("routeRustEvent: duplicate agent_end (run already ended) is deduped", () => {
  assert.equal(route({ type: "agent_end" }, false, false).isRealAgentEnd, false);
});

test("routeRustEvent: a plain streaming event just delegates", () => {
  const r = route({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: "hi" } }, true, true);
  assert.deepEqual(r, { dropQueuedText: null, captureSessionId: null, isRealAgentEnd: false, action: "delegate" });
});

// ── End-to-end: a full turn over the real RPC transport ───────────────
// A fake rust-pi that answers the get_state readiness probe and, on "runturn",
// streams one turn: agent_start (with a sessionId), a queued user message coming
// back, a null-bearing text delta + tool start/end (exercising normalization),
// message_end, then agent_end TWICE (the rust-pi error-path double-emit).
const FAKE_SRC = `
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
    if (o.type === "get_state") W({ type: "response", id: o.id, command: "get_state", success: true, data: {} });
    else if (o.type === "runturn") {
      W({ type: "agent_start", sessionId: "sess-1" });
      W({ type: "message_start", message: { role: "user", content: [{ type: "text", text: "steer me" }] } });
      W({ type: "message_update", assistantMessageEvent: { type: "text_delta", delta: null } });
      W({ type: "tool_execution_start", toolName: "write", args: null });
      W({ type: "tool_execution_end", toolName: "write", result: null });
      W({ type: "message_end", message: { role: "assistant", content: [{ type: "text", text: "done" }] } });
      W({ type: "agent_end", messages: [] });
      W({ type: "agent_end", messages: [] });
    }
  }
});
setInterval(() => {}, 60000);
`;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let tmp: string;
let fakeBin: string;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "ingress-test-"));
  fakeBin = join(tmp, "fake.mjs");
  writeFileSync(fakeBin, FAKE_SRC);
});
after(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

test("ingress: a full turn normalizes, clears the queue, captures sessionId, and dedupes agent_end", async () => {
  // Mirror the PiService shell's Rust-only state: the synthetic queue + the
  // run-active flag the dedupe depends on.
  const queue = { steering: ["steer me"], followUp: [] as string[] };
  let agentRunActive = false;
  const seen: Array<{ type: string; routing: ReturnType<typeof routeRustEvent>; event: RustEvent }> = [];

  const rp = new RustProcess({
    binaryPath: process.execPath,
    args: [fakeBin],
    cwd: tmp,
    readyCommand: "get_state", // resolves spawn() on the handshake round-trip
    onEvent: (e) => {
      normalizeRustEvent(e);
      const queueNonEmpty = queue.steering.length > 0 || queue.followUp.length > 0;
      const routing = routeRustEvent(e, queueNonEmpty, agentRunActive);
      if (routing.dropQueuedText !== null) { dropQueuedMessage(queue.steering, queue.followUp, routing.dropQueuedText); }
      if (e.type === "agent_start") { agentRunActive = true; }
      if (routing.isRealAgentEnd) { agentRunActive = false; }
      seen.push({ type: e.type, routing, event: e });
    },
    onExit: () => { /* ignore */ },
  });

  await rp.spawn(); // confirms the get_state readiness handshake works end-to-end
  assert.equal(rp.isAlive(), true);
  rp.send("runturn");
  await delay(300);
  rp.dispose();

  // Normalization happened on the wire-received events (not just in unit tests).
  const update = seen.find((s) => s.type === "message_update");
  assert.equal(update?.event.assistantMessageEvent.delta, "", "null text_delta coerced to ''");
  const toolStart = seen.find((s) => s.type === "tool_execution_start");
  assert.deepEqual(toolStart?.event.args, {}, "null tool args coerced to {}");
  const toolEnd = seen.find((s) => s.type === "tool_execution_end");
  assert.equal("result" in (toolEnd?.event ?? {}), false, "null tool result deleted");

  // The queued steer cleared when its text came back as a user turn.
  assert.deepEqual(queue.steering, [], "synthetic queue drained by the echoed user message");

  // sessionId captured from agent_start.
  const start = seen.find((s) => s.type === "agent_start");
  assert.equal(start?.routing.captureSessionId, "sess-1");

  // Exactly one real agent_end despite the binary emitting two.
  const ends = seen.filter((s) => s.type === "agent_end");
  assert.equal(ends.length, 2, "both agent_end events were received");
  assert.equal(ends.filter((s) => s.routing.isRealAgentEnd).length, 1, "only the first agent_end is real");
});
