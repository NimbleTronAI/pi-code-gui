// Headless tests for linkifyPlain — the marked-independent linkifier used by the
// "info" status card so install-guide links are clickable even though that path never
// runs content through the markdown renderer.
import { test } from "node:test";
import assert from "node:assert/strict";
import { linkifyPlain } from "../../shared/linkify.js";

test("turns [label](https url) into an anchor", () => {
  const out = linkifyPlain("fd — [install guide](https://github.com/sharkdp/fd#installation)");
  assert.equal(out, "fd — <a href=\"https://github.com/sharkdp/fd#installation\">install guide</a>");
});

test("converts newlines to <br> and links each line", () => {
  const out = linkifyPlain("a [x](https://e.com/x)\nb [y](https://e.com/y)");
  assert.equal(out, "a <a href=\"https://e.com/x\">x</a><br>b <a href=\"https://e.com/y\">y</a>");
});

test("escapes HTML so plain text can't inject markup", () => {
  const out = linkifyPlain("<script>alert(1)</script> & \"quote\"");
  assert.ok(!out.includes("<script>"), "raw tag escaped");
  assert.match(out, /&lt;script&gt;/);
  assert.match(out, /&amp;/);
  assert.match(out, /&quot;/);
});

test("leaves non-link markdown literal (no reformatting of other info messages)", () => {
  // Bold/italic/code/paths must stay verbatim — only explicit http(s) links change.
  const out = linkifyPlain("Context compacted. see _foo_ and `bar` at /a/b_c");
  assert.equal(out, "Context compacted. see _foo_ and `bar` at /a/b_c");
});

test("only http(s) links are converted (not arbitrary [x](y))", () => {
  const out = linkifyPlain("[click](javascript:alert(1)) and [ok](https://e.com)");
  assert.ok(out.includes("[click](javascript:alert(1))"), "non-http scheme left literal");
  assert.ok(out.includes("<a href=\"https://e.com\">ok</a>"), "http link converted");
});

test("empty input -> empty string", () => {
  assert.equal(linkifyPlain(""), "");
});
