// Tests for the openUrl / openFile guards. Both messages act on a string the WEBVIEW supplies,
// and both senders are blanket handlers over model-rendered content (any <a href> in the
// transcript; any element carrying data-path), so the model effectively chooses these values.
import { test } from "node:test";
import assert from "node:assert/strict";
import { safeExternalUrlString, safeWorkspaceFilePath } from "../../shared/webview-nav-guard.js";

test("openUrl: ordinary web links pass", () => {
  assert.equal(safeExternalUrlString("https://pi.dev/docs"), "https://pi.dev/docs");
  assert.equal(safeExternalUrlString("http://localhost:3000/x"), "http://localhost:3000/x");
  assert.ok(safeExternalUrlString("mailto:someone@example.com"));
});

test("openUrl: editor/OS deep links are BLOCKED", () => {
  // The real vector: a markdown link the model wrote, one click from openExternal.
  assert.equal(safeExternalUrlString("vscode://ms-vscode.remote-server/x"), null);
  assert.equal(safeExternalUrlString("command:workbench.action.terminal.new"), null);
  assert.equal(safeExternalUrlString("file:///etc/passwd"), null);
  assert.equal(safeExternalUrlString("javascript:alert(1)"), null);
  assert.equal(safeExternalUrlString("data:text/html,<script>x</script>"), null);
});

test("openUrl: junk and relative values are blocked, not passed through", () => {
  assert.equal(safeExternalUrlString("not a url"), null);
  assert.equal(safeExternalUrlString("/relative/path"), null);
  assert.equal(safeExternalUrlString(""), null);
  assert.equal(safeExternalUrlString(undefined), null);
  assert.equal(safeExternalUrlString(42), null);
});

test("openUrl: scheme matching is case-insensitive", () => {
  assert.ok(safeExternalUrlString("HTTPS://pi.dev"));
  assert.equal(safeExternalUrlString("VSCode://x/y"), null);
});

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
