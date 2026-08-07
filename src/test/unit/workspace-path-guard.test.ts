// Tests for the openFile path guard. `openFile` acts on a `data-path` the WEBVIEW supplies
// (render/engine.ts posts openFile for any element carrying data-path), so the model effectively
// chooses the value — this checks it is contained within a workspace root.
import { test } from "node:test";
import assert from "node:assert/strict";
import { safeWorkspaceFilePath } from "../../shared/workspace-path-guard.js";

const ROOT = "/home/dev/project";

test("openFile: paths inside the workspace resolve to an absolute path", () => {
  assert.equal(safeWorkspaceFilePath(`${ROOT}/src/index.ts`, [ROOT]), `${ROOT}/src/index.ts`);
  assert.equal(safeWorkspaceFilePath("src/index.ts", [ROOT]), `${ROOT}/src/index.ts`, "relative resolves against the root");
  assert.equal(safeWorkspaceFilePath(".", [ROOT]), ROOT);
});

test("openFile: escaping the workspace is BLOCKED", () => {
  assert.equal(safeWorkspaceFilePath("/home/dev/.ssh/id_rsa", [ROOT]), null, "absolute outside");
  assert.equal(safeWorkspaceFilePath("../../.ssh/id_rsa", [ROOT]), null, "traversal");
  assert.equal(safeWorkspaceFilePath("/etc/passwd", [ROOT]), null);
  assert.equal(safeWorkspaceFilePath(`${ROOT}/../secrets.txt`, [ROOT]), null, "normalises before comparing");
});

test("openFile: a sibling root whose name merely PREFIXES the root is not inside it", () => {
  // /home/dev/project-secrets must not count as inside /home/dev/project.
  assert.equal(safeWorkspaceFilePath("/home/dev/project-secrets/x", [ROOT]), null);
});

test("openFile: multi-root workspaces accept any root", () => {
  const roots = [ROOT, "/home/dev/other"];
  assert.equal(safeWorkspaceFilePath("/home/dev/other/a.ts", roots), "/home/dev/other/a.ts");
  assert.equal(safeWorkspaceFilePath("/home/dev/elsewhere/a.ts", roots), null);
});

test("openFile: no workspace open blocks everything, and NUL bytes are rejected", () => {
  assert.equal(safeWorkspaceFilePath(`${ROOT}/a.ts`, []), null);
  assert.equal(safeWorkspaceFilePath(`${ROOT}/a\0.ts`, [ROOT]), null);
  assert.equal(safeWorkspaceFilePath(undefined, [ROOT]), null);
});
