import * as os from "node:os";
import * as vscode from "vscode";
import { piWarn } from "./logger.js";

// Lives in its own module (rather than pi-service.ts) so every caller — including
// bridge-tools.ts, which pi-service.ts imports — can share one definition of
// "this workspace" without a circular import.

let _warnedNoWorkspace = false;

/**
 * The cwd a session/agent should run in, and the directory that defines "this
 * workspace" for session listing. When no workspace folder is open, fall back to
 * the home directory — NOT `process.cwd()`, which in the extension host is VS
 * Code's own server dir (`.../vscode-server/.../api/node`). Running the agent
 * there makes it treat VS Code's internals as "the project" (grepping
 * extensionHostProcess.js, writing sessions under that path, EEXIST collisions),
 * and made the Past Sessions list filter against a different path than session
 * creation, silently dropping Rust sessions.
 */
export function resolveWorkspaceCwd(): string {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (folder) { return folder; }
  if (!_warnedNoWorkspace) {
    _warnedNoWorkspace = true;
    piWarn("No workspace folder open — Pi has no project to operate on. Open a folder; falling back to the home directory.");
  }
  return os.homedir();
}
