import * as assert from "node:assert";
import { scheduleFollowScroll, type ScrollViewport } from "../webview/render/scroll-lock.js";

suite("Webview conversation scroll lock", () => {
  test("does not snap to bottom when the user scrolls up before the frame runs", () => {
    const viewport: ScrollViewport = { scrollTop: 240, scrollHeight: 1200 };
    let following = true;
    let scheduled: (() => void) | undefined;

    scheduleFollowScroll(viewport, () => following, (callback) => {
      scheduled = callback;
    });
    following = false;
    scheduled?.();

    assert.strictEqual(viewport.scrollTop, 240);
  });

  test("follows new output while the user remains at the bottom", () => {
    const viewport: ScrollViewport = { scrollTop: 900, scrollHeight: 1200 };
    let scheduled: (() => void) | undefined;

    scheduleFollowScroll(viewport, () => true, (callback) => {
      scheduled = callback;
    });
    scheduled?.();

    assert.strictEqual(viewport.scrollTop, 1200);
  });

  test("does not schedule scrolling when history view is already locked", () => {
    const viewport: ScrollViewport = { scrollTop: 240, scrollHeight: 1200 };
    let scheduleCount = 0;

    scheduleFollowScroll(viewport, () => false, () => {
      scheduleCount++;
    });

    assert.strictEqual(scheduleCount, 0);
    assert.strictEqual(viewport.scrollTop, 240);
  });
});
