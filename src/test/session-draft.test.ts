import * as assert from "node:assert";
import { findReusableDraft, shouldPromoteDraft } from "../session-draft.js";

suite("Draft session lifecycle", () => {
  test("reuses the existing open draft", () => {
    const sessions = [
      { id: "ready", draft: false, closed: false },
      { id: "draft", draft: true, closed: false },
      { id: "closed", draft: true, closed: true },
    ];
    assert.strictEqual(findReusableDraft(sessions)?.id, "draft");
  });

  test("promotes only prompts that can become user messages", () => {
    assert.strictEqual(shouldPromoteDraft("hello"), true);
    assert.strictEqual(shouldPromoteDraft(""), true);
    assert.strictEqual(shouldPromoteDraft("  /model"), false);
  });
});
