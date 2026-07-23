import * as assert from "node:assert";
import { isAllowedMarkdownLink, renderInlineTokens } from "../webview/render/markdown-inline.js";

suite("Webview markdown rendering", () => {
  test("renders links nested inside list-item text tokens", () => {
    const escape = (value: string): string => value
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/\"/g, "&quot;")
      .replace(/'/g, "&#39;");
    const rendered = renderInlineTokens([{
        type: "text",
        raw: "[GitHub](https://github.com)",
        text: "[GitHub](https://github.com)",
        tokens: [{
          type: "link",
          href: "https://github.com",
          tokens: [{ type: "text", text: "GitHub" }],
        }],
    }], escape);

    assert.strictEqual(rendered, '<a href="https://github.com">GitHub</a>');
  });

  test("allows browser-safe link schemes only", () => {
    assert.strictEqual(isAllowedMarkdownLink("https://github.com"), true);
    assert.strictEqual(isAllowedMarkdownLink("http://localhost:3000"), true);
    assert.strictEqual(isAllowedMarkdownLink("mailto:user@example.com"), true);
    assert.strictEqual(isAllowedMarkdownLink("javascript:alert(1)"), false);
    assert.strictEqual(isAllowedMarkdownLink("file:///etc/passwd"), false);
    assert.strictEqual(isAllowedMarkdownLink("./README.md"), false);
  });
});
