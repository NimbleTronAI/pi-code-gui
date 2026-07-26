import * as assert from "node:assert";
import {
  findNextUserMessageIndex,
  findPreviousUserMessageIndex,
} from "../webview/components/scroll-jump-controls.js";

suite("Webview conversation jump controls", () => {
  const positions = [40, 280, 640, 980];

  test("finds the first user message below the top", () => {
    assert.strictEqual(findNextUserMessageIndex(positions, 0), 0);
    assert.strictEqual(findPreviousUserMessageIndex(positions, 0), -1);
  });

  test("moves between user messages relative to the viewport", () => {
    assert.strictEqual(findPreviousUserMessageIndex(positions, 500), 1);
    assert.strictEqual(findNextUserMessageIndex(positions, 500), 2);
  });

  test("does not select the message already aligned with the viewport", () => {
    assert.strictEqual(findPreviousUserMessageIndex(positions, 640), 1);
    assert.strictEqual(findNextUserMessageIndex(positions, 640), 3);
  });

  test("reports boundaries at the end of the conversation", () => {
    assert.strictEqual(findPreviousUserMessageIndex(positions, 1_200), 3);
    assert.strictEqual(findNextUserMessageIndex(positions, 1_200), -1);
  });
});
