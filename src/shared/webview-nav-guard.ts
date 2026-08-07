// URL guards for strings the WEBVIEW renders or posts that the model effectively chooses.
// Two call sites share ONE allowlist (`ALLOWED_URL_SCHEMES`) so they can never drift on
// which absolute schemes are permitted:
//   `openUrl`         → vscode.env.openExternal ........... safeExternalUrlString (absolute-only)
//   renderInline link → <a href="..."> .................. safeInlineLinkHref (allows scheme-less refs)
//
// Both functions are reached by blanket handlers over MODEL-RENDERED content — handlers/index.ts
// posts openUrl for any <a href> in the transcript, and render/engine.ts calls safeInlineLinkHref
// for the `link` token — so the model chooses these values, and before this an injected link could
// reach openExternal with an arbitrary scheme (e.g. a vscode: deep link) on one click. The
// renderInline href guard neutralizes dangerous schemes (javascript:/data:/vbscript:/file:) in the
// model's own markdown links before they reach the DOM; scheme-less refs (relative paths, anchors)
// are preserved as links — a click is still routed through openUrl, which is the actual openExternal
// gate, so they can't open anything the allowlist disallows.
//
// This module is imported by BOTH bundles — the extension-host (esbuild.js, platform node) and the
// webview (esbuild.webview.js, platform browser) — so it is deliberately dependency-free and
// browser-safe (no `node:` imports). The `openFile` path guard (`safeWorkspaceFilePath`) lives in
// workspace-path-guard.ts because it needs `node:path` and the webview bundle must not pull that in.

/** Schemes allowed to leave the editor. Deliberately excludes `vscode:`/`command:`/`file:`/`ftp:`.
 *  Shared by safeExternalUrlString and safeInlineLinkHref so the two call sites agree. */
const ALLOWED_URL_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** The URL to hand to openExternal, or null if it must be blocked. */
export function safeExternalUrlString(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) { return null; }
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return null; } // relative/garbage → block
  if (!ALLOWED_URL_SCHEMES.has(parsed.protocol.toLowerCase())) { return null; }
  return parsed.toString();
}

/** The href to write into a markdown link's `<a href="...">`, or "" when the scheme is disallowed.
 *
 *  Used by renderInline (render/engine.ts) for the model-authored `link` token. Unlike
 *  safeExternalUrlString (which serves openExternal and blocks relative/garbage), this PRESERVES
 *  scheme-less refs (relative paths, anchors) so legitimate markdown links keep rendering — a
 *  click is still routed through openUrl, which is the actual openExternal gate. Both functions
 *  share `ALLOWED_URL_SCHEMES`, so the set of allowed absolute schemes is identical.
 *
 *  Browsers ignore leading control/whitespace and strip tab/newline chars when resolving a
 *  scheme, so those are removed first to prevent hiding a `javascript:` URL
 *  (e.g. `java\tscript:alert(1)` resolves to `javascript:alert(1)`). */
export function safeInlineLinkHref(raw: string): string {
  const s = (raw || "")
    .replace(/[\t\n\r]/g, "")
    .replace(/^[\x00-\x20]+/, "")
    .replace(/[\x00-\x20]+$/, "");
  if (!s) { return ""; }
  const schemeMatch = s.match(/^([a-zA-Z][a-zA-Z0-9+.\-]*):/);
  if (schemeMatch && !ALLOWED_URL_SCHEMES.has(schemeMatch[1].toLowerCase() + ":")) {
    return "";
  }
  return s;
}
