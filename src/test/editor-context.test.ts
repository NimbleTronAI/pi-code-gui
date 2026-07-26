import * as assert from "node:assert";
import {
  appendEditorContext,
  splitEditorContext,
  truncateUtf8,
  type PromptEditorContext,
} from "../editor-context.js";

suite("Editor context", () => {
  const context: PromptEditorContext = {
    items: [{
      id: "file:///workspace/src/index.ts",
      path: "src/index.ts",
      name: "index.ts",
      languageId: "typescript",
      active: true,
      dirty: true,
      selectionLines: 3,
    }, {
      id: "file:///outside/reference",
      path: "/outside/reference",
      name: "reference",
      languageId: "",
      active: false,
      dirty: false,
      attached: true,
      kind: "folder",
      external: true,
    }],
    activeDocument: {
      id: "file:///workspace/src/index.ts",
      path: "src/index.ts",
      languageId: "typescript",
      source: "selection",
      content: "const answer = 42;",
      truncated: false,
    },
    attachedDocuments: [{
      id: "file:///workspace/package.json",
      path: "package.json",
      languageId: "json",
      source: "document",
      content: "{\"name\":\"demo\"}",
      truncated: false,
    }],
    attachedDirectories: [{
      id: "file:///outside/reference",
      path: "/outside/reference",
      entries: ["README.md", "src/", "src/index.ts"],
      truncated: false,
    }],
  };

  test("appends model context and restores the visible prompt", () => {
    const modelPrompt = appendEditorContext("Explain this", context);
    const split = splitEditorContext(modelPrompt);

    assert.ok(modelPrompt.includes("<pi-on-code-editor-context>"));
    assert.strictEqual(split.text, "Explain this");
    assert.deepStrictEqual(split.context, context);
  });

  test("leaves malformed context markers visible", () => {
    const prompt = "Hello\n\n<pi-on-code-editor-context>\nnot-json\n</pi-on-code-editor-context>";
    assert.deepStrictEqual(splitEditorContext(prompt), { text: prompt });
  });

  test("limits UTF-8 editor content by byte size", () => {
    const result = truncateUtf8("1234世界", 7);

    assert.strictEqual(result.truncated, true);
    assert.ok(Buffer.byteLength(result.text, "utf8") <= 7);
  });
});
