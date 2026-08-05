import * as assert from "node:assert";
import { formatLineChangeSummary, summarizeLineChanges } from "../tool-change-summary.js";

suite("Tool change summaries", () => {
  test("counts new file lines as additions", () => {
    assert.deepStrictEqual(summarizeLineChanges("", "one\ntwo\n"), {
      additions: 2,
      deletions: 0,
    });
  });

  test("counts replacements against the original content", () => {
    assert.deepStrictEqual(summarizeLineChanges("keep\nold\ntail\n", "keep\nnew one\nnew two\ntail\n"), {
      additions: 2,
      deletions: 1,
    });
    assert.strictEqual(
      formatLineChangeSummary("keep\nold\ntail\n", "keep\nnew one\nnew two\ntail\n"),
      "+2 −1",
    );
  });

  test("counts only changed lines inside an edit block", () => {
    assert.deepStrictEqual(
      summarizeLineChanges("first\nsecond\nthird\nfourth", "first\nsecond changed\nthird\nfourth"),
      { additions: 1, deletions: 1 },
    );
  });

  test("does not count unchanged lines", () => {
    assert.deepStrictEqual(summarizeLineChanges("same\n", "same\n"), {
      additions: 0,
      deletions: 0,
    });
  });
});
