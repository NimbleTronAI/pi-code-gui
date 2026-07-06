// Pure (vscode-free) helpers for rust-pi's external tool dependencies, so they
// can be unit-tested headlessly. rust-pi's `find`/`grep` tools shell out to `fd`
// and `rg`; without them those tools fail at runtime ("please install fd-find" /
// "please install ripgrep"). Upstream documents them as prerequisites but its
// installer does not install them, so the GUI surfaces the gap and points at each
// tool's OWN install page — the authoritative, comprehensive per-OS matrix
// (apt / dnf / pacman / apk / zypper / brew / winget / scoop / cargo / binaries),
// maintained by the tool authors. We do NOT synthesize a package-manager command:
// keying off `process.platform` can't tell Debian from Fedora/Arch/Alpine, misses
// the root-without-sudo case, and would drift from what fd/ripgrep actually ship.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileP = promisify(execFile);

export interface RustToolDep {
  /** The rust-pi agent tool that needs it. */
  tool: string;
  /** Command names to probe, primary first (Debian ships fd as `fdfind`). */
  cmds: string[];
  /** The tool's own install guide — a comprehensive per-OS matrix, always current. */
  docs: string;
}

/** rust-pi's external tool deps. git/node come with the base image; coreutils are
 *  universal; tmux is interactive-TUI-only (the GUI uses `--mode rpc`). Only these
 *  two gate the GUI's agent tools. `docs` points at each tool's own install guide. */
export const RUST_TOOL_DEPS: RustToolDep[] = [
  { tool: "find", cmds: ["fd", "fdfind"], docs: "https://github.com/sharkdp/fd#installation" },
  { tool: "grep", cmds: ["rg"], docs: "https://github.com/BurntSushi/ripgrep#installation" },
];

/** Build the one-time "missing fd/rg prerequisites" chat notice — docs-only.
 *
 *  We name the missing tools and link each one's authoritative per-OS install guide
 *  rather than a synthesized shell command. Two reasons: (1) correctness — the tools'
 *  own pages cover every OS/manager and never drift; a `process.platform`-derived
 *  command is Debian/macOS-only and breaks on Fedora/Arch/Alpine/root-without-sudo.
 *  (2) copy-paste safety — no shell command means nothing to mangle when this card
 *  renders before the webview's `marked` bundle loads (the earlier bug: a
 *  backtick-wrapped apt command pasted as bash command substitution). The bare URLs
 *  carry no markdown-special characters, so they render/copy cleanly in both the
 *  marked (auto-linked) and escaped-fallback paths. */
export function formatMissingToolsNotice(missing: Array<{ name: string; docs: string }>): string {
  const names = missing.map((m) => m.name).join(" and ");
  const them = missing.length > 1 ? "them" : "it";
  const guides = missing.map((m) => `${m.name} — ${m.docs}`).join("\n");
  return `ℹ️ Rust Pi's find/grep tools need ${names} installed. They're missing, so those tools will fail until you install ${them}. Install guide for your OS:\n\n${guides}`;
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
