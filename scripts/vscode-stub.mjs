// Runtime stub for the `vscode` module, used ONLY by the headless unit tests (installed via the
// ESM loader in scripts/vscode-hooks.mjs). Production and tsc still see the real @types/vscode;
// this replaces the module at RUN time so PiService (which imports `vscode`) can be constructed
// and driven under `node --test`. Tests control/inspect it through globalThis.__vscodeMock.
//
// Keep it minimal: implement only the surface PiService actually calls at runtime.

const control = {
  /** { "<section>.<key>": value } consulted by workspace.getConfiguration().get(). */
  config: {},
  /** Scripted return values (shift()ed) for showQuickPick / showInputBox. */
  quickPick: [],
  inputBox: [],
  /** Scripted answers (shift()ed) for show*Message. Undefined models the user DISMISSING. */
  messageChoice: [],
  /** Recorded calls for assertions. */
  calls: [],
};
// Fresh control object per test run; tests mutate this in place.
globalThis.__vscodeMock = control;

const rec = (kind, payload) => { control.calls.push({ kind, ...payload }); };

/** Shared modal/notification reply: records the call, honours a scripted choice, and models the
 *  optional leading options object that real VS Code accepts. */
function msgReply(kind, message, items) {
  rec(kind, { message });
  const choices = items.filter((i) => typeof i === "string" || (i && typeof i.title === "string"));
  if (control.messageChoice.length) { return control.messageChoice.shift(); }
  return choices[0];
}

export const window = {
  registerTreeDataProvider: () => ({ dispose() {} }),
  createTreeView: () => ({ dispose() {}, onDidChangeVisibility: () => ({ dispose() {} }), reveal: async () => {} }),
  createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {}, text: "", tooltip: "", command: undefined }),
  createOutputChannel: () => ({ appendLine() {}, append() {}, show() {}, clear() {}, dispose() {} }),
  createWebviewPanel: () => ({ webview: { html: "", onDidReceiveMessage: () => ({ dispose() {} }), postMessage: async () => true, asWebviewUri: (u) => u, cspSource: "vscode-webview:" }, onDidDispose: () => ({ dispose() {} }), onDidChangeViewState: () => ({ dispose() {} }), reveal() {}, dispose() {}, title: "" }),
  registerWebviewPanelSerializer: () => ({ dispose() {} }),
  onDidChangeActiveTextEditor: () => ({ dispose() {} }),
  activeTextEditor: undefined,
  visibleTextEditors: [],
  showTextDocument: async () => ({}),
  // Real VS Code accepts an optional OPTIONS object before the items
  // (showWarningMessage(msg, {modal, detail}, ...items)). The old stub returned items[0]
  // blindly, so a caller using that overload got the options object back — a test would then
  // "confirm" a dialog that was never confirmable. Skip a leading non-string and return the
  // first real item, or control.messageChoice when a test scripts one.
  showInformationMessage: async (message, ...items) => msgReply("info", message, items),
  showWarningMessage: async (message, ...items) => msgReply("warn", message, items),
  showErrorMessage: async (message, ...items) => msgReply("error", message, items),
  showQuickPick: async (items, opts) => { rec("quickPick", { opts }); return control.quickPick.length ? control.quickPick.shift() : undefined; },
  showInputBox: async (opts) => { rec("inputBox", { opts }); return control.inputBox.length ? control.inputBox.shift() : undefined; },
  withProgress: async (_opts, task) => task({ report: () => {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }),
  createTerminal: () => ({ sendText: () => {}, show: () => {}, dispose: () => {} }),
};

export const languages = { createDiagnosticCollection: () => ({ set: () => {}, delete: () => {}, clear: () => {}, dispose: () => {} }) };

export const workspace = {
  workspaceFolders: undefined,
  onDidChangeConfiguration: () => ({ dispose() {} }),
  onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
  createFileSystemWatcher: () => ({ onDidCreate: () => ({ dispose() {} }), onDidChange: () => ({ dispose() {} }), onDidDelete: () => ({ dispose() {} }), dispose: () => {} }),
  fs: { readFile: async () => new Uint8Array(), writeFile: async () => {}, stat: async () => ({ type: 1, size: 0 }) },
  getConfiguration: (section) => ({
    get: (key, dflt) => {
      const full = section ? `${section}.${key}` : key;
      return Object.prototype.hasOwnProperty.call(control.config, full) ? control.config[full]
        : Object.prototype.hasOwnProperty.call(control.config, key) ? control.config[key]
        : dflt;
    },
    update: async (key, value) => { control.config[section ? `${section}.${key}` : key] = value; rec("configUpdate", { key, value }); },
  }),
};

export const commands = {
  registerCommand: () => ({ dispose() {} }),
  getCommands: async () => [],
  executeCommand: async (command, ...args) => { rec("command", { command, args }); return undefined; },
};

export const env = {
  openExternal: async (uri) => { rec("openExternal", { uri: String(uri) }); return true; },
};

export const Uri = {
  parse: (s) => ({ toString: () => s, fsPath: s, scheme: String(s).split(":")[0] }),
  file: (p) => ({ fsPath: p, toString: () => p, path: p }),
  joinPath: (base, ...segs) => { const p = [base?.fsPath ?? "", ...segs].join("/"); return { fsPath: p, toString: () => p, path: p }; },
};

export const ConfigurationTarget = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
export const QuickPickItemKind = { Separator: -1, Default: 0 };
export const ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 };
export class ThemeIcon { constructor(id) { this.id = id; } }
/** A REAL EventEmitter. The previous stub returned a no-op `event()` that DISCARDED the
 *  listener and a `fire()` that did nothing — any test of a tree provider or event-driven
 *  component would have looked correct while delivering nothing. */
export class EventEmitter {
  constructor() {
    this._listeners = [];
    this.event = (listener) => {
      this._listeners.push(listener);
      return { dispose: () => { this._listeners = this._listeners.filter((l) => l !== listener); } };
    };
  }
  fire(value) { for (const l of [...this._listeners]) { l(value); } }
  dispose() { this._listeners = []; }
}

export const TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
export class TreeItem {
  constructor(label, collapsibleState) {
    this.label = label;
    this.collapsibleState = collapsibleState ?? TreeItemCollapsibleState.None;
  }
}
export class ThemeColor { constructor(id) { this.id = id; } }
export class MarkdownString {
  constructor(value = "") { this.value = value; this.isTrusted = false; }
  appendMarkdown(v) { this.value += v; return this; }
  appendText(v) { this.value += v; return this; }
}
export class Disposable {
  constructor(fn) { this._fn = fn; }
  dispose() { this._fn?.(); }
  static from(...items) { return new Disposable(() => items.forEach((i) => i?.dispose?.())); }
}
export class RelativePattern { constructor(base, pattern) { this.base = base; this.pattern = pattern; } }
export const TreeItemCheckboxState = { Unchecked: 0, Checked: 1 };
export const ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2 };
export const StatusBarAlignment = { Left: 1, Right: 2 };
export const ExtensionMode = { Production: 1, Development: 2, Test: 3 };
export const UIKind = { Desktop: 1, Web: 2 };

export default { window, workspace, commands, env, languages, Uri, ConfigurationTarget, QuickPickItemKind, ProgressLocation, ThemeIcon, EventEmitter, TreeItem, TreeItemCollapsibleState, ThemeColor, MarkdownString, Disposable, RelativePattern, ViewColumn, StatusBarAlignment, ExtensionMode, UIKind };
