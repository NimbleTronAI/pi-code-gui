import * as vscode from "vscode";

const developmentWorkspaceEnv = "PI_ON_CODE_DEV_WORKSPACE";

/**
 * Resolve the project root without falling back to the Extension Host's cwd.
 * In development, VS Code can briefly launch an empty Extension Development
 * Host, so launch.json supplies the intended workspace through an env var.
 */
export function getWorkspaceRoot(): string | undefined {
  const folder = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (folder) { return folder; }

  const developmentWorkspace = process.env[developmentWorkspaceEnv]?.trim();
  return developmentWorkspace || undefined;
}

/** Resolve the project cwd, using process.cwd() only as a final fallback. */
export function getWorkspaceCwd(): string {
  return getWorkspaceRoot() ?? process.cwd();
}

/** Resolve the project URI for VS Code APIs that require a default URI. */
export function getWorkspaceUri(): vscode.Uri {
  const folderUri = vscode.workspace.workspaceFolders?.[0]?.uri;
  return folderUri ?? vscode.Uri.file(getWorkspaceCwd());
}

/** All workspace directories, retaining the development fallback for tests. */
export function getWorkspaceFolders(): Array<{ name: string; path: string }> {
  const folders = vscode.workspace.workspaceFolders ?? [];
  if (folders.length > 0) {
    return folders.map((folder) => ({ name: folder.name, path: folder.uri.fsPath }));
  }
  const root = getWorkspaceRoot();
  return root ? [{ name: "Workspace", path: root }] : [];
}
