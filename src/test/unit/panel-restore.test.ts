// Headless tests for the panel-revival planner (panel-restore.ts). The state fed in
// is whatever a webview last persisted via setState — including shapes written by
// older extension versions — so the planner must never trust it.
import { test } from "node:test";
import assert from "node:assert/strict";
import { planPanelRestore } from "../../panel-restore.js";

const exists = () => true;
const missing = () => false;

test("persisted session file that exists → open on the persisted runtime", () => {
  assert.deepEqual(
    planPanelRestore({ sessionFilePath: "/s/a.jsonl", runtime: "rust" }, exists, "typescript"),
    { action: "open", runtime: "rust", openPath: "/s/a.jsonl" },
  );
});

test("persisted session file that is GONE → dispose the revived panel", () => {
  assert.equal(planPanelRestore({ sessionFilePath: "/s/gone.jsonl", runtime: "typescript" }, missing, "typescript").action, "dispose");
});

test("no session file persisted (nothing hit disk) → fresh session on the persisted runtime", () => {
  assert.deepEqual(
    planPanelRestore({ runtime: "rust" }, exists, "typescript"),
    { action: "fresh", runtime: "rust" },
  );
});

test("foreign/legacy state (e.g. the step-0 probe) → fresh session on the default runtime", () => {
  assert.deepEqual(
    planPanelRestore({ step0Probe: true, seededAt: "2026-07-03" }, exists, "typescript"),
    { action: "fresh", runtime: "typescript" },
  );
});

test("null/undefined/garbage state never throws and falls back to fresh + default", () => {
  for (const s of [null, undefined, 42, "x", { sessionFilePath: 7, runtime: "python" }]) {
    const plan = planPanelRestore(s, exists, "rust");
    assert.equal(plan.action, "fresh");
    assert.equal(plan.runtime, "rust");
  }
});
