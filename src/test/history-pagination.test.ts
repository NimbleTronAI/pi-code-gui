import * as assert from "node:assert";
import {
  findHistoryPageStart,
  isVisibleHistoryEntry,
} from "../history-pagination.js";

suite("Session history pagination", () => {
  test("counts only entries that render conversation content", () => {
    const entries = [
      { type: "message", message: { role: "user" } },
      { type: "model_change" },
      { type: "message", message: { role: "assistant" } },
      { type: "message", message: { role: "toolResult" } },
      { type: "compaction" },
      { type: "message", message: { role: "user" } },
    ];

    assert.strictEqual(findHistoryPageStart(entries, entries.length, 2), 4);
    assert.strictEqual(findHistoryPageStart(entries, 4, 2), 0);
  });

  test("returns zero when fewer than one page remains", () => {
    const entries = [
      { type: "session" },
      { type: "message", message: { role: "user" } },
    ];

    assert.strictEqual(findHistoryPageStart(entries, entries.length, 20), 0);
  });

  test("recognizes only entries rendered in the transcript", () => {
    for (const role of ["user", "assistant", "bashExecution"]) {
      assert.strictEqual(isVisibleHistoryEntry({ type: "message", message: { role } }), true);
    }
    assert.strictEqual(
      isVisibleHistoryEntry({ type: "message", message: { role: "custom", display: true } }),
      true,
    );
    assert.strictEqual(
      isVisibleHistoryEntry({ type: "message", message: { role: "custom", customType: "info" } }),
      true,
    );
    assert.strictEqual(
      isVisibleHistoryEntry({ type: "message", message: { role: "custom", customType: "pi-on-code.active-tools" } }),
      false,
    );
    assert.strictEqual(
      isVisibleHistoryEntry({ type: "message", message: { role: "toolResult" } }),
      false,
    );
  });

  test("rejects non-positive page sizes", () => {
    assert.throws(() => findHistoryPageStart([], 0, 0), /must be positive/);
  });
});
