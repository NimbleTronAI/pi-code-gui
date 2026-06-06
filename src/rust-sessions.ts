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

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as vscode from "vscode";
import type { SessionSummary } from "./types.js";
import { piWarn } from "./logger.js";

/** The Rust agent directory (PI_CODING_AGENT_DIR or ~/.pi/agent). */
function rustAgentDir(): string {
  return process.env.PI_CODING_AGENT_DIR?.trim() || path.join(os.homedir(), ".pi", "agent");
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
  return path.join(rustAgentDir(), "sessions-rust");
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

/** Recursively collect *.jsonl files under `dir` up to `maxDepth` levels. */
function collectJsonlFiles(dir: string, maxDepth: number): string[] {
  const out: string[] = [];
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    if (e.isFile() && e.name.endsWith(".jsonl")) {
      out.push(full);
    } else if (e.isDirectory() && maxDepth > 0) {
      out.push(...collectJsonlFiles(full, maxDepth - 1));
    }
  }
  return out;
}

/** Read one JSONL session file into a SessionSummary (best-effort). Returns the
 *  recorded cwd alongside so callers can filter by workspace. */
function summarizeSessionFile(filePath: string): { summary: SessionSummary; cwd?: string } | null {
  try {
    const raw = fs.readFileSync(filePath, "utf-8");
    const lines = raw.split("\n").filter((l) => l.trim());
    if (lines.length === 0) { return null; }

    let name: string | undefined;
    let firstMessage: string | undefined;
    let messageCount = 0;
    let created: number | undefined;
    let cwd: string | undefined;

    for (const line of lines) {
      let entry: Record<string, unknown>;
      try { entry = JSON.parse(line); } catch { continue; }
      const type = entry.type as string | undefined;
      if (type === "session") {
        const ts = entry.timestamp;
        if (typeof ts === "string") { created = Date.parse(ts); }
        else if (typeof ts === "number") { created = ts; }
        if (typeof entry.name === "string") { name = entry.name; }
        if (typeof entry.cwd === "string") { cwd = entry.cwd; }
      } else if (type === "session_info" && typeof entry.name === "string") {
        name = entry.name;
      } else if (type === "message") {
        messageCount++;
        const msg = entry.message as Record<string, unknown> | undefined;
        if (!firstMessage && msg?.role === "user") {
          const content = msg.content;
          if (typeof content === "string") { firstMessage = content; }
          else if (Array.isArray(content)) {
            const textBlock = content.find((c: { type?: string }) => c?.type === "text") as { text?: string } | undefined;
            if (textBlock?.text) { firstMessage = textBlock.text; }
          }
        }
      }
    }

    let modified: number | undefined;
    try { modified = fs.statSync(filePath).mtimeMs; } catch { /* ignore */ }

    return {
      summary: {
        name,
        path: filePath,
        firstMessage: firstMessage?.slice(0, 200),
        messageCount,
        created,
        modified,
        runtime: "rust",
      },
      cwd,
    };
  } catch (e: unknown) {
    piWarn(`summarizeSessionFile(${filePath}) failed: ${e instanceof Error ? e.message : String(e)}`);
    return null;
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
