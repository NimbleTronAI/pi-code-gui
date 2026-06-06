// Package operations driven through the Rust Pi binary (`rust-pi
// install/remove/update/list/doctor`). Pi treats packages as a single shared
// ecosystem across both runtimes — the same npm-format packages install into
// the same `.pi/` locations the TypeScript SDK uses — so this is an alternate
// *backend* to the one catalog, NOT a second catalog. It is used when the
// TypeScript SDK isn't available (Rust-only installs), and its `doctor` check
// powers the "available vs active" distinction for focused Rust sessions.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { detectRustBinary, shouldDisableRustExtensions } from "./rust-resolver.js";
import { piLog, piWarn } from "./logger.js";

const execFileAsync = promisify(execFile);

export interface RustListedPackage {
  source: string;
  scope: "user" | "project";
  installedPath?: string;
}

/** Provenance / safety signals parsed from `rust-pi info`. */
export interface RustPackageInfo {
  source?: string;        // npm / git / local
  risk?: string;          // low | medium | high
  confidence?: string;    // low | medium | high
  license?: string;
  capabilities?: string;  // e.g. "none", "exec,http"
  categories?: string;
}

/** Whether a focused Rust session can actually load a package, and why not. */
export type RustLoadability = { loads: boolean; reason: "disabled" | "incompatible" | "ok" | "unknown" };

/** Run a rust-pi subcommand, returning stdout (and stderr) regardless of exit code. */
async function runRust(args: string[], timeoutMs = 60000): Promise<{ code: number; stdout: string; stderr: string }> {
  const status = detectRustBinary();
  if (!status.installed || !status.binaryPath) {
    throw new Error("Rust Pi binary not found.");
  }
  try {
    const { stdout, stderr } = await execFileAsync(status.binaryPath, args, { timeout: timeoutMs, maxBuffer: 8 * 1024 * 1024 });
    return { code: 0, stdout: stdout ?? "", stderr: stderr ?? "" };
  } catch (e: unknown) {
    // execFile rejects on non-zero exit; the payload still carries stdout/stderr.
    const err = e as { code?: number; stdout?: string; stderr?: string; message?: string };
    return { code: typeof err.code === "number" ? err.code : 1, stdout: err.stdout ?? "", stderr: err.stderr ?? err.message ?? "" };
  }
}

/**
 * Parse `rust-pi list` output into installed packages. The format is:
 *
 *   Project packages:
 *     npm:pi-web-access
 *       /abs/path/.pi/npm/node_modules/pi-web-access
 *       Safety: npm/unknown/unknown/unknown/low
 *   Global packages:
 *     npm:foo
 *       /home/.../packages/foo
 *
 * A source line is indented exactly 2 spaces; its install path is the deeper
 * indented line that follows. Section headers set the scope.
 */
function parseList(stdout: string): RustListedPackage[] {
  const out: RustListedPackage[] = [];
  let scope: "user" | "project" = "user";
  const lines = stdout.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();
    if (/^project packages:/i.test(trimmed)) { scope = "project"; continue; }
    if (/^(global|user) packages:/i.test(trimmed)) { scope = "user"; continue; }
    // Source lines are indented exactly two spaces (deeper lines — path / Safety
    // — have ≥4 and so fail the `\S` at column 3).
    const m = line.match(/^ {2}(\S.*)$/);
    if (!m) { continue; }
    const value = m[1].trim();
    if (value.startsWith("Safety:")) { continue; }
    const next = lines[i + 1] ?? "";
    const pm = next.match(/^ {3,}(\/\S.*)$/);
    out.push({ source: value, scope, installedPath: pm ? pm[1].trim() : undefined });
  }
  return out;
}

/** List installed packages from the shared store via the Rust binary. */
export async function rustListInstalled(): Promise<RustListedPackage[]> {
  try {
    const { stdout } = await runRust(["list"], 20000);
    return parseList(stdout);
  } catch (e: unknown) {
    piWarn(`rustListInstalled: ${e instanceof Error ? e.message : String(e)}`);
    return [];
  }
}

/** Install a package (`npm:`/`git:`/local path) into the shared store. */
export async function rustInstall(source: string, local: boolean): Promise<{ success: boolean; error?: string }> {
  const args = ["install", source];
  if (local) { args.push("--local"); }
  const { code, stdout, stderr } = await runRust(args, 180000);
  if (code === 0) { return { success: true }; }
  return { success: false, error: (stderr || stdout || `rust-pi install exited ${code}`).trim().slice(0, 500) };
}

/** Remove a package from the shared store / settings. */
export async function rustRemove(source: string, local: boolean): Promise<{ success: boolean; error?: string }> {
  const args = ["remove", source];
  if (local) { args.push("--local"); }
  const { code, stdout, stderr } = await runRust(args, 60000);
  if (code === 0) { return { success: true }; }
  return { success: false, error: (stderr || stdout || `rust-pi remove exited ${code}`).trim().slice(0, 500) };
}

/** Update one package (or all when `source` is omitted). */
export async function rustUpdate(source?: string): Promise<{ success: boolean; error?: string }> {
  const args = source ? ["update", source] : ["update"];
  const { code, stdout, stderr } = await runRust(args, 180000);
  if (code === 0) { return { success: true }; }
  return { success: false, error: (stderr || stdout || `rust-pi update exited ${code}`).trim().slice(0, 500) };
}

/**
 * Whether the Rust runtime can load the extension at `installedPath`. `doctor`
 * prints a per-extension verdict; a hard `[FAIL]` means Rust can't parse it
 * (the TypeScript-format manifests behind our interop fix). Warnings still load.
 */
async function rustDoctorCompatible(installedPath: string): Promise<boolean> {
  const { code, stdout } = await runRust(["doctor", installedPath], 20000);
  if (/\[FAIL\]/.test(stdout)) { return false; }
  if (/incompatible/i.test(stdout)) { return false; }
  if (/compatible/i.test(stdout)) { return true; }
  // No explicit verdict (e.g. doctor errored): trust the exit code.
  return code === 0;
}

/** Parse the `Safety:` / `Signals:` / `License:` rows out of `rust-pi info`. */
function parseInfo(stdout: string): RustPackageInfo {
  const lines = stdout.replace(/[│┌┐└┘├┤─]/g, " ").split("\n").map((l) => l.trim());
  const grab = (label: string): string | undefined => {
    const re = new RegExp(`^${label}:\\s*(.+)$`, "i");
    for (const l of lines) { const m = l.match(re); if (m) { return m[1].trim(); } }
    return undefined;
  };
  const info: RustPackageInfo = {};
  const license = grab("License"); if (license) { info.license = license; }
  const safety = grab("Safety");
  if (safety) {
    info.source = safety.match(/source=(\S+)/)?.[1];
    info.risk = safety.match(/risk=(\S+)/)?.[1];
    info.confidence = safety.match(/confidence=(\S+)/)?.[1];
  }
  const signals = grab("Signals");
  if (signals) {
    info.capabilities = signals.match(/capabilities=(\S+)/)?.[1];
    info.categories = signals.match(/categories=(\S+)/)?.[1];
  }
  return info;
}

/** Provenance / safety metadata for a package from the shared catalog. */
export async function rustInfo(name: string): Promise<RustPackageInfo | null> {
  try {
    const { stdout } = await runRust(["info", name], 20000);
    if (!/Safety:|Signals:|License:/.test(stdout)) { return null; }
    return parseInfo(stdout);
  } catch (e: unknown) {
    piWarn(`rustInfo(${name}): ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * Whether a Rust session in `cwd` would load the package installed at
 * `installedPath`. Mirrors {@link rustActiveSources} for a single package, used
 * to warn at install time. `disabled` = extension discovery off for the
 * workspace (`rustExtensions`); `incompatible` = doctor rejects the manifest.
 */
export async function rustLoadability(cwd: string, installedPath?: string): Promise<RustLoadability> {
  if (shouldDisableRustExtensions(cwd)) { return { loads: false, reason: "disabled" }; }
  if (!installedPath) { return { loads: true, reason: "unknown" }; }
  try {
    return (await rustDoctorCompatible(installedPath))
      ? { loads: true, reason: "ok" }
      : { loads: false, reason: "incompatible" };
  } catch {
    return { loads: true, reason: "unknown" };
  }
}

/**
 * The subset of `installed` that a focused Rust session in `cwd` actually loads
 * ("active"). Empty when extension discovery is disabled for the workspace
 * (`rustExtensions` / our `--no-extensions` path); otherwise the doctor-compatible
 * packages. Packages that are installed but not returned here are "available but
 * not loaded" under Rust.
 */
export async function rustActiveSources(cwd: string, installed: Array<{ source: string; installedPath?: string }>): Promise<Set<string>> {
  if (shouldDisableRustExtensions(cwd)) {
    piLog("rustActiveSources: extension discovery disabled for this workspace — 0 active");
    return new Set();
  }
  const active = new Set<string>();
  await Promise.all(installed.map(async (pkg) => {
    if (!pkg.installedPath) { active.add(pkg.source); return; } // unknown path → assume loaded
    try {
      if (await rustDoctorCompatible(pkg.installedPath)) { active.add(pkg.source); }
    } catch (e: unknown) {
      piWarn(`rustActiveSources doctor(${pkg.source}): ${e instanceof Error ? e.message : String(e)}`);
      active.add(pkg.source); // don't falsely claim "not loaded" on a probe error
    }
  }));
  return active;
}
