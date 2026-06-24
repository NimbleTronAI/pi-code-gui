// Headless tests for the DOM-free webview text/format helpers
// (src/shared/webview-format.ts). The renderer re-exports these from engine.ts;
// living in src/shared lets them compile into out/ for this test.

import { test } from "node:test";
import assert from "node:assert/strict";
import { formatTokens, getLangFromPath, getCompactReadLabel, formatToolError } from "../../shared/webview-format.js";

test("formatTokens: thresholds and unit suffixes", () => {
  assert.equal(formatTokens(0), "0");
  assert.equal(formatTokens(850), "850");
  assert.equal(formatTokens(1500), "1.5k");
  assert.equal(formatTokens(34000), "34k");
  assert.equal(formatTokens(500_000), "0.5M");   // [100k,1M): one decimal
  assert.equal(formatTokens(1_500_000), "2M");   // >=1M: rounded to whole millions
  assert.equal(formatTokens(3_000_000), "3M");
});

test("getLangFromPath: maps extensions, undefined for unknown/empty", () => {
  assert.equal(getLangFromPath("src/a.ts"), "typescript");
  assert.equal(getLangFromPath("x.PY"), "python");        // case-insensitive ext
  assert.equal(getLangFromPath("main.rs"), "rust");
  assert.equal(getLangFromPath("notes.unknownext"), undefined);
  assert.equal(getLangFromPath(""), undefined);
});

test("getCompactReadLabel: classifies skill/resource/docs, undefined otherwise", () => {
  assert.deepEqual(getCompactReadLabel("agent-wiki/skills/deep-research/SKILL.md"), { kind: "skill", label: "deep-research" });
  assert.deepEqual(getCompactReadLabel("AGENTS.md"), { kind: "resource", label: "AGENTS.md" });
  assert.deepEqual(getCompactReadLabel("CLAUDE.md"), { kind: "resource", label: "CLAUDE.md" });
  assert.deepEqual(getCompactReadLabel("project/docs/guide.md"), { kind: "docs", label: "project/docs/guide.md" });
  assert.deepEqual(getCompactReadLabel("README.md"), { kind: "docs", label: "README.md" });
  assert.equal(getCompactReadLabel("src/index.ts"), undefined);
  assert.equal(getCompactReadLabel(""), undefined);
});

test("formatToolError: validation errors are summarized with missing fields", () => {
  const out = formatToolError('Validation failed for tool write: must have required property path', "write");
  assert.ok(out.includes("Argument structure mismatch"));
  assert.ok(out.includes("missing"));
  assert.ok(out.includes("path"));
});

test("formatToolError: known runtime errors map to friendly one-liners", () => {
  assert.equal(formatToolError("operation was aborted", "bash"), "✗ Operation cancelled.");
  assert.equal(formatToolError("EACCES: permission denied", "read"), "⛔ Permission denied — cannot access the file.");
  assert.equal(formatToolError("ENOENT: no such file", "read"), "🔍 File not found — check the path.");
  assert.equal(formatToolError("command timed out", "bash"), "⏰ Command timed out.");
});

test("formatToolError: unknown text passes through unchanged", () => {
  assert.equal(formatToolError("something else entirely", "x"), "something else entirely");
  assert.equal(formatToolError("", "x"), "");
});
