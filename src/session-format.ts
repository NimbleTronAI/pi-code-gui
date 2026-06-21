// Pure (vscode-free) helpers for classifying Pi session files by their header
// line. Separated from rust-sessions.ts so it can be unit-tested headlessly
// (src/test/unit/). fs-only — no vscode import.
import * as fs from "node:fs";

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
