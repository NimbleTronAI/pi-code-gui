import * as assert from "node:assert";
import { selectToolOutputCopyText } from "../tool-output-copy.js";

suite("Tool output copy", () => {
  test("prefers displayed tool content over an SDK summary", () => {
    assert.strictEqual(
      selectToolOutputCopyText(["- old\n+ new", "Successfully replaced text"], "Successfully replaced text"),
      "- old\n+ new",
    );
  });

  test("uses the SDK output when no rendered content exists", () => {
    assert.strictEqual(selectToolOutputCopyText(["", null], "raw output"), "raw output");
  });
});
