import * as assert from "node:assert";
import { mergeInitialHistoryEvents } from "../history-event-sync.js";

suite("Initial session history synchronization", () => {
  const initialEvents = [
    { type: "batch-start" },
    { type: "chat-message", id: "user" },
    { type: "chat-message", id: "assistant" },
    { type: "batch-end" },
  ];

  test("replays all cached history when the Webview opens after initialization", () => {
    assert.deepStrictEqual(mergeInitialHistoryEvents(initialEvents, []), initialEvents);
  });

  test("prepends events missed while the Webview was being created", () => {
    const pending = [initialEvents[2], initialEvents[3], { type: "status" }];

    assert.deepStrictEqual(
      mergeInitialHistoryEvents(initialEvents, pending),
      [...initialEvents, { type: "status" }],
    );
  });

  test("keeps cached history atomic when other events were buffered first", () => {
    const extensionEvent = { type: "extensions" };
    const pending = [extensionEvent, ...initialEvents];

    assert.deepStrictEqual(
      mergeInitialHistoryEvents(initialEvents, pending),
      [...initialEvents, extensionEvent],
    );
  });
});
