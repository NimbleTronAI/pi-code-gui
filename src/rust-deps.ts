// Pure (vscode-free) helpers for rust-pi's external tool dependencies, so they
// can be unit-tested headlessly. rust-pi's `find`/`grep` tools shell out to `fd`
// and `rg`; without them those tools fail at runtime ("please install fd-find" /
// "please install ripgrep"). Upstream documents them as prerequisites
// (pi_agent_rust README "Requirements") but its installer does not install them —
// so the GUI offers the documented install after a managed Rust install
// (the vscode-facing prompt lives in rust-install.ts).
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export const RUST_DEPS_DOCS_URL = "https://github.com/Dicklesworthstone/pi_agent_rust#requirements";

export interface RustToolDep {
  /** The rust-pi agent tool that needs it. */
  tool: string;
  /** Command names to probe, primary first (Debian ships fd as `fdfind`). */
  cmds: string[];
  /** Debian/apt package name. */
  apt: string;
  /** Homebrew package name. */
  brew: string;
}

/** rust-pi's external tool deps (README "Requirements"). git/node come with the
 *  base image; coreutils are universal; tmux is interactive-TUI-only (the GUI
 *  uses `--mode rpc`). Only these two gate the GUI's agent tools. */
export const RUST_TOOL_DEPS: RustToolDep[] = [
  { tool: "find", cmds: ["fd", "fdfind"], apt: "fd-find", brew: "fd" },
  { tool: "grep", cmds: ["rg"], apt: "ripgrep", brew: "ripgrep" },
];

/** Build the documented install command for `missing` on `platform`, or null when
 *  we can't synthesize one (unknown platform → caller shows the docs instead). */
export function installCommandForPlatform(missing: RustToolDep[], platform: NodeJS.Platform): string | null {
  if (missing.length === 0) { return null; }
  if (platform === "linux") {
    const pkgs = missing.map((d) => d.apt).join(" ");
    let cmd = `sudo apt-get update && sudo apt-get install -y ${pkgs}`;
    // Debian installs fd as `fdfind`; rust-pi looks for `fd` too — symlink if needed.
    if (missing.some((d) => d.tool === "find")) {
      cmd += ' && (command -v fd >/dev/null 2>&1 || (mkdir -p "$HOME/.local/bin" && ln -sf "$(command -v fdfind)" "$HOME/.local/bin/fd"))';
    }
    return cmd;
  }
  if (platform === "darwin") {
    return `brew install ${missing.map((d) => d.brew).join(" ")}`;
  }
  return null; // win32 / unknown — fall back to docs
}

/** Probe which deps are missing. A tool counts as present if ANY of its command
 *  names responds to `--version`. */
export async function detectMissingRustTools(): Promise<RustToolDep[]> {
  const missing: RustToolDep[] = [];
  for (const d of RUST_TOOL_DEPS) {
    let present = false;
    for (const c of d.cmds) {
      try { await execFileP(c, ["--version"], { timeout: 4000 }); present = true; break; }
      catch { /* try the next candidate name */ }
    }
    if (!present) { missing.push(d); }
  }
  return missing;
}
