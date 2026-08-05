import * as assert from "node:assert";
import { extractSessionId } from "../session-reference.js";

suite("Session references", () => {
  test("extracts the session ID from a JSONL header", () => {
    assert.strictEqual(
      extractSessionId('{"type":"session","id":"session-123"}\n{"type":"message"}'),
      "session-123",
    );
  });

  test("rejects missing or malformed IDs", () => {
    assert.strictEqual(extractSessionId("not json"), undefined);
    assert.strictEqual(extractSessionId('{"type":"session"}'), undefined);
  });
});
