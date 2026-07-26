import * as assert from "node:assert";
import { shouldAutoCollapseToolText } from "../webview/tools/collapse.js";

suite("Webview tool output collapsing", () => {
  test("keeps short tool output expanded", () => {
    assert.strictEqual(shouldAutoCollapseToolText("line 1\nline 2"), false);
  });

  test("collapses output that exceeds the line preview", () => {
    const output = Array.from({ length: 25 }, (_, index) => `line ${index + 1}`).join("\n");
    assert.strictEqual(shouldAutoCollapseToolText(output), true);
  });

  test("collapses very long single-line output", () => {
    assert.strictEqual(shouldAutoCollapseToolText("x".repeat(4_001)), true);
  });
});
