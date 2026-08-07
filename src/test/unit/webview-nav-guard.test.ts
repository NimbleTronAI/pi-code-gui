// Tests for the openUrl / renderInline link-href guards. Both act on a string the WEBVIEW
// supplies, and both senders are blanket handlers over model-rendered content (any <a href> in
// the transcript), so the model effectively chooses these values. The openFile path guard lives
// in workspace-path-guard.test.ts (it uses `node:path`, which the webview bundle can't import).
import { test } from "node:test";
import assert from "node:assert/strict";
import { safeExternalUrlString, safeInlineLinkHref } from "../../shared/webview-nav-guard.js";

test("openUrl: ordinary web links pass", () => {
  assert.equal(safeExternalUrlString("https://pi.dev/docs"), "https://pi.dev/docs");
  assert.equal(safeExternalUrlString("http://localhost:3000/x"), "http://localhost:3000/x");
  assert.ok(safeExternalUrlString("mailto:someone@example.com"));
});

test("openUrl: editor/OS deep links are BLOCKED", () => {
  // The real vector: a markdown link the model wrote, one click from openExternal.
  assert.equal(safeExternalUrlString("vscode://ms-vscode.remote-server/x"), null);
  assert.equal(safeExternalUrlString("command:workbench.action.terminal.new"), null);
  assert.equal(safeExternalUrlString("file:///etc/passwd"), null);
  assert.equal(safeExternalUrlString("javascript:alert(1)"), null);
  assert.equal(safeExternalUrlString("data:text/html,<script>x</script>"), null);
});

test("openUrl: junk and relative values are blocked, not passed through", () => {
  assert.equal(safeExternalUrlString("not a url"), null);
  assert.equal(safeExternalUrlString("/relative/path"), null);
  assert.equal(safeExternalUrlString(""), null);
  assert.equal(safeExternalUrlString(undefined), null);
  assert.equal(safeExternalUrlString(42), null);
});

test("openUrl: scheme matching is case-insensitive", () => {
  assert.ok(safeExternalUrlString("HTTPS://pi.dev"));
  assert.equal(safeExternalUrlString("VSCode://x/y"), null);
});

// ── safeInlineLinkHref ───────────────────────────────────────────────────────
// The renderInline `link` token guard: the model chooses the href, so dangerous schemes
// (javascript:/data:/vbscript:/file:) must be neutralized before the href reaches the DOM.
// Unlike safeExternalUrlString, scheme-less refs (relative paths, anchors) ARE preserved —
// they render as links but a click is still routed through openUrl (the openExternal gate),
// which blocks them from opening. Both guards share ALLOWED_URL_SCHEMES, so `ftp` is blocked
// here just as it is at openUrl (it was previously allowed only on this path — a drift).

test("safeInlineLinkHref: allows http, https, and mailto", () => {
  assert.equal(safeInlineLinkHref("https://example.com"), "https://example.com");
  assert.equal(safeInlineLinkHref("http://example.com"), "http://example.com");
  assert.equal(safeInlineLinkHref("mailto:foo@bar.com"), "mailto:foo@bar.com");
});

test("safeInlineLinkHref: ftp is BLOCKED (matches the openUrl allowlist)", () => {
  // `ftp` was previously allowed here only — a drift the shared allowlist closes.
  assert.equal(safeInlineLinkHref("ftp://ftp.example.com"), "");
});

test("safeInlineLinkHref: allows scheme-less refs (relative paths and anchors)", () => {
  assert.equal(safeInlineLinkHref("path/to/page"), "path/to/page");
  assert.equal(safeInlineLinkHref("#section"), "#section");
  assert.equal(safeInlineLinkHref("/abs/path"), "/abs/path");
  assert.equal(safeInlineLinkHref("./rel"), "./rel");
  assert.equal(safeInlineLinkHref("../rel"), "../rel");
});

test("safeInlineLinkHref: blocks javascript: (any case)", () => {
  assert.equal(safeInlineLinkHref("javascript:alert(1)"), "");
  assert.equal(safeInlineLinkHref("JaVaScRiPt:alert(1)"), "");
});

test("safeInlineLinkHref: blocks other dangerous schemes", () => {
  assert.equal(safeInlineLinkHref("data:text/html,<script>alert(1)</script>"), "");
  assert.equal(safeInlineLinkHref("vbscript:msgbox(1)"), "");
  assert.equal(safeInlineLinkHref("file:///etc/passwd"), "");
  assert.equal(safeInlineLinkHref("vscode://ms-vscode.remote-server/x"), "");
});

test("safeInlineLinkHref: strips leading whitespace before resolving the scheme", () => {
  assert.equal(safeInlineLinkHref("   https://example.com"), "https://example.com");
  assert.equal(safeInlineLinkHref("\t\nhttps://example.com"), "https://example.com");
});

test("safeInlineLinkHref: removes embedded tab/newline that would hide a javascript: scheme", () => {
  // Browsers strip \t/\n/\r from URLs before resolving the scheme, so "java\tscript:"
  // resolves to "javascript:" — the sanitizer must too.
  assert.equal(safeInlineLinkHref("java\tscript:alert(1)"), "");
  assert.equal(safeInlineLinkHref("java\nscript:alert(1)"), "");
  assert.equal(safeInlineLinkHref("java\rscript:alert(1)"), "");
});

test("safeInlineLinkHref: returns empty for empty or whitespace-only input", () => {
  assert.equal(safeInlineLinkHref(""), "");
  assert.equal(safeInlineLinkHref("   "), "");
  assert.equal(safeInlineLinkHref("\t\n\r"), "");
});
