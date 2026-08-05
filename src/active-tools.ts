// Per-session tool selection — the pure core of PiService's tools picker (the /tools flow,
// SDK runtime only). vscode-free: the QuickPick rows are a neutral structure the PiService
// shell maps to vscode.QuickPickItem, so the grouping, the picked-state, the restore scan, and
// the added/removed summary are all unit-tested. Previously this ~120-line block was untested.
/* eslint-disable @typescript-eslint/no-explicit-any -- SDK tool objects and session entries are dynamically typed */

export interface ToolInfo { name: string; description: string; source: string; }

/** A row in the tools QuickPick: either a group separator or a selectable tool. The shell
 *  renders separators as `$(icon) label` and tools as name/description/source rows. */
export type PickerRow =
  | { separator: true; label: string; icon: string }
  | { separator: false; name: string; description: string; source: string; picked: boolean };

/** Normalize the SDK's raw tool objects to the {name, description, source} shape the picker
 *  and webview use (source falls back to "sdk"). Pure. */
export function mapSessionTools(raw: any[]): ToolInfo[] {
  return (raw ?? []).map((t: any) => ({
    name: t.name,
    description: t.description ?? "",
    source: t.sourceInfo?.source ?? "sdk",
  }));
}

/** Walk session entries in reverse for the last tools_active_change and return its tool names
 *  (non-empty), or null when there's none to restore. Pure. */
export function findLastActiveTools(entries: any[]): string[] | null {
  for (let i = (entries?.length ?? 0) - 1; i >= 0; i--) {
    const e = entries[i];
    if (e.type === "tools_active_change" && Array.isArray(e.toolNames) && e.toolNames.length > 0) {
      return e.toolNames;
    }
  }
  return null;
}

const GROUP_ICON: Record<string, string> = { "Built-in": "tools", "VS Code Bridge": "extensions" };

/** Group the tools (built-in / VS Code bridge / extension) into ordered picker rows, marking
 *  the currently-active ones picked. Pure — a function of (allTools, activeNames). The bridge
 *  group is the SDK-sourced `vscode_*` tools; extension is everything else non-built-in. */
export function buildToolPickerRows(allTools: ToolInfo[], activeNames: Set<string>): PickerRow[] {
  const builtin = allTools.filter((t) => t.source === "builtin");
  const bridge = allTools.filter((t) => t.source === "sdk" && t.name.startsWith("vscode_"));
  const extension = allTools.filter((t) => t.source !== "builtin" && !t.name.startsWith("vscode_"));

  const rows: PickerRow[] = [];
  const addGroup = (label: string, tools: ToolInfo[]): void => {
    if (tools.length === 0) { return; }
    rows.push({ separator: true, label, icon: GROUP_ICON[label] ?? "symbol-misc" });
    for (const t of tools) {
      rows.push({ separator: false, name: t.name, description: t.description, source: t.source, picked: activeNames.has(t.name) });
    }
  };
  addGroup("Built-in", builtin);
  addGroup("VS Code Bridge", bridge);
  addGroup("Extension", extension);
  return rows;
}

/** The added/removed deltas + the status message for a new tool selection versus the currently
 *  active set. Pure. */
export function summarizeToolSelection(activeNames: Set<string>, selectedNames: string[]): { added: number; removed: number; summary: string } {
  const added = selectedNames.filter((n) => !activeNames.has(n)).length;
  const removed = activeNames.size - selectedNames.filter((n) => activeNames.has(n)).length;
  const parts: string[] = [];
  if (added > 0) { parts.push(`+${added}`); }
  if (removed > 0) { parts.push(`-${removed}`); }
  const summary = `Tools updated: ${selectedNames.length} active${parts.length > 0 ? ` (${parts.join(", ")})` : ""}`;
  return { added, removed, summary };
}
