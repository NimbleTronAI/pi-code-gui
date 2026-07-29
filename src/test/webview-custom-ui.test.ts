import * as assert from "node:assert";
import {
  encodeCustomUiKey,
  encodeCustomUiWheel,
  fitCustomUiColumns,
  type CustomUiKeyEvent,
} from "../webview/components/custom-ui.js";

function key(
  value: string,
  modifiers: Partial<Omit<CustomUiKeyEvent, "key">> = {},
): CustomUiKeyEvent {
  return {
    key: value,
    ctrlKey: false,
    altKey: false,
    metaKey: false,
    shiftKey: false,
    ...modifiers,
  };
}

suite("Webview custom UI", () => {
  test("encodes navigation and editing keys as terminal input", () => {
    assert.strictEqual(encodeCustomUiKey(key("ArrowUp")), "\x1b[A");
    assert.strictEqual(encodeCustomUiKey(key("Enter")), "\r");
    assert.strictEqual(encodeCustomUiKey(key("Backspace")), "\x7f");
    assert.strictEqual(encodeCustomUiKey(key("Tab", { shiftKey: true })), "\x1b[Z");
  });

  test("encodes printable and control keys", () => {
    assert.strictEqual(encodeCustomUiKey(key("?", { shiftKey: true })), "?");
    assert.strictEqual(encodeCustomUiKey(key("r", { ctrlKey: true })), "\x12");
    assert.strictEqual(encodeCustomUiKey(key("x", { altKey: true })), "\x1bx");
    assert.strictEqual(encodeCustomUiKey(key("k", { metaKey: true })), null);
  });

  test("maps mouse-wheel movement to list navigation", () => {
    assert.strictEqual(encodeCustomUiWheel(10), "\x1b[B");
    assert.strictEqual(encodeCustomUiWheel(-10), "\x1b[A");
    assert.strictEqual(encodeCustomUiWheel(0), null);
  });

  test("fits width from the viewport without cumulative shrinking", () => {
    assert.strictEqual(fitCustomUiColumns(82, 800, 8), 82);
    assert.strictEqual(fitCustomUiColumns(82, 420, 8), 44);
    assert.strictEqual(fitCustomUiColumns(82, 800, 8), 82);
  });
});
