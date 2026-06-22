// Headless tests for the catalog maxTokens resolver (rust-catalog.ts). rust-pi
// 0.1.20 forwards a model's maxTokens to the provider verbatim, so the bundled
// registry's placeholder values (a copy of contextWindow) must be OMITTED — not
// sent — while genuine sub-window limits are kept. Boundaries are anchored on a
// verified-live finding: deepseek rejects max_tokens outside [1, 393216] with an
// HTTP 400 (silent empty turn), accepts deepseek-v4-pro's 384000, and completes
// normally when the field is omitted entirely.
import { test } from "node:test";
import assert from "node:assert/strict";
import { resolveMaxOutputTokens } from "../../rust-catalog.js";

test("a real limit below the context window is kept verbatim", () => {
  assert.equal(resolveMaxOutputTokens(8192, 200000), 8192);
  assert.equal(resolveMaxOutputTokens(32768, 1047576), 32768);
});

test("deepseek-v4-pro 384,000 (< its 1,000,000 window) is kept, not omitted", () => {
  assert.equal(resolveMaxOutputTokens(384000, 1000000), 384000);
});

test("a large but deliberate sub-window value is trusted (genuine capacity preserved)", () => {
  assert.equal(resolveMaxOutputTokens(500000, 1000000), 500000);
  assert.equal(resolveMaxOutputTokens(262143, 262144), 262143);
});

test("a placeholder (maxTokens == contextWindow) is omitted → provider default applies", () => {
  assert.equal(resolveMaxOutputTokens(2000000, 2000000), undefined); // grok
  assert.equal(resolveMaxOutputTokens(262144, 262144), undefined);   // kimi
  assert.equal(resolveMaxOutputTokens(8192, 8192), undefined);       // any model where they're equal
});

test("a value above the context window is also omitted", () => {
  assert.equal(resolveMaxOutputTokens(4096, 4095), undefined);
});

test("garbage / non-positive maxTokens is omitted (provider default keeps the model callable)", () => {
  assert.equal(resolveMaxOutputTokens(0, 200000), undefined);
  assert.equal(resolveMaxOutputTokens(-5, 200000), undefined);
  assert.equal(resolveMaxOutputTokens(NaN, 200000), undefined);
  assert.equal(resolveMaxOutputTokens(Infinity, 200000), undefined);
});

test("a real value is kept even when the context window is missing/zero (can't judge a placeholder)", () => {
  assert.equal(resolveMaxOutputTokens(8192, 0), 8192);
  assert.equal(resolveMaxOutputTokens(8192, NaN), 8192);
});

test("fractional input is floored to an integer", () => {
  assert.equal(resolveMaxOutputTokens(8192.9, 200000), 8192);
});

test("a kept value is always a positive integer", () => {
  for (const [mt, cw] of [[5, 100], [8192.9, 200000], [1, 2]] as Array<[number, number]>) {
    const out = resolveMaxOutputTokens(mt, cw);
    assert.ok(out !== undefined && Number.isInteger(out) && out >= 1, `expected positive int, got ${out} for (${mt}, ${cw})`);
  }
});
