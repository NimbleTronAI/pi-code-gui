import * as assert from "node:assert";
import {
  restoreScrollAfterPrepend,
  shouldLoadOlderHistory,
} from "../webview/render/history-pagination.js";

suite("Webview history pagination", () => {
  test("loads older history only near the top while idle", () => {
    assert.strictEqual(shouldLoadOlderHistory({
      scrollTop: 80,
      hasMore: true,
      loading: false,
      streaming: false,
      inBatch: false,
    }), true);
  });

  test("does not issue duplicate or unsafe history loads", () => {
    const base = {
      scrollTop: 80,
      hasMore: true,
      loading: false,
      streaming: false,
      inBatch: false,
    };

    assert.strictEqual(shouldLoadOlderHistory({ ...base, hasMore: false }), false);
    assert.strictEqual(shouldLoadOlderHistory({ ...base, loading: true }), false);
    assert.strictEqual(shouldLoadOlderHistory({ ...base, streaming: true }), false);
    assert.strictEqual(shouldLoadOlderHistory({ ...base, inBatch: true }), false);
    assert.strictEqual(shouldLoadOlderHistory({ ...base, scrollTop: 121 }), false);
  });

  test("preserves the visible anchor after content is prepended", () => {
    const viewport = { scrollTop: 40, scrollHeight: 1_450 };

    restoreScrollAfterPrepend(viewport, 1_000, 40);

    assert.strictEqual(viewport.scrollTop, 490);
  });
});
