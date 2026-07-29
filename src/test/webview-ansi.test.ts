import * as assert from "node:assert";
import { parseAnsi } from "../webview/render/ansi.js";

suite("Webview ANSI rendering", () => {
  test("parses basic colors and text styles with resets", () => {
    const segments = parseAnsi("plain \x1b[1;36mselected\x1b[0m done");

    assert.strictEqual(segments.map((segment) => segment.text).join(""), "plain selected done");
    assert.strictEqual(segments[1].style.bold, true);
    assert.strictEqual(
      segments[1].style.foreground,
      "var(--vscode-terminal-ansiCyan, #11a8cd)",
    );
    assert.deepStrictEqual(segments[2].style, {});
  });

  test("parses 256-color and true-color SGR sequences", () => {
    const segments = parseAnsi("\x1b[38;5;196mred\x1b[48;2;1;2;3m rgb");

    assert.strictEqual(segments[0].style.foreground, "rgb(255, 0, 0)");
    assert.strictEqual(segments[1].style.foreground, "rgb(255, 0, 0)");
    assert.strictEqual(segments[1].style.background, "rgb(1, 2, 3)");
  });

  test("discards non-style terminal controls", () => {
    const segments = parseAnsi("before\x1b]0;title\x07after\x1b[2Jdone\x1b_pi:c\x07");

    assert.strictEqual(segments.map((segment) => segment.text).join(""), "beforeafterdone");
  });
});
