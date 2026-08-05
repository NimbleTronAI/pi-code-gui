// Headless tests for the `rust-pi doctor` verdict parser (rust-doctor.ts). The
// precedence is load-bearing: "[FAIL]" and "incompatible" beat "compatible"
// (which is a substring of "incompatible"), and an explicit verdict beats the
// process exit code.

import { test } from "node:test";
import assert from "node:assert/strict";
import { parseDoctorVerdict } from "../../rust-doctor.js";

test("a hard [FAIL] is incompatible even on a zero exit", () => {
  assert.equal(parseDoctorVerdict("npm:foo  [FAIL] missing field `parameters`", 0), false);
});

test("'incompatible' wins over the 'compatible' substring it contains", () => {
  assert.equal(parseDoctorVerdict("Extension is incompatible with this runtime", 0), false);
});

test("an explicit 'compatible' verdict beats a non-zero exit code", () => {
  assert.equal(parseDoctorVerdict("npm:foo  compatible", 1), true);
});

test("no verdict in output → trust the exit code", () => {
  assert.equal(parseDoctorVerdict("doctor produced no clear verdict", 0), true);
  assert.equal(parseDoctorVerdict("doctor produced no clear verdict", 1), false);
  assert.equal(parseDoctorVerdict("", 0), true);
  assert.equal(parseDoctorVerdict("", 2), false);
});
