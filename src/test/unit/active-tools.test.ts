// Headless tests for the extracted tools picker core (src/active-tools.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mapSessionTools, findLastActiveTools, buildToolPickerRows, summarizeToolSelection, type ToolInfo } from "../../active-tools.js";

type Any = ReturnType<typeof JSON.parse>;

test("mapSessionTools: name/description/source with sdk + empty-description fallback", () => {
  const out = mapSessionTools([
    { name: "read", description: "Read a file", sourceInfo: { source: "builtin" } },
    { name: "vscode_diag", sourceInfo: {} },        // no description, no source → "" + "sdk"
    { name: "custom" },                              // no sourceInfo at all → "sdk"
  ] as Any);
  assert.deepEqual(out, [
    { name: "read", description: "Read a file", source: "builtin" },
    { name: "vscode_diag", description: "", source: "sdk" },
    { name: "custom", description: "", source: "sdk" },
  ]);
  assert.deepEqual(mapSessionTools(undefined as Any), []);
});

test("findLastActiveTools: returns the LAST non-empty tools_active_change, else null", () => {
  const entries = [
    { type: "tools_active_change", toolNames: ["a"] },
    { type: "message" },
    { type: "tools_active_change", toolNames: ["b", "c"] }, // last wins
  ];
  assert.deepEqual(findLastActiveTools(entries), ["b", "c"]);
  assert.equal(findLastActiveTools([{ type: "message" }]), null);
  assert.equal(findLastActiveTools([]), null);
  // Empty toolNames is skipped (a "cleared" record doesn't count as a restore point).
  assert.deepEqual(findLastActiveTools([{ type: "tools_active_change", toolNames: ["x"] }, { type: "tools_active_change", toolNames: [] }]), ["x"]);
});

const TOOLS: ToolInfo[] = [
  { name: "read", description: "Read", source: "builtin" },
  { name: "bash", description: "Shell", source: "builtin" },
  { name: "vscode_diagnostics", description: "Diags", source: "sdk" },
  { name: "my_ext_tool", description: "Ext", source: "extension" },
];

test("buildToolPickerRows: three groups with icons, picked reflects active set", () => {
  const rows = buildToolPickerRows(TOOLS, new Set(["read", "vscode_diagnostics"]));
  const seps = rows.filter((r) => r.separator);
  assert.deepEqual(seps.map((s) => (s as Any).label), ["Built-in", "VS Code Bridge", "Extension"]);
  assert.deepEqual(seps.map((s) => (s as Any).icon), ["tools", "extensions", "symbol-misc"]);
  const read = rows.find((r) => !r.separator && (r as Any).name === "read") as Any;
  const bash = rows.find((r) => !r.separator && (r as Any).name === "bash") as Any;
  assert.equal(read.picked, true);
  assert.equal(bash.picked, false);
});

test("buildToolPickerRows: empty groups are omitted entirely", () => {
  const rows = buildToolPickerRows([{ name: "read", description: "", source: "builtin" }], new Set());
  assert.deepEqual(rows.filter((r) => r.separator).map((s) => (s as Any).label), ["Built-in"]);
  assert.equal(rows.length, 2); // one separator + one tool
});

test("buildToolPickerRows: an sdk tool without the vscode_ prefix lands in Extension, not Bridge", () => {
  const rows = buildToolPickerRows([{ name: "weird_sdk", description: "", source: "sdk" }], new Set());
  assert.deepEqual(rows.filter((r) => r.separator).map((s) => (s as Any).label), ["Extension"]);
});

test("summarizeToolSelection: counts adds and removes and composes the message", () => {
  // active {a,b,c}; select {a,d} → added d (+1), removed b,c (-2)
  const s = summarizeToolSelection(new Set(["a", "b", "c"]), ["a", "d"]);
  assert.deepEqual({ added: s.added, removed: s.removed }, { added: 1, removed: 2 });
  assert.equal(s.summary, "Tools updated: 2 active (+1, -2)");
});

test("summarizeToolSelection: no change → no parenthetical", () => {
  const s = summarizeToolSelection(new Set(["a", "b"]), ["a", "b"]);
  assert.equal(s.summary, "Tools updated: 2 active");
});

test("summarizeToolSelection: only additions", () => {
  assert.equal(summarizeToolSelection(new Set(["a"]), ["a", "b"]).summary, "Tools updated: 2 active (+1)");
});
