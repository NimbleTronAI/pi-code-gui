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
import { piDebug, piLog, piWarn } from "./logger.js";
// Pure interop gates live in a vscode-free module so they can be unit-tested;
// re-exported here to keep the existing `./rust-resolver.js` import surface.
import { workspaceHasTsPiExtensions, isRustExtensionConflict } from "./rust-interop.js";
export { workspaceHasTsPiExtensions, isRustExtensionConflict };

export interface RustInstallStatus {
  installed: boolean;
  binaryPath?: string;
  version?: string;
  error?: string;
  /** Set when `pi-code-gui.rustBinaryPath` names a binary that exists but would NOT run, and
   *  detection therefore fell through to a different one. Silent substitution is how an
   *  unrunnable managed download (glibc floor too high) got reported as a successful install of
   *  whatever older binary happened to be elsewhere on the box. Whoever surfaces status must say
   *  this out loud. */
  configuredPathError?: string;
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

/** The extension-managed install folder (`<globalStorageUri>/rust-pi`), handed over by
 *  activate(). The resolver used to know nothing about it, so the managed install recorded its
 *  binary by writing an ABSOLUTE PATH into the machine-scoped `rustBinaryPath` setting — and that
 *  value leaked to other machines (a Mac's `/Users/…/globalStorage/…/rust-pi/pi` applied inside a
 *  Linux dev container), warning on every Rust session. Null until activate() sets it. */
let _managedDir: string | null = null;

/** Tell the resolver where the managed install lives. Called first thing in activate(), before
 *  any detection; drops the detection memo so nothing taken before it hides the managed binary. */
export function setManagedRustDir(dir: string | null): void {
  _managedDir = dir ? path.resolve(dir) : null;
  invalidateRustBinaryCache();
}

/** The managed install folder, or null before activation. */
export function managedRustDir(): string | null { return _managedDir; }

/** The managed binary, `<managedDir>/pi[.exe]` — the ONLY path removeManagedRustBinary touches. */
export function managedRustBinary(): string | null {
  return _managedDir ? path.join(_managedDir, "pi" + (process.platform === "win32" ? ".exe" : "")) : null;
}

function realpathOr(p: string): string {
  try { return fs.realpathSync(p); } catch { return path.resolve(p); }
}

/** True when `p` (after resolving symlinks) lies inside the managed install folder. Both sides are
 *  realpath'd, so a managed folder under a symlinked home is still recognised. */
export function isInsideManaged(p: string): boolean {
  if (!_managedDir) { return false; }
  return realpathOr(p).startsWith(realpathOr(_managedDir) + path.sep);
}

/**
 * Remove the extension's OWN managed binary (founder's option "c": when the user switches to a
 * Rust Pi they installed themselves, the leftover managed copy must not keep outranking it).
 * Takes no path: the target is always `managedRustBinary()`, never a setting, env value or
 * detected candidate. A symlink there is unlinked, never its target; a directory is refused (no
 * recursive delete). Returns null when there is nothing to remove (no managed dir known, or no
 * file). Drops the detection memo after a removal so the next detection sees it.
 */
export function removeManagedRustBinary(): { removed: string } | { error: string; refused?: true } | null {
  const target = managedRustBinary();
  if (!target || !_managedDir) { return null; }
  const st = fs.lstatSync(target, { throwIfNoEntry: false });
  if (!st) { return null; }
  // Guards (unit 4c, review of record SF1). `refused` = a guard said no; nothing was attempted.
  // (a) The managed FOLDER must not be a symlink: `lstat` of `<dir>/pi` only checks the last
  //     component, so a linked `rust-pi` folder would carry the delete into, e.g., ~/.local/bin.
  if (fs.lstatSync(_managedDir, { throwIfNoEntry: false })?.isSymbolicLink()) {
    return { error: `${_managedDir} is a symlink, not the extension's own folder — left in place`, refused: true };
  }
  // (b) Containment, belt and braces: the file's real parent must be exactly
  //     realpath(<parent>)/rust-pi, so no chain of links can carry the delete anywhere else (and a
  //     wrong folder not named rust-pi is refused). That the parent IS globalStorage rests on the
  //     one caller, activate(), passing `<globalStorageUri>/rust-pi`.
  let realParent: string, wantParent: string;
  try {
    realParent = fs.realpathSync(path.dirname(target));
    wantParent = path.join(fs.realpathSync(path.dirname(_managedDir)), "rust-pi");
  } catch {
    return { error: `${_managedDir} could not be resolved — left in place`, refused: true };
  }
  if (realParent !== wantParent) {
    return { error: `${_managedDir} resolves to ${realParent}, not the extension's own folder — left in place`, refused: true };
  }
  if (st.isDirectory()) { return { error: `${target} is a directory, not the managed binary — left in place`, refused: true }; }
  try {
    fs.rmSync(target);
  } catch (e: unknown) {
    const err = e as NodeJS.ErrnoException;
    return { error: err.code ?? (e instanceof Error ? e.message : String(e)) };
  }
  invalidateRustBinaryCache();
  piLog(`removeManagedRustBinary: removed ${target}`);
  return { removed: target };
}

/**
 * True when a configured `rustBinaryPath` is a value OUR managed install wrote that does not
 * exist on this machine — another machine's managed install, or this machine's gone missing.
 * Such a value is skipped quietly: the user never typed it, and "could not be used" on every
 * session gave them nothing to act on. Precisely, ALL of:
 *   - its last four segments (split on `/` and `\`, so a Windows value is recognised on Linux and
 *     vice versa) are `globalStorage/<this extension's storage folder>/rust-pi/pi[.exe]`;
 *   - it does not resolve on this machine;
 *   - and EITHER (i) it is this machine's own managed binary (`<managedDir>/pi[.exe]`), OR
 *     (ii) its `globalStorage` folder does not exist on this machine (another OS's / another
 *     machine's profile — the leak this skip exists for).
 * A missing path into a storage folder that DOES exist here — another VS Code variant's profile
 * (Insiders, VSCodium, Cursor), a mounted share — is a choice the user can act on, so it warns.
 * With no managed dir known, nothing is stale (conservative — warn).
 */
export function isStaleManagedPath(configured: string, managedDir: string | null): boolean {
  if (!managedDir) { return false; }
  const ours = path.basename(path.dirname(managedDir)).toLowerCase();
  const segs = configured.split(/[\\/]+/).filter(Boolean);
  if (segs.length < 4) { return false; }
  const [gs, ext, dir, leaf] = segs.slice(-4).map((x) => x.toLowerCase());
  if (gs !== "globalstorage" || ext !== ours || dir !== "rust-pi" || (leaf !== "pi" && leaf !== "pi.exe")) { return false; }
  try { fs.realpathSync(configured); return false; } catch { /* missing — classify below */ }
  // (i) this machine's own managed binary, gone missing (storage wiped, extension reinstalled).
  const exe = process.platform === "win32" ? ".exe" : "";
  if (path.resolve(configured) === path.join(managedDir, "pi" + exe)) { return true; }
  // (ii) the value's globalStorage folder does not exist here. The prefix is cut from the raw
  // string (everything before the last three segments), so its root — `/`, a drive letter, a UNC
  // `\\server\share` — is kept exactly as written.
  const gsDir = configured.replace(/[\\/]+[^\\/]+[\\/]+[^\\/]+[\\/]+[^\\/]+[\\/]*$/, "");
  return !fs.existsSync(gsDir);
}

/** Stale values already logged, so the 5s detection TTL does not repeat the line all session. */
const _staleLogged = new Set<string>();

/** Ordered list of places to look for the Rust binary. */
function candidatePaths(): string[] {
  const out: string[] = [];
  const exe = process.platform === "win32" ? ".exe" : "";

  // 1. Explicit setting wins.
  const explicit = vscode.workspace.getConfiguration("pi-code-gui").get<string>("rustBinaryPath")?.trim();
  if (explicit) { out.push(explicit); }

  // 2. Env override — also an explicit choice, so it beats the managed install.
  const env = process.env.PI_BINARY_PATH?.trim();
  if (env) { out.push(env); }

  // 3. The extension-managed install. Ahead of the common locations and PATH, so a managed user
  //    who ALSO has rust-pi on PATH keeps getting the managed binary — as they did when the
  //    install wrote it into the setting.
  if (_managedDir) { out.push(path.join(_managedDir, "pi" + exe)); }

  // 4. Common install locations.
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

  // 5. PATH scan.
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
/** Memoised result + the moment it was taken. detectRustBinary walks $PATH x 3 names doing
 *  realpathSync + openSync/readSync per candidate, then execFileSync(binary, ["--version"]) with
 *  a 5s timeout — all SYNCHRONOUS, on the extension-host thread. It was uncached and called from
 *  ~8 sites, including twice per package in the packages tree (pi-package-service → rustInfo →
 *  rust-packages, each re-detecting), so N packages meant 2N blocking subprocess spawns.
 *  A short TTL keeps "install Pi then it appears" responsive without re-probing in a loop. */
let _detectCache: { at: number; value: RustInstallStatus } | null = null;
const DETECT_TTL_MS = 5000;

/** Drop the memoised detection (after an install, or when the binary path setting changes). */
export function invalidateRustBinaryCache(): void { _detectCache = null; }

/** Detection as if the managed binary were absent (uncached): the same order, skipping the managed
 *  candidate and any candidate that resolves into the managed folder. Used by "Detect an existing
 *  binary" to find — and verify with `--version` — the binary the user installed themselves. */
export function detectRustBinaryExcludingManaged(): RustInstallStatus {
  return detectRustBinaryUncached(true);
}

export function detectRustBinary(): RustInstallStatus {
  const now = Date.now();
  if (_detectCache && now - _detectCache.at < DETECT_TTL_MS) { return _detectCache.value; }
  const value = detectRustBinaryUncached();
  _detectCache = { at: now, value };
  return value;
}

function detectRustBinaryUncached(excludeManaged = false): RustInstallStatus {
  const seen = new Set<string>();
  const configured = vscode.workspace.getConfiguration("pi-code-gui").get<string>("rustBinaryPath")?.trim() || null;
  let configuredPathError: string | undefined;
  const noteIfConfigured = (cand: string, why: string): void => {
    if (configured && cand === configured && !configuredPathError) { configuredPathError = why; }
  };
  for (const cand of candidatePaths()) {
    let resolved: string;
    try {
      resolved = fs.realpathSync(cand);
    } catch {
      if (configured && cand === configured && isStaleManagedPath(cand, _managedDir)) {
        if (!_staleLogged.has(cand)) {
          _staleLogged.add(cand);
          piLog(`detectRustBinary: ignoring pi-code-gui.rustBinaryPath "${cand}" — a managed-install path written by an earlier version that does not exist on this machine. The managed install is now found without the setting; it can be removed.`);
        }
        continue;
      }
      noteIfConfigured(cand, "the file does not exist (or is a broken symlink)");
      continue; // missing / broken symlink
    }
    if (seen.has(resolved)) { continue; }
    seen.add(resolved);
    if (excludeManaged && isInsideManaged(resolved)) { continue; }

    // Guard: the TS CLI's `pi` is a node script — reject anything non-native.
    if (!isNativeExecutable(resolved)) {
      noteIfConfigured(cand, "it is not a native executable (a shebang script — probably the TypeScript `pi`)");
      continue;
    }

    try {
      const version = execFileSync(resolved, ["--version"], {
        timeout: 5000,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      piDebug(`detectRustBinary: found Rust pi at ${resolved} (${version})`);
      return { installed: true, binaryPath: resolved, version, configuredPathError };
    } catch (e: unknown) {
      const why = e instanceof Error ? e.message : String(e);
      piWarn(`detectRustBinary: ${resolved} failed --version: ${why}`);
      noteIfConfigured(cand, `it will not run: ${firstLine(why)}`);
      continue;
    }
  }
  return { installed: false, error: "No Rust Pi binary found on PATH or common locations.", configuredPathError };
}

/** The most useful single line of a child-process failure: the dynamic linker's complaint is on
 *  its own line inside a multi-line "Command failed" blob, and it is the line that names glibc. */
export function firstLine(msg: string): string {
  const lines = msg.split("\n").map((l) => l.trim()).filter(Boolean);
  const linker = lines.find((l) => /GLIBC_|not found|cannot execute|No such file or directory|Exec format/i.test(l));
  return (linker ?? lines[0] ?? msg).slice(0, 300);
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


/** The pure decision behind the "your Rust binary isn't the tested version" notice.
 *
 *  Returns the globalState key to record when the user should be told, or null to stay quiet.
 *  Extracted from extension.ts so the dedup rule is testable — it had two bugs that both
 *  presented as SILENCE, which is exactly the failure mode a notification can't reveal:
 *
 *  1. The stored key was the DETECTED version alone. Once a user had been told about their
 *     0.1.20, moving the pin (v0.1.22 -> v0.1.23) matched the stored key and returned early —
 *     so the release the bump exists to announce never reached anyone already warned.
 *  2. Managed builds were skipped entirely, on the reasoning that "the managed build is
 *     pinned". True the day it is installed; false the moment the pin moves. That left managed
 *     users on a stale binary with no signal at all. Managed-ness belongs in the WORDING, not
 *     in whether to speak.
 */
export function rustVersionNoticeKey(
  detectedVersion: string | undefined,
  pinnedTag: string,
  alreadyWarned: string | undefined,
): string | null {
  const detected = detectedVersion?.match(/\d+\.\d+\.\d+/)?.[0];
  const pinned = pinnedTag.replace(/^v/, "");
  if (!detected || detected === pinned) { return null; }
  const key = `${detected}->${pinned}`;
  return alreadyWarned === key ? null : key;
}
