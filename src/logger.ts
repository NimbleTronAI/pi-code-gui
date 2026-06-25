import type * as vscode from "vscode";

/**
 * Shared logger. Writes ONLY to the "Pi Code Gui" Output Channel
 * (`vscode.LogOutputChannel`) — never to the shared Extension Host `console`,
 * which every installed extension writes to and which a published extension
 * should not pollute. Verbosity is the user's to control via
 * "Developer: Set Log Level…"; the channel also timestamps, prefixes levels,
 * and persists to on-disk log files for bug reports.
 *
 * - `piDebug` — routine lifecycle/diagnostic chatter. Hidden at the default Info
 *   level; visible only when the user sets the log level to Debug or Trace.
 * - `piLog` — the few notable, low-volume events worth seeing by default (Info).
 * - `piWarn` — problems and recoverable failures (Warning).
 */

let _channel: vscode.LogOutputChannel | null = null;
let _disposed = false;

export function initLogger(channel: vscode.LogOutputChannel): void {
  _channel = channel;
  _disposed = false;
}

/**
 * Stop writing to the output channel. Called on deactivate / host shutdown so a
 * late log (e.g. from the process-level unhandledRejection handler) can't throw
 * "Channel has been closed" and turn a benign rejection into a crash.
 */
export function disposeLogger(): void {
  _disposed = true;
  _channel = null;
}

// The channel can be disposed out from under us during extension-host teardown;
// never let logging throw (it would re-enter the global error handlers). A log
// emitted before initLogger, or after disposeLogger, is silently dropped — by
// design, since there is no console fallback.
function write(level: "debug" | "info" | "warn", message: string): void {
  const ch = _channel;
  if (_disposed || !ch) { return; }
  try {
    if (level === "debug") { ch.debug(message); }
    else if (level === "info") { ch.info(message); }
    else { ch.warn(message); }
  } catch { _disposed = true; _channel = null; }
}

/** Routine lifecycle/diagnostic detail; hidden unless the user selects Debug/Trace. */
export function piDebug(message: string): void { write("debug", message); }

/** Notable, low-volume events worth seeing at the default Info log level. */
export function piLog(message: string): void { write("info", message); }

/** Problems and recoverable failures. */
export function piWarn(message: string): void { write("warn", message); }
