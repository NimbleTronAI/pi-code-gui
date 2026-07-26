import * as assert from "node:assert";
import {
  findWorkspaceFileMention,
  removeWorkspaceFileMention,
} from "../webview/file-mention.js";

suite("Webview workspace file mentions", () => {
  test("finds @ queries only when they are the entire input", () => {
    assert.deepStrictEqual(findWorkspaceFileMention("@src/ext", 8), {
      start: 0,
      query: "src/ext",
    });
    assert.strictEqual(findWorkspaceFileMention("explain @package", 16), undefined);
    assert.strictEqual(findWorkspaceFileMention("@src/ext later", 8), undefined);
  });

  test("does not treat email addresses as file mentions", () => {
    assert.strictEqual(findWorkspaceFileMention("user@example.com", 16), undefined);
  });

  test("removes the accepted mention while preserving surrounding text", () => {
    assert.deepStrictEqual(removeWorkspaceFileMention("explain @src/a.ts please", 8, 17), {
      text: "explain please",
      cursor: 8,
    });
  });
});
