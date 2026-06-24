// Headless tests for the bridge tools' output-size guards (bridge-limits.ts).
// boundedJson is the sole context-overflow guard on tool results, so its
// boundaries (kept-as-is below the limit, truncated envelope above) matter.

import { test } from "node:test";
import assert from "node:assert/strict";
import { truncateText, boundedJson, MAX_OUTPUT_LINES, MAX_OUTPUT_BYTES } from "../../bridge-limits.js";

// ── truncateText ─────────────────────────────────────────────────────
test("truncateText: short text under both limits is returned unchanged", () => {
  assert.equal(truncateText("a\nb\nc"), "a\nb\nc");
});

test("truncateText: trims to maxLines", () => {
  const text = Array.from({ length: 10 }, (_, i) => `line${i}`).join("\n");
  assert.equal(truncateText(text, 3), "line0\nline1\nline2");
});

test("truncateText: enforces the byte ceiling", () => {
  const text = "x".repeat(MAX_OUTPUT_BYTES * 2);
  const out = truncateText(text);
  assert.ok(Buffer.byteLength(out, "utf8") <= MAX_OUTPUT_BYTES);
});

test("truncateText: line limit applies before the byte limit", () => {
  const text = Array.from({ length: MAX_OUTPUT_LINES + 50 }, () => "y").join("\n");
  const out = truncateText(text);
  assert.equal(out.split("\n").length, MAX_OUTPUT_LINES);
});

// ── boundedJson ──────────────────────────────────────────────────────
test("boundedJson: a small value stringifies verbatim", () => {
  const v = { a: 1, b: ["x", "y"] };
  assert.equal(boundedJson(v), JSON.stringify(v));
});

test("boundedJson: undefined stringifies to \"null\"", () => {
  assert.equal(boundedJson(undefined), "null");
});

test("boundedJson: an oversized value yields a bounded truncation envelope", () => {
  const v = { big: "z".repeat(MAX_OUTPUT_BYTES + 10_000) };
  const raw = boundedJson(v);
  const parsed = JSON.parse(raw) as {
    truncated: boolean; originalBytes: number; originalLines: number; resultJsonPrefix: string;
  };
  assert.equal(parsed.truncated, true);
  assert.ok(parsed.originalBytes > MAX_OUTPUT_BYTES, "reports the real original size");
  // The envelope itself must stay within the byte bound (its prefix is truncated).
  assert.ok(Buffer.byteLength(parsed.resultJsonPrefix, "utf8") <= MAX_OUTPUT_BYTES);
  assert.notEqual(raw, JSON.stringify(v));
});

test("boundedJson: a value exactly at the byte limit is kept verbatim", () => {
  // JSON of {"s":"<pad>"} — size the pad so the whole string lands on the limit.
  const overhead = JSON.stringify({ s: "" }).length; // {"s":""}
  const pad = "q".repeat(MAX_OUTPUT_BYTES - overhead);
  const v = { s: pad };
  assert.equal(Buffer.byteLength(JSON.stringify(v), "utf8"), MAX_OUTPUT_BYTES);
  assert.equal(boundedJson(v), JSON.stringify(v));
});
