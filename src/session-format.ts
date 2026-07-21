// Pure (vscode-free) helpers for classifying and summarizing Pi session files.
// Separated from rust-sessions.ts (which imports vscode) so they can be unit-
// tested headlessly (src/test/unit/). fs/path-only — no runtime vscode import
// (the SessionSummary import is type-only and erased; piWarn is vscode-free).
import * as fs from "node:fs";
import * as path from "node:path";
import { piWarn } from "./logger.js";
import type { SessionSummary } from "./types.js";

/**
 * Best-effort: does this session JSONL look like a Rust-runtime session? The Rust
 * runtime records `provider` + `modelId` in its `type:"session"` header line; the
 * TypeScript SDK does not. Reads only the first line; returns false on any error
 * or ambiguity so callers can fall back to their default. This is a last-resort
 * runtime inference for sessions created via the CLI, moved, or stored under a
 * custom sessionDir (where the path-prefix check no longer applies).
 */
export function isRustSessionHeader(filePath: string): boolean {
  let fd: number | null = null;
  try {
    fd = fs.openSync(filePath, "r");
    const buf = Buffer.alloc(8192);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    if (n <= 0) { return false; }
    const text = buf.toString("utf-8", 0, n);
    const nl = text.indexOf("\n");
    const firstLine = (nl >= 0 ? text.slice(0, nl) : text).trim();
    if (!firstLine) { return false; }
    const header = JSON.parse(firstLine) as Record<string, unknown>;
    return header.type === "session"
      && typeof header.provider === "string"
      && typeof header.modelId === "string";
  } catch {
    return false;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
}

/** Recursively collect `*.jsonl` files under `dir` up to `maxDepth` levels.
 *  Returns [] for a missing/unreadable directory. */
export function collectJsonlFiles(dir: string, maxDepth: number): string[] {
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

export type SessionFileSummary = { summary: SessionSummary; cwd?: string } | null;

/** Parsed-summary cache, keyed by path and invalidated by (mtimeMs, size).
 *
 *  The Open Sessions sweep re-summarizes EVERY session file on every refresh — a mature
 *  workspace is ~178 files / ~95 MB — with a synchronous readFileSync each, on the extension
 *  host thread. Session JSONLs are append-only and most never change between refreshes, so
 *  keying on the stat makes a repeat sweep cost one statSync per file instead of re-reading and
 *  re-parsing everything. A changed file (new mtime or size) re-parses normally.
 *
 *  Returned objects are SHARED with the cache — treat them as read-only (the only caller,
 *  listRustSessions, just collects and sorts them). */
const summaryCache = new Map<string, { key: string; value: SessionFileSummary }>();
const SUMMARY_CACHE_MAX = 2000;

/** Drop all cached summaries (tests, and any future explicit invalidation). */
export function clearSessionSummaryCache(): void { summaryCache.clear(); }

/** Read one JSONL session file into a SessionSummary (best-effort). Returns the
 *  recorded cwd alongside so callers can filter by workspace. Null on any failure.
 *  Cached on (mtimeMs, size) — see summaryCache. */
export function summarizeSessionFile(filePath: string): SessionFileSummary {
  // stat first: it is the cache key AND supplies `modified`, so a hit costs one syscall.
  let modified: number | undefined;
  let cacheKey = "";
  try {
    const st = fs.statSync(filePath);
    modified = st.mtimeMs;
    cacheKey = `${st.mtimeMs}:${st.size}`;
    const hit = summaryCache.get(filePath);
    if (hit && hit.key === cacheKey) { return hit.value; }
  } catch { /* unstatable: fall through and parse uncached */ }

  const value = parseSessionFile(filePath, modified);
  if (cacheKey) {
    if (summaryCache.size >= SUMMARY_CACHE_MAX) {
      const oldest = summaryCache.keys().next().value;
      if (oldest !== undefined) { summaryCache.delete(oldest); }
    }
    summaryCache.set(filePath, { key: cacheKey, value });
  }
  return value;
}

function parseSessionFile(filePath: string, modified: number | undefined): SessionFileSummary {
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
