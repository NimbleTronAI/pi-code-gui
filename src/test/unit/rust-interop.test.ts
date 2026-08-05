// Headless tests for the pure Rust-interop gates (rust-interop.ts). These drive
// the `--no-extensions` self-heal path: workspaceHasTsPiExtensions decides whether
// a workspace's TypeScript-format `.pi/` extensions would break Rust startup, and
// isRustExtensionConflict recognizes the resulting parse error so it can recover.

import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { workspaceHasTsPiExtensions, isRustExtensionConflict } from "../../rust-interop.js";

function tmpWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "pi-interop-"));
}

// ── isRustExtensionConflict (pure string match) ──────────────────────
test("isRustExtensionConflict: matches the TS-extension parse error (any casing)", () => {
  assert.equal(isRustExtensionConflict("JSON error: missing field `parameters` at line 1"), true);
  assert.equal(isRustExtensionConflict("MISSING FIELD 'PARAMETERS'"), true);
});

test("isRustExtensionConflict: false for unrelated errors", () => {
  assert.equal(isRustExtensionConflict("connection refused"), false);
  assert.equal(isRustExtensionConflict("missing field `model`"), false); // missing field, wrong field
  assert.equal(isRustExtensionConflict("invalid parameters supplied"), false); // parameters, no missing field
  assert.equal(isRustExtensionConflict(""), false);
});

// ── workspaceHasTsPiExtensions (filesystem inspection) ───────────────
test("workspaceHasTsPiExtensions: no .pi dir → false", () => {
  const dir = tmpWorkspace();
  assert.equal(workspaceHasTsPiExtensions(dir), false);
});

test("workspaceHasTsPiExtensions: empty .pi dir → false", () => {
  const dir = tmpWorkspace();
  fs.mkdirSync(path.join(dir, ".pi"));
  assert.equal(workspaceHasTsPiExtensions(dir), false);
});

test("workspaceHasTsPiExtensions: a .pi/npm install dir → true", () => {
  const dir = tmpWorkspace();
  fs.mkdirSync(path.join(dir, ".pi", "npm"), { recursive: true });
  assert.equal(workspaceHasTsPiExtensions(dir), true);
});

test("workspaceHasTsPiExtensions: non-empty packages array in settings.json → true", () => {
  const dir = tmpWorkspace();
  fs.mkdirSync(path.join(dir, ".pi"));
  fs.writeFileSync(path.join(dir, ".pi", "settings.json"), JSON.stringify({ packages: ["npm:pi-web-access"] }));
  assert.equal(workspaceHasTsPiExtensions(dir), true);
});

test("workspaceHasTsPiExtensions: empty or absent packages array → false", () => {
  const dir = tmpWorkspace();
  fs.mkdirSync(path.join(dir, ".pi"));
  fs.writeFileSync(path.join(dir, ".pi", "settings.json"), JSON.stringify({ packages: [] }));
  assert.equal(workspaceHasTsPiExtensions(dir), false);

  const dir2 = tmpWorkspace();
  fs.mkdirSync(path.join(dir2, ".pi"));
  fs.writeFileSync(path.join(dir2, ".pi", "settings.json"), JSON.stringify({ model: "x" }));
  assert.equal(workspaceHasTsPiExtensions(dir2), false);
});

test("workspaceHasTsPiExtensions: malformed settings.json is caught → false", () => {
  const dir = tmpWorkspace();
  fs.mkdirSync(path.join(dir, ".pi"));
  fs.writeFileSync(path.join(dir, ".pi", "settings.json"), "{ not valid json");
  assert.equal(workspaceHasTsPiExtensions(dir), false);
});
