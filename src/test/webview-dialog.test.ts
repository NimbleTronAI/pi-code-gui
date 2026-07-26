import * as assert from "node:assert";
import {
  dialogQuestionStem,
  isCustomDialogOption,
  parseDialogOption,
  parseDialogPrompt,
} from "../webview/components/dialog.js";

suite("Webview inline extension questions", () => {
  test("splits questionnaire headers from prompts", () => {
    assert.deepStrictEqual(
      parseDialogPrompt("[方案选择] 请选择一个方案？"),
      { header: "方案选择", question: "请选择一个方案？" },
    );
    assert.deepStrictEqual(
      parseDialogPrompt("Choose a model"),
      { question: "Choose a model" },
    );
  });

  test("parses numbered option labels and descriptions", () => {
    assert.deepStrictEqual(
      parseDialogOption("1. 方案 A — 优先快速实现，采用最小改动。"),
      {
        index: "1",
        label: "方案 A",
        description: "优先快速实现，采用最小改动。",
      },
    );
    assert.deepStrictEqual(
      parseDialogOption("4. Type something."),
      { index: "4", label: "Type something.", description: undefined },
    );
  });

  test("recognizes custom-answer sentinels and matches their follow-up", () => {
    assert.strictEqual(isCustomDialogOption("4. Type something."), true);
    assert.strictEqual(isCustomDialogOption("4. 输入内容"), true);
    assert.strictEqual(isCustomDialogOption("3. 方案 C"), false);
    assert.strictEqual(
      dialogQuestionStem("[方案选择] 请选择一个方案？\n\nType your answer:"),
      "请选择一个方案？",
    );
  });
});
