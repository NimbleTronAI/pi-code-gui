import * as assert from "node:assert";
import { html } from "../webview/render/html.js";
import {
  filterSlashCommands,
  getSlashCommandFilter,
  renderSlashSourceLabel,
} from "../webview/render/slash-autocomplete.js";

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
  test("matches command substrings, skill names, and descriptions", () => {
    const commands = [
      { cmd: "/skill:karpathy-guidelines", desc: "Apply coding guidelines" },
      { cmd: "/mcp-auth", desc: "Authenticate an MCP server" },
      { cmd: "/release", desc: "Prepare Marketplace publishing" },
    ];

    assert.deepStrictEqual(
      filterSlashCommands(commands, "/guidelines").map((command) => command.cmd),
      ["/skill:karpathy-guidelines"],
    );
    assert.deepStrictEqual(
      filterSlashCommands(commands, "/skill:karpathy").map((command) => command.cmd),
      ["/skill:karpathy-guidelines"],
    );
    assert.deepStrictEqual(
      filterSlashCommands(commands, "/publishing").map((command) => command.cmd),
      ["/release"],
    );
  });

  test("ranks command-name matches ahead of description matches", () => {
    const commands = [
      { cmd: "/mcp-auth", desc: "Authenticate an MCP server" },
      { cmd: "/fix-diagnostics", desc: "Fix all diagnostics in open file" },
      { cmd: "/explain-code", desc: "Explain code at current cursor position" },
      { cmd: "/skill:karpathy-guidelines", desc: "Behavioral guidelines" },
      { cmd: "/new", desc: "Start a new session" },
      { cmd: "/resume", desc: "Resume a previous session" },
    ];

    assert.deepStrictEqual(
      filterSlashCommands(commands, "/n").map((command) => command.cmd),
      [
        "/new",
        "/fix-diagnostics",
        "/explain-code",
        "/skill:karpathy-guidelines",
        "/mcp-auth",
        "/resume",
      ],
    );
  });

  test("keeps autocomplete active for skill separators", () => {
    assert.strictEqual(getSlashCommandFilter("/skill:karpathy-guidelines"), "/skill:karpathy-guidelines");
    assert.strictEqual(getSlashCommandFilter("/skill:karpathy guidelines"), null);
    assert.strictEqual(getSlashCommandFilter("//skill"), null);
  });

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
