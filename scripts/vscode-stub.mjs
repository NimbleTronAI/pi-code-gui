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
  /** Recorded calls for assertions. */
  calls: [],
};
// Fresh control object per test run; tests mutate this in place.
globalThis.__vscodeMock = control;

const rec = (kind, payload) => { control.calls.push({ kind, ...payload }); };

export const window = {
  showInformationMessage: async (message, ...items) => { rec("info", { message }); return items[0]; },
  showWarningMessage: async (message, ...items) => { rec("warn", { message }); return items[0]; },
  showErrorMessage: async (message, ...items) => { rec("error", { message }); return items[0]; },
  showQuickPick: async (items, opts) => { rec("quickPick", { opts }); return control.quickPick.length ? control.quickPick.shift() : undefined; },
  showInputBox: async (opts) => { rec("inputBox", { opts }); return control.inputBox.length ? control.inputBox.shift() : undefined; },
  withProgress: async (_opts, task) => task({ report: () => {} }, { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) }),
  createTerminal: () => ({ sendText: () => {}, show: () => {}, dispose: () => {} }),
};

export const workspace = {
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
export const EventEmitter = class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} };

export default { window, workspace, commands, env, Uri, ConfigurationTarget, QuickPickItemKind, ProgressLocation, ThemeIcon, EventEmitter };
