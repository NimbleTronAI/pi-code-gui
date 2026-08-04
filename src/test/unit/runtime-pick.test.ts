// Headless tests for the new-session runtime selection (runtime-pick.ts):
// both/ts-only/rust-only/neither, and how the persisted default applies only
// when both are installed.

import { test } from "node:test";
import assert from "node:assert/strict";
import { rustVersionNoticeKey } from "../../rust-resolver.js";
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

// ── "your Rust binary isn't the tested version" dedup (rustVersionNoticeKey) ──────
// Both bugs this covers presented as SILENCE, which no amount of manual testing reveals:
// you cannot notice a notification that never fires.
test("rustVersionNoticeKey: silent when the binary already matches the pin", () => {
  assert.equal(rustVersionNoticeKey("pi 0.1.23 (abc)", "v0.1.23", undefined), null);
});

test("rustVersionNoticeKey: a PIN BUMP re-notifies someone already warned about the same binary", () => {
  // The regression: the stored key used to be the detected version alone, so a user carrying
  // "0.1.20" in globalState (warned when the pin was v0.1.22) was never told about v0.1.23 —
  // their binary hadn't changed, so the key still matched. Exactly the release a bump exists
  // to announce, silently swallowed.
  assert.equal(rustVersionNoticeKey("pi 0.1.20 (x)", "v0.1.22", undefined), "0.1.20->0.1.22");
  assert.equal(rustVersionNoticeKey("pi 0.1.20 (x)", "v0.1.23", "0.1.20"), "0.1.20->0.1.23");
});

test("rustVersionNoticeKey: doesn't nag once that exact pairing has been shown", () => {
  assert.equal(rustVersionNoticeKey("pi 0.1.20 (x)", "v0.1.23", "0.1.20->0.1.23"), null);
});

test("rustVersionNoticeKey: unparseable or absent version stays silent", () => {
  for (const v of [undefined, "", "pi (dev build)"]) {
    assert.equal(rustVersionNoticeKey(v, "v0.1.23", undefined), null);
  }
});

test("rustVersionNoticeKey: tolerates a pin written with or without the leading v", () => {
  assert.equal(rustVersionNoticeKey("pi 0.1.23 (x)", "0.1.23", undefined), null);
});
