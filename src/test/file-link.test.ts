import * as assert from "node:assert";
import * as path from "node:path";
import { resolveFileLinkPath } from "../file-link.js";

suite("File link resolution", () => {
  test("resolves relative tool paths from the workspace root", () => {
    const workspaceRoot = path.resolve("workspace-root");

    const resolved = resolveFileLinkPath(".agents/skills/example/SKILL.md", workspaceRoot);

    assert.strictEqual(
      resolved,
      path.resolve(workspaceRoot, ".agents/skills/example/SKILL.md"),
    );
  });

  test("keeps native absolute paths unchanged", () => {
    const absolutePath = path.resolve("workspace-root", "src", "file.ts");

    assert.strictEqual(resolveFileLinkPath(absolutePath, path.resolve("other-root")), absolutePath);
  });

  test("recognizes Windows absolute paths on every host platform", () => {
    const absolutePath = "C:\\workspace\\src\\file.ts";

    assert.strictEqual(resolveFileLinkPath(absolutePath, "/other-root"), absolutePath);
  });

  test("rejects empty paths", () => {
    assert.throws(
      () => resolveFileLinkPath("   ", path.resolve("workspace-root")),
      /path is empty/,
    );
  });
});
