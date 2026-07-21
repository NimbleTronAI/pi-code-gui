// The single HTML escaper for the webview.
//
// It replaces five near-identical copies that all did `div.textContent = text; return
// div.innerHTML` — which, per the HTML serialization spec, escapes `&`, `<` and `>` but NOT
// quotes. That is safe for text nodes and WRONG for attribute values, and the webview
// interpolates into attributes constantly (`data-path="${fp}"`, `href="${t.href}"`,
// `value="${props.defaultValue}"`). With `style-src 'unsafe-inline'` in the CSP, a model-chosen
// path like `x" style="position:fixed;inset:0` was enough to paint over the whole UI. The CSP
// nonce still blocks script execution, so this was DOM/UI injection rather than RCE — but a
// spoofed credential prompt in a trusted editor surface is bad enough.
//
// Deliberately string-based rather than DOM-based: it makes the escaper pure, usable from both
// the extension host and the webview, and — unlike `document.createElement` — unit-testable
// headlessly. `&` MUST be replaced first or the other entities get double-escaped.

/** Escape text for interpolation into HTML, including attribute values (quotes included). */
export function escapeHtml(text: string): string {
  if (text === null || text === undefined) { return ""; }
  return String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
