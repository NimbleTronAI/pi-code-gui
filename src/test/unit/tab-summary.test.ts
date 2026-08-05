// Headless tests for the extracted tab-summary core (src/tab-summary.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { TAB_SUMMARY_SYSTEM_PROMPT, buildSummaryContext, cleanTabSummary } from "../../tab-summary.js";

const NOW = 1_700_000_000_000;

test("buildSummaryContext: system prompt + single user message with injected timestamp", () => {
  const ctx = buildSummaryContext("fix the login bug", NOW);
  assert.equal(ctx.systemPrompt, TAB_SUMMARY_SYSTEM_PROMPT);
  assert.deepEqual(ctx.messages, [{ role: "user", content: "fix the login bug", timestamp: NOW }]);
});

test("cleanTabSummary: takes the first line, trims, caps at 40 chars", () => {
  assert.equal(cleanTabSummary("  add dark mode  \nextra line"), "add dark mode");
  const long = "a".repeat(80);
  assert.equal(cleanTabSummary(long)?.length, 40);
});

test("cleanTabSummary: strips a single pair of surrounding quotes", () => {
  assert.equal(cleanTabSummary('"refactor auth flow"'), "refactor auth flow");
  assert.equal(cleanTabSummary("'update readme'"), "update readme");
});

test("cleanTabSummary: null / undefined / empty → null", () => {
  assert.equal(cleanTabSummary(null), null);
  assert.equal(cleanTabSummary(undefined), null);
  assert.equal(cleanTabSummary(""), null);
});

test("cleanTabSummary: quote-strip only removes the outermost quote chars (anchored)", () => {
  // A leading quote and a trailing quote each get stripped once; inner quotes stay.
  assert.equal(cleanTabSummary('"a "b" c"'), 'a "b" c');
});
