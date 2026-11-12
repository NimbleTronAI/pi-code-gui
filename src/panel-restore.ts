// Pure, vscode-free planning for reviving a session panel from the state VS Code
// persisted for it (via the webview's setState → WebviewPanelSerializer). Kept
// separate from extension.ts so the decision logic is headlessly unit-testable.
export interface PanelRestorePlan {
  /** "open" = re-attach the on-disk session; "fresh" = the panel never had a
   *  persisted session file (nothing hit disk), so an equivalent fresh session is
   *  the correct restoration; "dispose" = close the revived panel instead of
   *  resurrecting it — the session file is gone, or it belongs to a runtime this
   *  version no longer runs. */
  action: "open" | "fresh" | "dispose";
  openPath?: string;
  /** Set when an earlier version saved the panel for a runtime this version no longer has: the
   *  session's file, left untouched. */
  retiredSessionFile?: string;
}

/** Decide what to do with a revived panel given its persisted state. `state` is
 *  whatever the webview last setState()'d — treat it as untrusted (old extension
 *  versions persisted other shapes, e.g. the step-0 probe). */
export function planPanelRestore(
  state: unknown,
  fileExists: (p: string) => boolean,
): PanelRestorePlan {
  const s = (state && typeof state === "object" ? state : {}) as { sessionFilePath?: unknown; runtime?: unknown };
  const p = typeof s.sessionFilePath === "string" && s.sessionFilePath.length > 0 ? s.sessionFilePath : null;
  // Earlier versions also saved the runtime a panel ran on: "typescript" (the one this version
  // runs) or the name of a second runtime this version no longer has. Opening such a session's
  // file here would migrate and rewrite it, so close the panel and leave the file exactly as it
  // is. This version saves no runtime, so its own panels never match.
  if (s.runtime !== undefined && s.runtime !== "typescript") { return p ? { action: "dispose", retiredSessionFile: p } : { action: "dispose" }; }
  if (!p) { return { action: "fresh" }; }
  if (!fileExists(p)) { return { action: "dispose" }; }
  return { action: "open", openPath: p };
}

/** Where a newly opened chat should go. Pure so the setting's parsing is tested without vscode.
 *
 *  "beside" reproduces the historical behaviour and stays the default; "active" opens the chat
 *  as a tab in the group the user is already in. Anything unrecognised (a hand-edited
 *  settings.json, a value from a newer version) falls back to "beside" rather than throwing —
 *  a bad setting should not stop a chat from opening. (#83)
 */
export function resolvePanelLocation(raw: string | undefined | null): "beside" | "active" {
  return raw?.trim() === "active" ? "active" : "beside";
}
