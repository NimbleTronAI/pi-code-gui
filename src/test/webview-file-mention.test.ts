import * as assert from "node:assert";
import {
  findWorkspaceFileMention,
  removeWorkspaceFileMention,
} from "../webview/file-mention.js";

suite("Webview workspace file mentions", () => {
  test("finds @ queries at the start or after whitespace", () => {
    assert.deepStrictEqual(findWorkspaceFileMention("@src/ext", 8), {
      start: 0,
      query: "src/ext",
    });
    assert.deepStrictEqual(findWorkspaceFileMention("explain @package", 16), {
      start: 8,
      query: "package",
    });
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
