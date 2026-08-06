import * as assert from "node:assert";
import {
  getTurnTickPercent,
  truncateTurnPreview,
} from "../webview/components/conversation-minimap.js";

suite("Webview conversation minimap", () => {
  test("normalizes and truncates tooltip previews", () => {
    assert.strictEqual(truncateTurnPreview("  first\n\nsecond  "), "first second");
    assert.strictEqual(truncateTurnPreview("abcdefgh", 6), "abcde…");
  });

  test("distributes turn ticks across the complete minimap", () => {
    assert.strictEqual(getTurnTickPercent(0, 4), 0);
    assert.ok(Math.abs(getTurnTickPercent(1, 4) - 100 / 3) < Number.EPSILON * 100);
    assert.strictEqual(getTurnTickPercent(3, 4), 100);
    assert.strictEqual(getTurnTickPercent(0, 1), 50);
  });
});
