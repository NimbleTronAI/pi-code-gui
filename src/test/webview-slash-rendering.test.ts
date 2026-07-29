import * as assert from "node:assert";
import { html } from "../webview/render/html.js";
import { renderSlashSourceLabel } from "../webview/render/slash-autocomplete.js";

function withMockDocument(run: () => void): void {
  const originalDocument = Object.getOwnPropertyDescriptor(globalThis, "document");
  const escape = (value: string): string => value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
  Object.defineProperty(globalThis, "document", {
    configurable: true,
    value: {
      createElement: () => {
        let text = "";
        return {
          set textContent(value: string | null) { text = value ?? ""; },
          get innerHTML() { return escape(text); },
        };
      },
    },
  });

  try {
    run();
  } finally {
    if (originalDocument) {
      Object.defineProperty(globalThis, "document", originalDocument);
    } else {
      delete (globalThis as { document?: Document }).document;
    }
  }
}

suite("Webview slash command rendering", () => {
  test("renders source badges as markup instead of literal text", () => {
    withMockDocument(() => {
      const rendered = html`<div>${renderSlashSourceLabel("[u] extension")}</div>`;

      assert.strictEqual(
        rendered,
        '<div><span class="slash-source">[u] extension</span></div>',
      );
      assert.ok(!rendered.includes("&lt;span"));
    });
  });

  test("escapes source label text inside the trusted badge", () => {
    withMockDocument(() => {
      const rendered = html`<div>${renderSlashSourceLabel("<img src=x>")}</div>`;

      assert.ok(rendered.includes("&lt;img src=x&gt;"));
      assert.ok(!rendered.includes("<img"));
    });
  });
});
