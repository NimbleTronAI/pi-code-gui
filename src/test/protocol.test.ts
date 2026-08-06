import * as assert from "node:assert";
import { validateExtensionToWebview, validateWebviewToExtension } from "../shared/protocol.js";

suite("Shared webview protocol", () => {
  test("accepts the Webview readiness handshake", () => {
    const result = validateWebviewToExtension({ type: "webviewReady" });

    assert.strictEqual(result.success, true);
  });

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

  test("accepts atomic lazy history pages", () => {
    const request = validateWebviewToExtension({ type: "loadOlderHistory" });
    const page = validateExtensionToWebview({
      type: "history-page",
      data: {
        hasMoreHistory: true,
        events: [
          { type: "chat-message", data: { role: "user", content: "older" } },
          { type: "assistant-start", data: { messageId: "assistant-1" } },
          { type: "stream-delta", data: { delta: "response" } },
          { type: "assistant-end", data: {} },
        ],
      },
    });

    assert.strictEqual(request.success, true);
    assert.strictEqual(page.success, true);
  });

  test("accepts complete minimap turns and targeted history loads", () => {
    const update = validateExtensionToWebview({
      type: "conversation-turns-update",
      data: {
        turns: [{ entryId: "user-entry-1", user: "Question", agent: "Answer" }],
      },
    });
    const request = validateWebviewToExtension({
      type: "loadHistoryToEntry",
      entryId: "user-entry-1",
    });

    assert.strictEqual(update.success, true);
    assert.strictEqual(request.success, true);
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
        items: [workspaceFile, {
          id: "file:///sessions/session-123.jsonl",
          path: "session:session-123",
          name: "Prior investigation",
          kind: "file",
          external: true,
          source: "session",
        }],
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
        autoCollapseToolResults: true,
        autoAttachActiveEditor: false,
      },
    });
    const toggleResult = validateWebviewToExtension({
      type: "toggleAutoAttachActiveEditor",
    });
    const collapseToggleResult = validateWebviewToExtension({
      type: "toggleAutoCollapseToolResults",
    });

    assert.strictEqual(updateResult.success, true);
    assert.strictEqual(toggleResult.success, true);
    assert.strictEqual(collapseToggleResult.success, true);
  });

  test("accepts viewport refresh requests for restored panels", () => {
    const result = validateExtensionToWebview({ type: "viewport-refresh" });

    assert.strictEqual(result.success, true);
  });

  test("accepts active capability updates", () => {
    const result = validateExtensionToWebview({
      type: "capabilities-update",
      data: {
        extensions: [
          { name: "@example/pi-tools", path: "/tmp/node_modules/@example/pi-tools/index.js" },
        ],
        skills: [{
          name: "review",
          description: "Review changes",
          path: "/tmp/skills/review/SKILL.md",
          scope: "user",
        }],
      },
    });

    assert.strictEqual(result.success, true);
  });

  test("accepts capability panel updates", () => {
    const result = validateExtensionToWebview({
      type: "capabilities-panel-update",
      data: {
        capabilities: [{
          kind: "skill",
          name: "review",
          description: "Review changes",
          path: "/tmp/skills/review/SKILL.md",
          enabled: true,
          source: "auto",
          scope: "project",
          origin: "top-level",
        }],
      },
    });

    assert.strictEqual(result.success, true);
  });

  test("accepts capability panel controls", () => {
    const listResult = validateWebviewToExtension({ type: "getCapabilities" });
    const reloadResult = validateWebviewToExtension({ type: "reloadCapabilities" });
    const toggleResult = validateWebviewToExtension({
      type: "setCapabilityEnabled",
      kind: "skill",
      path: "/tmp/skills/review/SKILL.md",
      enabled: false,
    });

    assert.strictEqual(listResult.success, true);
    assert.strictEqual(reloadResult.success, true);
    assert.strictEqual(toggleResult.success, true);
  });

  test("accepts sourced slash commands", () => {
    const result = validateExtensionToWebview({
      type: "slash-commands-update",
      data: {
        commands: [
          { cmd: "/skill:review", desc: "Review changes", source: "skill", scope: "user" },
          { cmd: "/release", desc: "Prepare release", source: "prompt", scope: "project" },
        ],
      },
    });

    assert.strictEqual(result.success, true);
  });

  test("accepts remote custom UI frames and input", () => {
    const openResult = validateExtensionToWebview({
      type: "custom-ui-open",
      data: {
        id: "custom_mcp",
        lines: ["╭─ MCP ─╮", "│ chrome-devtools │", "╰───────╯"],
        columns: 82,
        overlay: true,
        anchor: "top-center",
        maxHeight: "80%",
      },
    });
    const inputResult = validateWebviewToExtension({
      type: "custom_ui_input",
      id: "custom_mcp",
      input: "\u001b[A",
      columns: 72,
    });
    const resizeResult = validateWebviewToExtension({
      type: "custom_ui_resize",
      id: "custom_mcp",
      columns: 72,
    });

    assert.strictEqual(openResult.success, true);
    assert.strictEqual(inputResult.success, true);
    assert.strictEqual(resizeResult.success, true);
  });
});
