// Headless tests for shouldUnpinOnScroll — the auto-follow gate that keeps a chat
// session pinned to the bottom through tool-block reflows (see src/shared/scroll.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { shouldUnpinOnScroll } from "../../shared/scroll.js";

test("at bottom never unpins, regardless of gesture", () => {
  assert.equal(shouldUnpinOnScroll(true, true, 0), false);
  assert.equal(shouldUnpinOnScroll(true, false, 9999), false);
});

test("off bottom during a real user gesture unpins", () => {
  assert.equal(shouldUnpinOnScroll(false, false, 10), true);        // recent wheel/touch
  assert.equal(shouldUnpinOnScroll(false, true, 9999), true);       // active scrollbar drag
});

test("off bottom from a reflow (no gesture) does NOT unpin — the pinned-to-bottom fix", () => {
  assert.equal(shouldUnpinOnScroll(false, false, 9999), false);     // stale gesture, no pointer
  assert.equal(shouldUnpinOnScroll(false, false, 251), false);      // just past the window
});

test("gesture window boundary is exclusive at the edge", () => {
  assert.equal(shouldUnpinOnScroll(false, false, 249, 250), true);
  assert.equal(shouldUnpinOnScroll(false, false, 250, 250), false);
});
