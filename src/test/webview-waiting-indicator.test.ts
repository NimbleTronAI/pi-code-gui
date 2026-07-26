import * as assert from "node:assert";
import {
  nextWaitingFrame,
  PI_TUI_SPINNER_FRAMES,
  shouldKeepWaitingIndicator,
  shouldPlaceWaitingIndicatorAfterMessage,
  shouldShowFollowUpHint,
  shouldShowPromptWaitingIndicator,
} from "../webview/render/waiting-indicator.js";

suite("Webview prompt waiting indicator", () => {
  test("shows immediately for a new idle prompt but not for queued or steering prompts", () => {
    assert.strictEqual(shouldShowPromptWaitingIndicator(false, "Fix this"), true);
    assert.strictEqual(shouldShowPromptWaitingIndicator(true, "Next task"), false);
  });

  test("waits for agent lifecycle events before showing for slash commands", () => {
    assert.strictEqual(shouldShowPromptWaitingIndicator(false, "/name New title"), false);
    assert.strictEqual(shouldShowPromptWaitingIndicator(false, "  /compact"), false);
  });

  test("places a pending indicator after the echoed user message", () => {
    assert.strictEqual(shouldPlaceWaitingIndicatorAfterMessage("user"), true);
    assert.strictEqual(shouldPlaceWaitingIndicatorAfterMessage("assistant"), false);
  });

  test("shows the follow-up hint only while working with non-empty input", () => {
    assert.strictEqual(shouldShowFollowUpHint(true, "next task"), true);
    assert.strictEqual(shouldShowFollowUpHint(true, "  \n "), false);
    assert.strictEqual(shouldShowFollowUpHint(false, "next task"), false);
  });

  test("uses Pi TUI spinner frames while the agent is active", () => {
    assert.deepStrictEqual(PI_TUI_SPINNER_FRAMES, ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"]);
    assert.strictEqual(nextWaitingFrame(0), 1);
    assert.strictEqual(nextWaitingFrame(9), 0);
    assert.strictEqual(shouldKeepWaitingIndicator("assistant-start"), true);
    assert.strictEqual(shouldKeepWaitingIndicator("stream-delta"), true);
    assert.strictEqual(shouldKeepWaitingIndicator("tool-start"), true);
    assert.strictEqual(shouldKeepWaitingIndicator("agent-end"), false);
    assert.strictEqual(shouldKeepWaitingIndicator("error"), false);
  });
});
