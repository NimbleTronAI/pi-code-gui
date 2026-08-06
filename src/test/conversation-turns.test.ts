import * as assert from "node:assert";
import {
  buildConversationTurnPreviews,
  truncateConversationTurnPreview,
} from "../conversation-turns.js";

suite("Conversation turn previews", () => {
  test("builds every user turn and aggregates assistant text only", () => {
    const turns = buildConversationTurnPreviews([
      {
        id: "user-1",
        type: "message",
        message: { role: "user", content: [{ type: "text", text: "First question" }] },
      },
      {
        id: "assistant-thinking",
        type: "message",
        message: {
          role: "assistant",
          content: [
            { type: "thinking", thinking: "private reasoning" },
            { type: "toolCall", name: "read", id: "tool-1" },
          ],
        },
      },
      {
        id: "assistant-1",
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "First answer" }] },
      },
      {
        id: "user-2",
        type: "message",
        message: { role: "user", content: "Second question" },
      },
      {
        id: "assistant-2",
        type: "message",
        message: { role: "assistant", content: [{ type: "text", text: "Second answer" }] },
      },
    ]);

    assert.deepStrictEqual(turns, [
      { entryId: "user-1", user: "First question", agent: "First answer" },
      { entryId: "user-2", user: "Second question", agent: "Second answer" },
    ]);
  });

  test("indexes turns beyond the initial history page", () => {
    const entries = Array.from({ length: 35 }, (_, index) => [
      {
        id: `user-${index}`,
        type: "message",
        message: { role: "user", content: `Question ${index}` },
      },
      {
        id: `assistant-${index}`,
        type: "message",
        message: { role: "assistant", content: `Answer ${index}` },
      },
    ]).flat();

    const turns = buildConversationTurnPreviews(entries);

    assert.strictEqual(turns.length, 35);
    assert.deepStrictEqual(turns[0], {
      entryId: "user-0",
      user: "Question 0",
      agent: "Answer 0",
    });
    assert.deepStrictEqual(turns.at(-1), {
      entryId: "user-34",
      user: "Question 34",
      agent: "Answer 34",
    });
  });

  test("removes serialized editor context from user previews", () => {
    const turns = buildConversationTurnPreviews([{
      id: "user-context",
      type: "message",
      message: {
        role: "user",
        content: "Visible prompt\n\n<pi-on-code-editor-context>\n{\"items\":[]}\n</pi-on-code-editor-context>",
      },
    }]);

    assert.strictEqual(turns[0]?.user, "Visible prompt");
  });

  test("limits full-history payload text", () => {
    const preview = truncateConversationTurnPreview("x".repeat(900));

    assert.strictEqual(preview.length, 700);
    assert.ok(preview.endsWith("…"));
  });
});
