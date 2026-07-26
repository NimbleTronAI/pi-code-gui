import * as assert from "node:assert";
import { validateExtensionToWebview, validateWebviewToExtension } from "../shared/protocol.js";

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

  test("accepts follow-up queue replacements", () => {
    const result = validateWebviewToExtension({
      type: "replaceFollowUpQueue",
      messages: ["second", "first"],
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

  test("accepts active extension updates", () => {
    const result = validateExtensionToWebview({
      type: "extensions-update",
      data: {
        extensions: [
          { name: "@example/pi-tools", path: "/tmp/node_modules/@example/pi-tools/index.js" },
        ],
      },
    });

    assert.strictEqual(result.success, true);
  });

  test("accepts extension panel updates", () => {
    const result = validateExtensionToWebview({
      type: "extensions-panel-update",
      data: {
        extensions: [{
          name: "demo",
          path: "/tmp/demo-extension.js",
          enabled: true,
          source: "auto",
          scope: "project",
          origin: "top-level",
        }],
      },
    });

    assert.strictEqual(result.success, true);
  });

  test("accepts extension panel controls", () => {
    const listResult = validateWebviewToExtension({ type: "getExtensions" });
    const reloadResult = validateWebviewToExtension({ type: "reloadExtensions" });
    const toggleResult = validateWebviewToExtension({
      type: "setExtensionEnabled",
      path: "/tmp/demo-extension.js",
      enabled: false,
    });

    assert.strictEqual(listResult.success, true);
    assert.strictEqual(reloadResult.success, true);
    assert.strictEqual(toggleResult.success, true);
  });
});
