// Headless tests for the panel-revival planner (panel-restore.ts). The state fed in
// is whatever a webview last persisted via setState — including shapes written by
// older extension versions — so the planner must never trust it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planPanelRestore, resolvePanelLocation } from "../../panel-restore.js";

const exists = () => true;
const missing = () => false;

test("persisted session file that exists → open it", () => {
  assert.deepEqual(
    planPanelRestore({ sessionFilePath: "/s/a.jsonl", runtime: "typescript" }, exists),
    { action: "open", openPath: "/s/a.jsonl" },
  );
});

test("persisted session file that is GONE → dispose the revived panel", () => {
  assert.equal(planPanelRestore({ sessionFilePath: "/s/gone.jsonl", runtime: "typescript" }, missing).action, "dispose");
});

test("no session file persisted (nothing hit disk) → fresh session", () => {
  assert.deepEqual(planPanelRestore({ runtime: "typescript" }, exists), { action: "fresh" });
});

test("a panel persisted by a Rust Pi session is closed, never opened on the SDK", () => {
  // Opening that file on the SDK would migrate and rewrite it; the file must stay untouched.
  let probed = false;
  assert.deepEqual(
    planPanelRestore({ sessionFilePath: "/s/r.jsonl", runtime: "rust" }, () => { probed = true; return true; }),
    { action: "dispose", retiredSessionFile: "/s/r.jsonl" },
  );
  assert.equal(probed, false, "the file is not even probed");
  assert.deepEqual(planPanelRestore({ runtime: "rust" }, exists), { action: "dispose" });
});

test("foreign/legacy state (e.g. the step-0 probe) → fresh session", () => {
  assert.deepEqual(planPanelRestore({ step0Probe: true, seededAt: "2026-07-03" }, exists), { action: "fresh" });
});

test("null/undefined/garbage state never throws and falls back to fresh", () => {
  for (const s of [null, undefined, 42, "x", { sessionFilePath: 7, runtime: "python" }]) {
    assert.deepEqual(planPanelRestore(s, exists), { action: "fresh" });
  }
});

// ── #83: where a new chat opens ─────────────────────────────────────
test("resolvePanelLocation: only an explicit \"active\" moves the chat into the current group", () => {
  assert.equal(resolvePanelLocation("active"), "active");
  assert.equal(resolvePanelLocation("beside"), "beside");
  assert.equal(resolvePanelLocation(" active "), "active", "tolerates stray whitespace");
});

test("resolvePanelLocation: anything unrecognised falls back to the historical behaviour", () => {
  // A hand-edited settings.json or a value from a newer version must not stop a chat opening.
  for (const bad of [undefined, null, "", "Active", "split", "two"]) {
    assert.equal(resolvePanelLocation(bad as string | undefined), "beside", JSON.stringify(bad));
  }
});
