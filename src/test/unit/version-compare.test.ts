// Headless tests for the pi-ai SDK version gate (version-compare.ts).

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSemver, compareSemver, isOlderThan } from "../../version-compare.js";

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
