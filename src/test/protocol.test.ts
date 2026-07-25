import * as assert from "node:assert";
import { validateExtensionToWebview } from "../shared/protocol.js";

suite("Shared webview protocol", () => {
  test("accepts image content in tool results", () => {
    const result = validateExtensionToWebview({
      type: "tool-end",
      data: {
        toolCallId: "read-image",
        toolName: "read",
        result: {
          content: [
            { type: "text", text: "Read image file [image/png]" },
            { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
          ],
        },
        isError: false,
      },
    });

    assert.strictEqual(result.success, true);
  });

  test("rejects malformed image content in tool results", () => {
    const result = validateExtensionToWebview({
      type: "tool-end",
      data: {
        toolCallId: "bad-image",
        result: {
          content: [{ type: "image", data: "aW1hZ2U=" }],
        },
        isError: false,
      },
    });

    assert.strictEqual(result.success, false);
  });
});
