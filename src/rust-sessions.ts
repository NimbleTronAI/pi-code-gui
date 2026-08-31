// Backend-agnostic discovery of Rust Pi session files.
//
// The Rust runtime persists sessions as JSONL (v3 tree + a SQLite sidecar
// index). Its built-in default sessions directory is the SAME as the
// TypeScript SDK's (~/.pi/agent/sessions), but the two formats are NOT
// cross-readable — so we deliberately point the Rust runtime at its OWN
// storage directory (`sessions-rust`) to keep the formats isolated. The
// unified Past Sessions list is then a *presentation* merge of two separately
// listed pools.
//
// There is no `--list-sessions` flag and no RPC list command, so we read the
// Rust storage directory directly, tolerant of any per-file parse error, and
// filter by each session header's recorded `cwd`.

import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { SessionSummary } from "./types.js";
import { collectJsonlFiles, summarizeSessionFile, RUST_SESSION_NAME_ENTRY } from "./session-format.js";

export { RUST_SESSION_NAME_ENTRY };

/** Where Rust session JSONLs live: ~/.pi/agent/sessions-rust, and deliberately NOT derived
 *  from the agent home.
 *
 *  This used to read process.env.PI_CODING_AGENT_DIR — a variable the extension sets on the
 *  CHILD process and never on its own — so it always resolved to the default anyway. Making it
 *  genuinely follow the agent home would be worse than the bug: sessions are USER DATA, and
 *  moving the agent home would strand every existing
 *  session where the Past Sessions list can no longer see it.
 *
 *  So the location is stated once, explicitly. `pi-code-gui.sessionDir` / PI_SESSIONS_DIR
 *  remain the supported ways to move sessions; `rustAgentDir` moves only what the extension
 *  writes. The pool stays separate from the TypeScript SDK's because the two JSONL formats are
 *  not cross-readable. */
function rustSessionsRoot(): string {
  return path.join(os.homedir(), ".pi", "agent");
}

/**
 * The directory the Rust runtime is pointed at via `--session-dir`, kept
 * separate from the TypeScript SDK's pool so the divergent JSONL formats never
 * collide. Honors an explicit `sessionDir` setting / `PI_SESSIONS_DIR` env by
 * nesting a `rust/` subdirectory under it.
 */
export function rustSessionStorageDir(): string {
  const cfg = vscode.workspace.getConfiguration("pi-code-gui").get<string>("sessionDir")?.trim();
  if (cfg) { return path.join(cfg, "rust"); }
  const env = process.env.PI_SESSIONS_DIR?.trim();
  if (env) { return path.join(env, "rust"); }
  return path.join(rustSessionsRoot(), "sessions-rust");
}

/** Value passed to the Rust binary's `--session-dir` flag (always defined). */
export function resolveRustSessionDir(): string {
  return rustSessionStorageDir();
}

/** True if a session file path belongs to the Rust pool (used for origin inference). */
export function isRustSessionPath(p: string): boolean {
  try {
    const base = path.resolve(rustSessionStorageDir());
    return path.resolve(p).startsWith(base);
  } catch {
    return false;
  }
}

/** List Rust past sessions for `cwd`, newest first. Returns [] on any failure. */
export function listRustSessions(cwd: string): SessionSummary[] {
  const files = collectJsonlFiles(rustSessionStorageDir(), 2);
  const out: SessionSummary[] = [];
  const target = path.resolve(cwd);
  for (const f of files) {
    const r = summarizeSessionFile(f);
    if (!r) { continue; }
    // Keep sessions whose recorded cwd matches the workspace (or that omit cwd).
    if (r.cwd && path.resolve(r.cwd) !== target) { continue; }
    out.push(r.summary);
  }
  out.sort((a, b) => (b.modified ?? b.created ?? 0) - (a.modified ?? a.created ?? 0));
  return out;
}
