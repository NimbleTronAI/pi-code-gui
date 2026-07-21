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

// ── Secret redaction ────────────────────────────────────────────────────────
// The output channel PERSISTS to on-disk log files that users attach to bug reports, and the
// same strings reach the webview as error cards (extension.ts surfaces init failures, and the
// Rust child's stderr tail is attached to RPC rejections). Nothing filtered them.
//
// Two layers: exact values the user configured (registered at read time — the only way to catch
// a key that doesn't match a known vendor prefix), and shape-based patterns for anything that
// leaks from a provider error or the subprocess.

const REDACTED = "\u2039redacted\u203a";
/** Exact secret values to scrub, registered by whoever reads them from config. */
const _secrets = new Set<string>();

/** Register a configured secret so it is scrubbed from all future log/UI output. Values shorter
 *  than 8 chars are ignored — too short to be a real key, and scrubbing them would mangle text. */
export function registerSecret(value: string | undefined | null): void {
  if (typeof value === "string" && value.trim().length >= 8) { _secrets.add(value.trim()); }
}

/** Forget registered secrets (settings changed, or teardown). */
export function clearRegisteredSecrets(): void { _secrets.clear(); }

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  // Vendor key shapes. sk-ant- first: it is a prefix of the generic sk- rule.
  [/\bsk-ant-[A-Za-z0-9_-]{8,}/g, `sk-ant-${REDACTED}`],
  [/\bsk-[A-Za-z0-9_-]{16,}/g, `sk-${REDACTED}`],
  [/\bgh[pousr]_[A-Za-z0-9]{16,}/g, `gh_${REDACTED}`],
  // Authorization headers / bearer tokens.
  [/\b(Bearer|Authorization:\s*Bearer)\s+[A-Za-z0-9._~+/-]{8,}=*/gi, `$1 ${REDACTED}`],
  // key=VALUE / "api_key": "VALUE" style pairs.
  // The key name may itself be quoted ("api_key": "…"), so allow a closing quote before the
  // separator — otherwise the JSON form (the most common one in provider errors) never matched.
  [/\b((?:api[_-]?key|apikey|access[_-]?token|secret)"?\s*[=:]\s*"?)[A-Za-z0-9._~+/-]{12,}"?/gi, `$1${REDACTED}`],
];

/** Scrub secrets from a string bound for a log file or the webview. Exported so the UI paths
 *  (which don't go through this logger) can use the same filter. */
export function redactSecrets(text: string): string {
  if (!text) { return text; }
  let out = text;
  for (const secret of _secrets) { out = out.split(secret).join(REDACTED); }
  for (const [re, rep] of SECRET_PATTERNS) { out = out.replace(re, rep); }
  return out;
}

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
  const safe = redactSecrets(message);
  try {
    if (level === "debug") { ch.debug(safe); }
    else if (level === "info") { ch.info(safe); }
    else { ch.warn(safe); }
  } catch { _disposed = true; _channel = null; }
}

/** Routine lifecycle/diagnostic detail; hidden unless the user selects Debug/Trace. */
export function piDebug(message: string): void { write("debug", message); }

/** Notable, low-volume events worth seeing at the default Info log level. */
export function piLog(message: string): void { write("info", message); }

/** Problems and recoverable failures. */
export function piWarn(message: string): void { write("warn", message); }
