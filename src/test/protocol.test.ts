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

  test("accepts visible editor context updates and prompt selections", () => {
    const item = {
      id: "file:///workspace/src/index.ts",
      path: "src/index.ts",
      name: "index.ts",
      languageId: "typescript",
      active: true,
      dirty: true,
      selectionLines: 4,
    };
    const updateResult = validateExtensionToWebview({
      type: "editor-context-update",
      data: { items: [item] },
    });
    const promptResult = validateWebviewToExtension({
      type: "prompt",
      text: "Refactor this",
      editorContext: {
        includedEditorIds: [item.id],
        attachedFileIds: ["file:///workspace/package.json"],
      },
    });
    const searchRequest = validateWebviewToExtension({
      type: "requestWorkspaceFiles",
      query: "package",
    });
    const workspaceFile = {
      id: "file:///workspace/package.json",
      path: "package.json",
      name: "package.json",
    };
    const searchResult = validateExtensionToWebview({
      type: "workspace-files-update",
      data: {
        query: "package",
        items: [workspaceFile],
      },
    });
    const attachResult = validateExtensionToWebview({
      type: "attach-workspace-file",
      data: workspaceFile,
    });

    assert.strictEqual(updateResult.success, true);
    assert.strictEqual(promptResult.success, true);
    assert.strictEqual(searchRequest.success, true);
    assert.strictEqual(searchResult.success, true);
    assert.strictEqual(attachResult.success, true);
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

  test("accepts native file and folder attachment requests", () => {
    const fileResult = validateWebviewToExtension({
      type: "browseContextAttachments",
      kind: "file",
    });
    const folderResult = validateWebviewToExtension({
      type: "browseContextAttachments",
      kind: "folder",
    });

    assert.strictEqual(fileResult.success, true);
    assert.strictEqual(folderResult.success, true);
  });

  test("accepts active editor attachment settings", () => {
    const updateResult = validateExtensionToWebview({
      type: "settings-update",
      data: {
        autoCompaction: true,
        autoRetry: true,
        showImages: true,
        autoAttachActiveEditor: false,
      },
    });
    const toggleResult = validateWebviewToExtension({
      type: "toggleAutoAttachActiveEditor",
    });

    assert.strictEqual(updateResult.success, true);
    assert.strictEqual(toggleResult.success, true);
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
