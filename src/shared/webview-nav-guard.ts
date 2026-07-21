// Guards for the two webview→extension messages that act on a string the WEBVIEW supplies:
// `openUrl` → vscode.env.openExternal, and `openFile` → vscode.window.showTextDocument.
//
// Both senders are blanket handlers over MODEL-RENDERED content — handlers/index.ts posts
// openUrl for any <a href> in the transcript, and render/engine.ts posts openFile for any
// element carrying data-path. So the model chooses these values, and before this an injected
// link could reach openExternal with an arbitrary scheme (e.g. a vscode: deep link) on one
// click, and an injected data-path could open any absolute file.
//
// Pure string/path logic, deliberately free of the vscode module so it is unit-testable; the
// caller converts the result to a Uri.
import * as path from "node:path";

/** Schemes allowed to leave the editor. Deliberately excludes `vscode:`/`command:`/`file:`. */
const ALLOWED_URL_SCHEMES = new Set(["http:", "https:", "mailto:"]);

/** The URL to hand to openExternal, or null if it must be blocked. */
export function safeExternalUrlString(raw: unknown): string | null {
  if (typeof raw !== "string" || !raw.trim()) { return null; }
  let parsed: URL;
  try { parsed = new URL(raw); } catch { return null; } // relative/garbage → block
  if (!ALLOWED_URL_SCHEMES.has(parsed.protocol.toLowerCase())) { return null; }
  return parsed.toString();
}

/** The absolute path to open, or null when it escapes every workspace root.
 *  `roots` are the workspace folder fsPaths; an empty list blocks everything. */
export function safeWorkspaceFilePath(raw: unknown, roots: string[]): string | null {
  if (typeof raw !== "string" || !raw.trim()) { return null; }
  if (raw.includes("\0")) { return null; }
  if (!roots.length) { return null; }
  for (const root of roots) {
    // Resolve a relative path against the root; an absolute path resolves to itself.
    const abs = path.resolve(root, raw);
    const rel = path.relative(root, abs);
    // Inside the root iff the relative path neither escapes upward nor is absolute.
    if (rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel))) { return abs; }
  }
  return null;
}
