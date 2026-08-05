// Tests for the shared HTML escaper. The five DOM-based copies this replaced could not be
// unit-tested at all (they needed `document`), which is precisely why the missing quote-escape
// survived: `div.textContent = x; return div.innerHTML` escapes & < > but NOT " or '.
import { test } from "node:test";
import assert from "node:assert/strict";
import { escapeHtml } from "../../shared/escape-html.js";

test("escapes the three text-node characters", () => {
  assert.equal(escapeHtml("a & b"), "a &amp; b");
  assert.equal(escapeHtml("<script>"), "&lt;script&gt;");
});

test("escapes QUOTES — the bug the DOM-based escapers had", () => {
  assert.equal(escapeHtml('a"b'), "a&quot;b");
  assert.equal(escapeHtml("a'b"), "a&#39;b");
});

test("ampersand is escaped FIRST (no double-escaping of the other entities)", () => {
  assert.equal(escapeHtml("<"), "&lt;");
  assert.equal(escapeHtml("&lt;"), "&amp;lt;", "a literal &lt; stays literal, not decoded");
  assert.equal(escapeHtml('&"'), "&amp;&quot;");
});

test("an attribute break-out is neutralised", () => {
  // The real vector: a model-chosen file path interpolated into data-path="${fp}".
  const hostile = 'note.txt" style="position:fixed;inset:0;z-index:9999" x="';
  const attr = `<span data-path="${escapeHtml(hostile)}">`;
  assert.ok(!/style=/.test(attr.replace(/&quot;/g, "")) || !attr.includes('" style='), "no attribute break-out");
  assert.ok(!attr.includes('data-path="note.txt" style='), "the injected attribute did not materialise");
  assert.ok(attr.includes("&quot;"), "quotes are entity-encoded");
});

test("null / undefined / non-strings degrade to a safe string", () => {
  assert.equal(escapeHtml(null as unknown as string), "");
  assert.equal(escapeHtml(undefined as unknown as string), "");
  assert.equal(escapeHtml(42 as unknown as string), "42");
});

test("ordinary text is unchanged", () => {
  assert.equal(escapeHtml("plain text 123"), "plain text 123");
  assert.equal(escapeHtml(""), "");
});
