// Headless tests for the pi-ai SDK version gate (version-compare.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSemver, compareSemver, isOlderThan, piAiVersionNotice } from "../../version-compare.js";

test("parseSemver: core triple, tolerant of v-prefix and pre-release/build", () => {
  assert.deepEqual(parseSemver("1.2.3"), [1, 2, 3]);
  assert.deepEqual(parseSemver("v0.80.2"), [0, 80, 2]);
  assert.deepEqual(parseSemver("0.80.2-beta.1"), [0, 80, 2]);
  assert.deepEqual(parseSemver("1.2.3+build.5"), [1, 2, 3]);
  assert.deepEqual(parseSemver("0.79"), [0, 79, 0]);   // missing patch → 0
  assert.deepEqual(parseSemver(""), [0, 0, 0]);
  assert.deepEqual(parseSemver("garbage"), [0, 0, 0]);
});

test("compareSemver: orders by major, then minor, then patch", () => {
  assert.equal(compareSemver("0.80.0", "0.80.0"), 0);
  assert.equal(compareSemver("0.79.8", "0.80.0"), -1);  // minor lower
  assert.equal(compareSemver("0.80.2", "0.80.0"), 1);   // patch higher
  assert.equal(compareSemver("1.0.0", "0.99.99"), 1);   // major dominates
  assert.equal(compareSemver("0.80.10", "0.80.2"), 1);  // numeric, not lexical
});

test("isOlderThan: strict less-than against the minimum", () => {
  assert.equal(isOlderThan("0.79.8", "0.80.0"), true);
  assert.equal(isOlderThan("0.80.0", "0.80.0"), false); // equal is not older
  assert.equal(isOlderThan("0.80.2", "0.80.0"), false);
  assert.equal(isOlderThan("1.0.0", "0.80.0"), false);
});

// ── which SDK notice to show (piAiVersionNotice) ──────────────────────
// The bug this replaces: the check compared against the FLOOR alone, so a user at or above it
// heard nothing however far they drifted. Someone on 0.82.1 while the extension shipped a
// 0.83.0 catalog — newer models, new thinking tiers, changed PRICING — was never told.
const FLOOR = "0.80.0";
const TARGET = "0.83.0";

test("piAiVersionNotice: below the floor → compatibility warning naming the floor", () => {
  const n = piAiVersionNotice("0.79.8", FLOOR, TARGET);
  assert.deepEqual(n, { version: FLOOR, belowFloor: true });
});

test("piAiVersionNotice: at/above the floor but behind the target → a NUDGE, not a warning", () => {
  const n = piAiVersionNotice("0.82.1", FLOOR, TARGET);
  assert.deepEqual(n, { version: TARGET, belowFloor: false },
    "this is the case the floor-only check silently ignored");
});

test("piAiVersionNotice: exactly at the floor is not a compatibility problem", () => {
  assert.deepEqual(piAiVersionNotice("0.80.0", FLOOR, TARGET), { version: TARGET, belowFloor: false });
});

test("piAiVersionNotice: current or ahead → silence (never nag someone up to date)", () => {
  assert.equal(piAiVersionNotice("0.83.0", FLOOR, TARGET), null);
  assert.equal(piAiVersionNotice("0.84.1", FLOOR, TARGET), null);
});

test("piAiVersionNotice: an unreadable version says nothing rather than guessing", () => {
  assert.equal(piAiVersionNotice("", FLOOR, TARGET), null);
});
