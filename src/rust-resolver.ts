// Detection/resolution of the Rust Pi binary (`pi --mode rpc`).
//
// The TypeScript runtime is resolved as an npm *package* (see
// `resolvePiPackagePath` in pi-service.ts), never via the `pi` shell command.
// The Rust runtime, by contrast, IS a binary on disk. Because the TypeScript
// CLI also installs a `pi` command (a Node.js *script*), this resolver verifies
// that a candidate is a genuine native executable before accepting it — so the
// TS CLI is never mistaken for the Rust binary.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import * as vscode from "vscode";
import { piLog, piWarn } from "./logger.js";
// Pure interop gates live in a vscode-free module so they can be unit-tested;
// re-exported here to keep the existing `./rust-resolver.js` import surface.
import { workspaceHasTsPiExtensions, isRustExtensionConflict } from "./rust-interop.js";
export { workspaceHasTsPiExtensions, isRustExtensionConflict };

export interface RustInstallStatus {
  installed: boolean;
  binaryPath?: string;
  version?: string;
  error?: string;
}

/**
 * Candidate binary names the Rust agent may be installed under. The official
 * curl installer installs it as `pi` (renaming any existing TS CLI to
 * `legacy-pi`); `rust-pi` is a compatibility launcher some setups use.
 */
const RUST_BINARY_NAMES = ["pi", "rust-pi", "legacy-pi"];

/**
 * True if the file looks like a native executable (ELF / Mach-O / PE) rather
 * than a shebang script. This is the key guard that distinguishes the Rust
 * `pi` binary from the TypeScript `pi` CLI (a `#!/usr/bin/env node` script),
 * since both can live on PATH simultaneously.
 */
function isNativeExecutable(p: string): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(p, "r");
    const buf = Buffer.alloc(4);
    const n = fs.readSync(fd, buf, 0, 4, 0);
    if (n < 4) { return false; }
    // "#!" → shebang script (the TS CLI). Reject.
    if (buf[0] === 0x23 && buf[1] === 0x21) { return false; }
    // ELF (Linux): 0x7F 'E' 'L' 'F'
    if (buf[0] === 0x7f && buf[1] === 0x45 && buf[2] === 0x4c && buf[3] === 0x46) { return true; }
    // Mach-O (macOS), incl. reversed-endian and fat (universal) magics.
    const machoMagics = [0xfeedface, 0xfeedfacf, 0xcafebabe, 0xcefaedfe, 0xcffaedfe, 0xbebafeca];
    if (machoMagics.includes(buf.readUInt32BE(0)) || machoMagics.includes(buf.readUInt32LE(0))) { return true; }
    // PE (Windows): "MZ"
    if (buf[0] === 0x4d && buf[1] === 0x5a) { return true; }
    return false;
  } catch {
    return false;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

/** Ordered list of places to look for the Rust binary. */
function candidatePaths(): string[] {
  const out: string[] = [];
  const exe = process.platform === "win32" ? ".exe" : "";

  // 1. Explicit setting wins.
  const explicit = vscode.workspace.getConfiguration("pi-code-gui").get<string>("rustBinaryPath")?.trim();
  if (explicit) { out.push(explicit); }

  // 2. Env override.
  const env = process.env.PI_BINARY_PATH?.trim();
  if (env) { out.push(env); }

  // 3. Common install locations.
  const home = os.homedir();
  const dirs = [
    path.join(home, ".cargo", "bin"),
    path.join(home, ".local", "bin"),
    "/usr/local/bin",
    "/opt/homebrew/bin",
  ];
  for (const d of dirs) {
    for (const name of RUST_BINARY_NAMES) { out.push(path.join(d, name + exe)); }
  }

  // 4. PATH scan.
  const sep = process.platform === "win32" ? ";" : ":";
  for (const d of (process.env.PATH || "").split(sep)) {
    if (!d) { continue; }
    for (const name of RUST_BINARY_NAMES) { out.push(path.join(d, name + exe)); }
  }

  return out;
}

/**
 * Locate the Rust Pi binary. Synchronous (file checks + a short `--version`
 * probe) so it can run during activation before the first session is created.
 */
export function detectRustBinary(): RustInstallStatus {
  const seen = new Set<string>();
  for (const cand of candidatePaths()) {
    let resolved: string;
    try {
      resolved = fs.realpathSync(cand);
    } catch {
      continue; // missing / broken symlink
    }
    if (seen.has(resolved)) { continue; }
    seen.add(resolved);

    // Guard: the TS CLI's `pi` is a node script — reject anything non-native.
    if (!isNativeExecutable(resolved)) { continue; }

    try {
      const version = execFileSync(resolved, ["--version"], {
        timeout: 5000,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      piLog(`detectRustBinary: found Rust pi at ${resolved} (${version})`);
      return { installed: true, binaryPath: resolved, version };
    } catch (e: unknown) {
      piWarn(`detectRustBinary: ${resolved} failed --version: ${e instanceof Error ? e.message : String(e)}`);
      continue;
    }
  }
  return { installed: false, error: "No Rust Pi binary found on PATH or common locations." };
}

/**
 * Modes for the `pi-code-gui.rustExtensions` setting — whether a Rust session
 * discovers and loads Pi extensions. The Rust runtime aborts `--mode rpc`
 * startup when it meets TypeScript-SDK-format extensions under the workspace
 * `.pi/` (it expects its own tool-manifest shape and fails with
 * `JSON error: missing field 'parameters'`).
 */
export type RustExtensionsMode = "auto" | "enabled" | "disabled";

/** The resolved `pi-code-gui.rustExtensions` mode (defaults to "auto"). */
export function rustExtensionsMode(): RustExtensionsMode {
  const v = vscode.workspace.getConfiguration("pi-code-gui").get<string>("rustExtensions");
  return v === "enabled" || v === "disabled" ? v : "auto";
}

/**
 * Whether a Rust session in `cwd` should launch with `--no-extensions`, per the
 * `rustExtensions` setting:
 *   - "disabled" → always disable discovery
 *   - "enabled"  → never disable (the user vouches for a Rust-compatible workspace)
 *   - "auto"     → disable only when TypeScript-format `.pi/` extensions are present
 */
export function shouldDisableRustExtensions(cwd: string): boolean {
  const mode = rustExtensionsMode();
  if (mode === "disabled") { return true; }
  if (mode === "enabled") { return false; }
  return workspaceHasTsPiExtensions(cwd);
}

