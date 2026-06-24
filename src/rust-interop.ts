// Pure, vscode-free Rust-interop detection helpers. Extracted from rust-resolver
// (which imports vscode) so the `.pi/` extension-conflict gates that drive the
// `--no-extensions` self-heal path can be unit-tested headlessly. `piWarn` is
// runtime-vscode-free (logger imports vscode as a type only), so it's safe here.

import * as fs from "node:fs";
import * as path from "node:path";
import { piWarn } from "./logger.js";

/**
 * Detect whether the workspace declares TypeScript-SDK Pi extensions under
 * `.pi/` that the Rust runtime cannot parse. The breaking mechanism is the npm
 * package install path: a non-empty `packages` array in `.pi/settings.json`,
 * or a `.pi/npm` install directory. Rust's own native extensions live in the
 * GLOBAL packages dir, so only the PROJECT `.pi/` is inspected here.
 */
export function workspaceHasTsPiExtensions(cwd: string): boolean {
  try {
    const piDir = path.join(cwd, ".pi");
    if (fs.existsSync(path.join(piDir, "npm"))) { return true; }
    const settingsPath = path.join(piDir, "settings.json");
    if (fs.existsSync(settingsPath)) {
      const parsed = JSON.parse(fs.readFileSync(settingsPath, "utf-8")) as { packages?: unknown };
      if (Array.isArray(parsed.packages) && parsed.packages.length > 0) { return true; }
    }
  } catch (e: unknown) {
    piWarn(`workspaceHasTsPiExtensions(${cwd}): ${e instanceof Error ? e.message : String(e)}`);
  }
  return false;
}

/**
 * True when a Rust `--mode rpc` startup failure is the TypeScript-format
 * extension parse conflict (`JSON error: missing field 'parameters'`), so the
 * caller can recover by disabling extension discovery rather than surfacing a
 * raw, confusing error.
 */
export function isRustExtensionConflict(message: string): boolean {
  const m = message.toLowerCase();
  return m.includes("missing field") && m.includes("parameters");
}
