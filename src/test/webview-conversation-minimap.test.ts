import * as assert from "node:assert";
import {
  findActiveTurnIndex,
  getHoverTickWidth,
  getTurnTickPercent,
  truncateTurnPreview,
} from "../webview/components/conversation-minimap.js";

suite("Webview conversation minimap", () => {
  test("normalizes and truncates tooltip previews", () => {
    assert.strictEqual(truncateTurnPreview("  first\n\nsecond  "), "first second");
    assert.strictEqual(truncateTurnPreview("abcdefgh", 6), "abcde…");
  });

  test("selects the turn at the viewport anchor", () => {
    const positions = [40, 280, 640, 980];

    assert.strictEqual(findActiveTurnIndex(positions, 0), 0);
    assert.strictEqual(findActiveTurnIndex(positions, 500), 1);
    assert.strictEqual(findActiveTurnIndex(positions, 640), 2);
    assert.strictEqual(findActiveTurnIndex(positions, 1_200), 3);
    assert.strictEqual(findActiveTurnIndex([], 500), -1);
  });

  test("expands nearby ticks gradually around the hovered turn", () => {
    assert.deepStrictEqual(
      [0, 1, 2, 3, 4].map(getHoverTickWidth),
      [22, 16, 12, 9, 7],
    );
    assert.strictEqual(getHoverTickWidth(-2), 12);
  });

  test("distributes turn ticks across the complete minimap", () => {
    assert.strictEqual(getTurnTickPercent(0, 4), 0);
    assert.ok(Math.abs(getTurnTickPercent(1, 4) - 100 / 3) < Number.EPSILON * 100);
    assert.strictEqual(getTurnTickPercent(3, 4), 100);
    assert.strictEqual(getTurnTickPercent(0, 1), 50);
  });
});
