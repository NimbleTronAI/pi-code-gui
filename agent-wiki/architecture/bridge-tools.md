# Bridge Tools

> **Status:** evolving

Bridge Tools (`src/bridge-tools.ts`) are 16 VS Code API tools registered as Pi
SDK `customTools` that give the AI agent full visibility into the VS Code editor
state. They are constructed with the SDK's `defineTool()` function and Typebox
schemas — the same type-safe pattern the SDK's own built-in tools use.

## Why they exist

Without bridge tools, the agent operates in a terminal environment with no
knowledge of open editors, selections, diagnostics, or symbols. These tools
enable the agent to inspect the VS Code state directly: check for lint errors,
look up type definitions, find references, search workspace symbols, open files,
apply edits through VS Code (keeping buffers in sync), and format documents.

## Tool list

| Tool | Description | Execution Mode |
|------|-------------|----------------|
| `vscode_get_editor_state` | Active editor, selection, workspace folders, open editors | async |
| `vscode_get_selection` | Current selection text, file path, coordinates | async |
| `vscode_get_diagnostics` | LSP/lint/type errors for a file or workspace | async |
| `vscode_get_open_editors` | Open editors, dirty state, language IDs | async |
| `vscode_get_workspace_folders` | Workspace folder paths and metadata | async |
| `vscode_open_file` | Open a file with optional selection range | sequential |
| `vscode_check_document_dirty` | Check if a file is open and has unsaved changes | async |
| `vscode_save_document` | Save a document via VS Code | sequential |
| `vscode_get_document_symbols` | Outline symbols from language server | async |
| `vscode_get_definitions` | Go-to-definition at a position | async |
| `vscode_get_hover` | Hover info (types, signatures, docs) | async |
| `vscode_get_references` | Find all references at a position | async |
| `vscode_get_workspace_symbols` | Global symbol search | async |
| `vscode_get_code_actions` | Quick fixes and code actions for a range | async |
| `vscode_apply_workspace_edit` | Range-based text replacements via VS Code | sequential |
| `vscode_format_document` | Run document formatter via VS Code | sequential |

## Design choices

- **Typebox schemas** ensure tool parameters are validated at runtime against
  exact types, matching the SDK's pattern.
- **Output bounding** (`truncateText`, `boundedJson`) prevents runaway context
  consumption by capping responses at 2000 lines / 50KB.
- **Path resolution** (`resolvePath`, `workspaceRelativePath`) handles both
  absolute and workspace-relative paths, resolving against the first workspace
  folder or `cwd`.
- **Sequential execution** mode for mutating tools (`vscode_open_file`,
  `vscode_save_document`, `vscode_apply_workspace_edit`, `vscode_format_document`)
  prevents race conditions on editor state.

## Related

- [PiService](pi-service.md) — where bridge tools are registered as customTools and controlled via `setActiveTools`
- [Event Translation](event-translation.md) — tool execution events flow through here
- [Webview Frontend](webview-frontend.md) — renders tool execution results

## Tool control

Bridge tools participate in the SDK's `setActiveToolsByName` mechanism on equal
footing with built-in tools — they are in the `_toolRegistry` by name and can be
toggled via `setActiveTools`. PiService exposes this through:

- **`/tools` slash command** — opens a grouped checkbox QuickPick (Built-in,
  VS Code Bridge, Extension) pre-populated from the current active tool set.
  Uses `canPickMany: true` for multi-select, reports `+N/-N` diffs.
- **Session persistence** — active tool selection is persisted through the SDK's
  `SessionManager.appendCustomEntry()` as a `pi-code-gui.active-tools` custom
  entry. Resume also accepts legacy `tools_active_change` entries.
- **`PiService.setActiveTools()`** — programmatic entry point, delegates runtime
  activation to `session.setActiveToolsByName()` and persistence to the session
  manager. It never appends directly to the `.jsonl` file.

The older static `pi-code-gui.tools` VS Code setting has been removed in favor
of runtime-per-session control.

> **Last updated:** 2026-07-19 — moved active-tool persistence to SessionManager custom entries with legacy restore compatibility
