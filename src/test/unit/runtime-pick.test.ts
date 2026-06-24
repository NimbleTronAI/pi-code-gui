// Headless tests for the new-session runtime selection (runtime-pick.ts):
// both/ts-only/rust-only/neither, and how the persisted default applies only
// when both are installed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { pickDefaultRuntime } from "../../runtime-pick.js";

test("both installed: honors the setting (rust only when exactly 'rust')", () => {
  assert.equal(pickDefaultRuntime({ ts: true, rust: true }, "rust"), "rust");
  assert.equal(pickDefaultRuntime({ ts: true, rust: true }, "typescript"), "typescript");
  // Any non-"rust" value (default, garbage) → typescript, never null when both exist.
  assert.equal(pickDefaultRuntime({ ts: true, rust: true }, ""), "typescript");
  assert.equal(pickDefaultRuntime({ ts: true, rust: true }, "nonsense"), "typescript");
});

test("exactly one installed: that one, ignoring the setting (no nagging)", () => {
  assert.equal(pickDefaultRuntime({ ts: true, rust: false }, "rust"), "typescript");
  assert.equal(pickDefaultRuntime({ ts: false, rust: true }, "typescript"), "rust");
});

test("neither installed: null (caller runs the install flow)", () => {
  assert.equal(pickDefaultRuntime({ ts: false, rust: false }, "typescript"), null);
  assert.equal(pickDefaultRuntime({ ts: false, rust: false }, "rust"), null);
});
