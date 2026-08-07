// Workspace path guard for the `openFile` webview→extension message.
// `openFile` → vscode.window.showTextDocument, acting on a `data-path` the WEBVIEW supplies
// (render/engine.ts posts openFile for any element carrying data-path), so the model chooses
// the value; before this an injected data-path could open any absolute file. Containment-checked
// here against the workspace roots.
//
// Split from webview-nav-guard.ts (which holds the URL guards) because this uses `node:path`,
// and webview-nav-guard.ts is imported by the WEBVIEW bundle (esbuild.webview.js, browser
// platform) for safeInlineLinkHref — a `node:` import there breaks the browser bundle. This
// file is imported only by the extension-host (webview-panel.ts), which bundles for node.
//
// Pure path logic, deliberately free of the vscode module so it is unit-testable; the caller
// converts the result to a Uri.
import * as path from "node:path";

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
