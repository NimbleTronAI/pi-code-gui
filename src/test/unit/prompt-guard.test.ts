// Headless tests for shouldDropPreemptingPrompt — the guard that stops a mode-less
// prompt from preempting an in-flight turn (the Rust double-bill of 2026-07-06).
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldDropPreemptingPrompt } from "../../prompt-guard.js";

test("drops a mode-less conversational prompt while a turn is active", () => {
  assert.equal(shouldDropPreemptingPrompt(undefined, true, "audit the dual runtimes"), true);
});

test("allows the first prompt (no active turn)", () => {
  assert.equal(shouldDropPreemptingPrompt(undefined, false, "audit the dual runtimes"), false);
});

test("allows a genuine mid-stream follow-up (steer / queue)", () => {
  assert.equal(shouldDropPreemptingPrompt("steer", true, "also check X"), false);
  assert.equal(shouldDropPreemptingPrompt("queue", true, "and Y"), false);
});

test("exempts slash commands even during an active turn", () => {
  assert.equal(shouldDropPreemptingPrompt(undefined, true, "/model"), false);
  assert.equal(shouldDropPreemptingPrompt(undefined, true, "/compact"), false);
});

test("does not drop a slash-looking-but-empty edge, and respects the active flag", () => {
  // Not active → never dropped, regardless of text/mode.
  assert.equal(shouldDropPreemptingPrompt(undefined, false, "/model"), false);
  assert.equal(shouldDropPreemptingPrompt("steer", false, "x"), false);
});
