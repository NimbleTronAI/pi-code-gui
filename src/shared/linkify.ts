// Minimal, DOM- and marked-independent linkifier for plain-text webview surfaces
// (the "info" status card) that must stay literal text but want clickable links.
//
// Why this exists: the "info" custom-message path renders its content as escaped plain
// text (never through the markdown renderer), so an install-guide URL — bare or as
// [label](url) — showed up as dead text / literal `[]()`. A full markdown render there
// would reformat every other info message (paths with `_` italicised, etc.); instead we
// ONLY turn explicit http(s) markdown links into anchors. The webview's global click
// handler then routes anchor clicks to vscode.env.openExternal (the `openUrl` command).
//
// Safety: escape &<>" FIRST, then match links on the escaped string — a matched url or
// label can't break out of the href attribute. Only http(s) URLs are linkified.
export function linkifyPlain(text: string): string {
  if (!text) { return ""; }
  const escaped = text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
  return escaped
    .replace(/\[([^\]]+)\]\((https?:\/\/[^\s)"]+)\)/g, "<a href=\"$2\">$1</a>")
    .replace(/\n/g, "<br>");
}
