// Pure, vscode-free planning for reviving a session panel from the state VS Code
// persisted for it (via the webview's setState → WebviewPanelSerializer). Kept
// separate from extension.ts so the decision logic is headlessly unit-testable.
import type { Runtime } from "./types.js";

export interface PanelRestorePlan {
  /** "open" = re-attach the on-disk session; "fresh" = the panel never had a
   *  persisted session file (nothing hit disk), so an equivalent fresh session is
   *  the correct restoration; "dispose" = the session file is gone — close the
   *  revived panel instead of resurrecting an empty shell. */
  action: "open" | "fresh" | "dispose";
  runtime: Runtime;
  openPath?: string;
}

/** Decide what to do with a revived panel given its persisted state. `state` is
 *  whatever the webview last setState()'d — treat it as untrusted (old extension
 *  versions persisted other shapes, e.g. the step-0 probe). */
export function planPanelRestore(
  state: unknown,
  fileExists: (p: string) => boolean,
  defaultRuntime: Runtime,
): PanelRestorePlan {
  const s = (state && typeof state === "object" ? state : {}) as { sessionFilePath?: unknown; runtime?: unknown };
  const runtime: Runtime = s.runtime === "rust" ? "rust" : s.runtime === "typescript" ? "typescript" : defaultRuntime;
  const p = typeof s.sessionFilePath === "string" && s.sessionFilePath.length > 0 ? s.sessionFilePath : null;
  if (!p) { return { action: "fresh", runtime }; }
  if (!fileExists(p)) { return { action: "dispose", runtime }; }
  return { action: "open", runtime, openPath: p };
}
