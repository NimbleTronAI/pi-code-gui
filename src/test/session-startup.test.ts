import * as assert from "node:assert";
import { shouldRevealSessionPanel } from "../session-startup.js";

suite("Session startup restoration", () => {
  test("reveals sessions that were open when VS Code closed", () => {
    assert.strictEqual(shouldRevealSessionPanel({
      restoringPreviouslyOpenSession: true,
      autoOpenNewSession: false,
    }), true);
  });

  test("does not reveal a new session unless auto-open is enabled", () => {
    assert.strictEqual(shouldRevealSessionPanel({
      restoringPreviouslyOpenSession: false,
      autoOpenNewSession: false,
    }), false);
    assert.strictEqual(shouldRevealSessionPanel({
      restoringPreviouslyOpenSession: false,
      autoOpenNewSession: true,
    }), true);
  });
});
