// Runtime discovery: which Pi runtimes are installed, what the effective
// default is, and the VS Code context keys that gate runtime-aware menus.

import * as vscode from "vscode";
import { PiService } from "./pi-service.js";
import { detectRustBinary, type RustInstallStatus } from "./rust-resolver.js";
import type { Runtime } from "./types.js";
import { piDebug } from "./logger.js";
import { pickDefaultRuntime } from "./runtime-pick.js";

export interface DetectedRuntimes {
  ts: boolean;
  rust: boolean;
  rustStatus?: RustInstallStatus;
}

let cached: DetectedRuntimes | null = null;

/** Detect installed runtimes. Result is cached for the session unless `force`. */
export async function detectRuntimes(force = false): Promise<DetectedRuntimes> {
  if (cached && !force) { return cached; }
  const ts = (await PiService.checkInstall()).installed;
  const rustStatus = detectRustBinary();
  cached = { ts, rust: rustStatus.installed, rustStatus };
  piDebug(`detectRuntimes: ts=${ts} rust=${rustStatus.installed}${rustStatus.version ? ` (${rustStatus.version})` : ""}`);
  return cached;
}

/** Last cached detection result (null before the first detectRuntimes call). */
export function cachedRuntimes(): DetectedRuntimes | null {
  return cached;
}

/**
 * Resolve the runtime for a NEW session.
 * - both installed  → the persisted `defaultRuntime` (ships "typescript")
 * - exactly one     → that one (never nag to install the other)
 * - neither         → null (caller runs the install flow)
 *
 * When the remembered default isn't installed but the other is, the installed
 * one is used WITHOUT overwriting the setting, so the preference is honored
 * once the user installs it.
 */
export function resolveEffectiveDefaultRuntime(detected: DetectedRuntimes): Runtime | null {
  const setting = vscode.workspace
    .getConfiguration("pi-code-gui")
    .get<string>("defaultRuntime") ?? "typescript";
  return pickDefaultRuntime(detected, setting);
}

/** Set the context keys used by runtime-aware menu `when` clauses. */
export async function refreshRuntimeContext(force = false): Promise<DetectedRuntimes> {
  const d = await detectRuntimes(force);
  await vscode.commands.executeCommand("setContext", "pi-code-gui.tsAvailable", d.ts);
  await vscode.commands.executeCommand("setContext", "pi-code-gui.rustAvailable", d.rust);
  await vscode.commands.executeCommand("setContext", "pi-code-gui.bothAvailable", d.ts && d.rust);
  await vscode.commands.executeCommand("setContext", "pi-code-gui.anyAvailable", d.ts || d.rust);
  return d;
}
