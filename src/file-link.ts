import * as path from "node:path";

/** Resolve a tool-rendered file link against the active workspace root. */
export function resolveFileLinkPath(filePath: string, workspaceRoot: string): string {
  const value = filePath.trim();
  if (!value) { throw new Error("File link path is empty"); }
  if (path.isAbsolute(value) || path.win32.isAbsolute(value)) {
    return value;
  }
  return path.resolve(workspaceRoot, value);
}
