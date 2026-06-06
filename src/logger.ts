import type * as vscode from "vscode";

/** Shared logger that writes to both console and the Pi Code Gui Output Channel. */

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

export function piLog(message: string): void {
  try { console.log(`[pi-gui] ${message}`); } catch { /* console may be gone during shutdown */ }
  if (_disposed || !_channel) { return; }
  // The channel can be disposed out from under us during extension-host
  // teardown; never let logging throw (it would re-enter the global handlers).
  try { _channel.info(message); } catch { _disposed = true; _channel = null; }
}

export function piWarn(message: string): void {
  try { console.warn(`[pi-gui] ${message}`); } catch { /* console may be gone during shutdown */ }
  if (_disposed || !_channel) { return; }
  try { _channel.warn(message); } catch { _disposed = true; _channel = null; }
}
