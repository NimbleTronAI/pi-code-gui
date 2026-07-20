// Headless tests for the streaming-tool-call behavioral contract (src/rpc-behavior.ts).
// Fixtures are the REAL shapes captured from raw `--mode rpc` runs of both binaries:
//  - pre-#129 (0.1.22 release): id/name empty "" the whole way, args grow  → violations
//  - HEAD (9fcdb655, #129 fix):  id/name non-empty from delta 1, args grow → clean
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  analyzeToolStream, checkStreamContract, argumentsAreReal, detectCoalescing,
  type ToolCallDeltaFrame,
} from "../../rpc-behavior.js";

/** Build a growing tool-call stream. `idFrom`/`nameFrom` = ordinal each becomes non-empty
 *  (0 = never); args become real at `argsFrom`. Mirrors captured DeepSeek write streams. */
function stream(n: number, opts: { idFrom: number; nameFrom: number; argsFrom: number }): ToolCallDeltaFrame[] {
  const frames: ToolCallDeltaFrame[] = [];
  for (let i = 1; i <= n; i++) {
    frames.push({
      index: i,
      id: opts.idFrom && i >= opts.idFrom ? "call_00_abc" : "",
      name: opts.nameFrom && i >= opts.nameFrom ? "write" : "",
      arguments: opts.argsFrom && i >= opts.argsFrom ? { path: "/tmp/x", content: "…".repeat(i) } : (i > 1 ? {} : null),
    });
  }
  return frames;
}

test("argumentsAreReal: null/undefined/{}/'' are not real; partial object/string are", () => {
  assert.equal(argumentsAreReal(null), false);
  assert.equal(argumentsAreReal(undefined), false);
  assert.equal(argumentsAreReal({}), false);
  assert.equal(argumentsAreReal(""), false);
  assert.equal(argumentsAreReal({ path: "" }), true);
  assert.equal(argumentsAreReal('{"path":"'), true);
});

test("HEAD/#129 fixed: id+name from delta 1, args grow → NO violations", () => {
  const r = analyzeToolStream(stream(140, { idFrom: 1, nameFrom: 1, argsFrom: 7 }));
  assert.equal(r.firstIdAt, 1);
  assert.equal(r.firstNameAt, 1);
  assert.equal(r.firstArgsAt, 7);
  assert.equal(r.idStableAfterFirst, true);
  assert.deepEqual(checkStreamContract(r), []);
});

test("pre-#129: id/name empty the whole way (0) → id-not-early + name-not-early", () => {
  const r = analyzeToolStream(stream(140, { idFrom: 0, nameFrom: 0, argsFrom: 7 }));
  assert.equal(r.firstIdAt, null);
  assert.equal(r.firstNameAt, null);
  const codes = checkStreamContract(r).map((x) => x.code);
  assert.ok(codes.includes("id-not-early"), "id violation flagged");
  assert.ok(codes.includes("name-not-early"), "name violation flagged");
  assert.ok(!codes.includes("args-not-streamed"), "args did stream, so no args violation");
});

test("pre-#124: arguments null until the terminal delta → args-not-streamed", () => {
  const r = analyzeToolStream(stream(50, { idFrom: 1, nameFrom: 1, argsFrom: 0 }));
  assert.equal(r.firstArgsAt, null);
  assert.ok(checkStreamContract(r).some((x) => x.code === "args-not-streamed"));
});

test("id landing within the grace window (delta 3) is allowed; delta 4 is not", () => {
  assert.deepEqual(checkStreamContract(analyzeToolStream(stream(20, { idFrom: 3, nameFrom: 3, argsFrom: 4 }))), []);
  const late = checkStreamContract(analyzeToolStream(stream(20, { idFrom: 4, nameFrom: 1, argsFrom: 4 })));
  assert.ok(late.some((x) => x.code === "id-not-early"));
});

test("id blinking back to empty after appearing → id-unstable", () => {
  const frames: ToolCallDeltaFrame[] = [
    { index: 1, id: "call_1", name: "write", arguments: {} },
    { index: 2, id: "", name: "write", arguments: { path: "/a" } },
    { index: 3, id: "call_1", name: "write", arguments: { path: "/ab" } },
  ];
  const r = analyzeToolStream(frames);
  assert.equal(r.idStableAfterFirst, false);
  assert.ok(checkStreamContract(r).some((x) => x.code === "id-unstable"));
});

test("empty stream (no tool call this turn) → no violations", () => {
  assert.deepEqual(checkStreamContract(analyzeToolStream([])), []);
});

test("detectCoalescing: even cadence is smooth; one huge gap = coalesced (backpressure)", () => {
  assert.equal(detectCoalescing([30, 25, 40, 35, 28]).coalesced, false);
  const c = detectCoalescing([30, 25, 40, 3200, 28, 35]);
  assert.equal(c.coalesced, true);
  assert.equal(c.maxGapMs, 3200);
});
