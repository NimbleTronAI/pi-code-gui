// Headless unit tests for session-file runtime classification. Header shapes are
// taken verbatim from real ~/.pi/agent sessions. Run via `pnpm run test:unit`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { mkdirSync } from "node:fs";
import { isRustSessionHeader, collectJsonlFiles, summarizeSessionFile, clearSessionSummaryCache } from "../../session-format.js";

// Real headers (see ~/.pi/agent/sessions-rust vs ~/.pi/agent/sessions).
const RUST_HEADER = '{"type":"session","version":3,"id":"6f051218","timestamp":"2026-06-06T15:04:01.670Z","cwd":"/home/node","provider":"deepseek","modelId":"deepseek-v4-pro","thinkingLevel":"off"}';
const TS_HEADER = '{"type":"session","version":3,"id":"019e319d","timestamp":"2026-05-16T16:27:35.898Z","cwd":"/home/node"}';

let dir: string;
const write = (name: string, content: string): string => {
  const p = join(dir, name);
  writeFileSync(p, content);
  return p;
};

before(() => { dir = mkdtempSync(join(tmpdir(), "sess-fmt-")); });
after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });

test("Rust header (has provider + modelId) is detected", () => {
  assert.equal(isRustSessionHeader(write("rust.jsonl", RUST_HEADER + "\n")), true);
});

test("TypeScript header (no provider/modelId) is not detected as Rust", () => {
  assert.equal(isRustSessionHeader(write("ts.jsonl", TS_HEADER + "\n")), false);
});

test("only the first line is inspected", () => {
  const multi = TS_HEADER + "\n" + '{"type":"message","message":{"role":"user","content":"hi"}}\n';
  assert.equal(isRustSessionHeader(write("multi.jsonl", multi)), false);
});

test("empty file returns false", () => {
  assert.equal(isRustSessionHeader(write("empty.jsonl", "")), false);
});

test("non-JSON first line returns false", () => {
  assert.equal(isRustSessionHeader(write("garbage.jsonl", "not json at all\n")), false);
});

test("non-session first line returns false", () => {
  assert.equal(isRustSessionHeader(write("nothdr.jsonl", '{"type":"message"}\n')), false);
});

test("missing file returns false (no throw)", () => {
  assert.equal(isRustSessionHeader(join(dir, "does-not-exist.jsonl")), false);
});

test("header with provider but no modelId is not enough", () => {
  assert.equal(isRustSessionHeader(write("partial.jsonl", '{"type":"session","provider":"deepseek"}\n')), false);
});

// ── collectJsonlFiles ────────────────────────────────────────────────
test("collectJsonlFiles: finds .jsonl files and recurses up to maxDepth", () => {
  const root = mkdtempSync(join(tmpdir(), "collect-"));
  writeFileSync(join(root, "a.jsonl"), "");
  writeFileSync(join(root, "skip.txt"), "");
  mkdirSync(join(root, "sub"));
  writeFileSync(join(root, "sub", "b.jsonl"), "");
  mkdirSync(join(root, "sub", "deep"));
  writeFileSync(join(root, "sub", "deep", "c.jsonl"), "");

  // depth 1: root's a.jsonl + sub/b.jsonl, but NOT sub/deep/c.jsonl
  const depth1 = collectJsonlFiles(root, 1).map((p) => relative(root, p)).sort();
  assert.deepEqual(depth1, ["a.jsonl", join("sub", "b.jsonl")].sort());

  const depth2 = collectJsonlFiles(root, 2);
  assert.equal(depth2.length, 3); // now includes sub/deep/c.jsonl
  assert.ok(depth2.every((p) => p.endsWith(".jsonl")));
  rmSync(root, { recursive: true, force: true });
});

test("collectJsonlFiles: missing directory returns [] (no throw)", () => {
  assert.deepEqual(collectJsonlFiles(join(dir, "nope"), 2), []);
});

// ── summarizeSessionFile ─────────────────────────────────────────────
test("summarizeSessionFile: extracts name, cwd, counts, and first user message", () => {
  const content = [
    '{"type":"session","timestamp":"2026-06-06T15:04:01.670Z","name":"My Session","cwd":"/work/proj"}',
    '{"type":"message","message":{"role":"user","content":"first question"}}',
    '{"type":"message","message":{"role":"assistant","content":"answer"}}',
    '{"type":"message","message":{"role":"user","content":"second"}}',
  ].join("\n") + "\n";
  const r = summarizeSessionFile(write("summary.jsonl", content));
  assert.ok(r);
  assert.equal(r.cwd, "/work/proj");
  assert.equal(r.summary.name, "My Session");
  assert.equal(r.summary.messageCount, 3);
  assert.equal(r.summary.firstMessage, "first question");
  assert.equal(r.summary.runtime, "rust");
  assert.equal(r.summary.created, Date.parse("2026-06-06T15:04:01.670Z"));
});

test("summarizeSessionFile: reads the first user message from a content-block array", () => {
  const content = [
    '{"type":"session","timestamp":"2026-06-06T15:04:01.670Z"}',
    '{"type":"message","message":{"role":"user","content":[{"type":"text","text":"block text"}]}}',
  ].join("\n") + "\n";
  const r = summarizeSessionFile(write("blocks.jsonl", content));
  assert.equal(r!.summary.firstMessage, "block text");
});

test("summarizeSessionFile: session_info name overrides; skips malformed lines", () => {
  const content = [
    '{"type":"session","timestamp":"2026-06-06T15:04:01.670Z"}',
    "not json — skipped",
    '{"type":"session_info","name":"Renamed"}',
    '{"type":"message","message":{"role":"user","content":"q"}}',
  ].join("\n") + "\n";
  const r = summarizeSessionFile(write("info.jsonl", content));
  assert.equal(r!.summary.name, "Renamed");
  assert.equal(r!.summary.messageCount, 1);
});

test("summarizeSessionFile: empty file → null; missing file → null (no throw)", () => {
  assert.equal(summarizeSessionFile(write("blank.jsonl", "   \n")), null);
  assert.equal(summarizeSessionFile(join(dir, "ghost.jsonl")), null);
});

// ── summary cache (audit: the Open Sessions sweep re-read ~95 MB per refresh) ──
test("summarizeSessionFile caches on (mtime,size) and re-parses when the file changes", () => {
  clearSessionSummaryCache();
  const dir = mkdtempSync(join(tmpdir(), "sess-cache-"));
  const f = join(dir, "s.jsonl");
  try {
    writeFileSync(f, [
      JSON.stringify({ type: "session", timestamp: "2026-01-01T00:00:00Z", cwd: "/w" }),
      JSON.stringify({ type: "message", message: { role: "user", content: "first" } }),
    ].join("\n") + "\n");

    const a = summarizeSessionFile(f);
    const b = summarizeSessionFile(f);
    assert.equal(a?.summary.messageCount, 1);
    assert.equal(a, b, "unchanged file → the cached object is returned (no re-parse)");

    // Append a turn: size changes → the cache must invalidate.
    appendFileSync(f, JSON.stringify({ type: "message", message: { role: "user", content: "second" } }) + "\n");
    const c = summarizeSessionFile(f);
    assert.notEqual(c, a, "changed file → re-parsed");
    assert.equal(c?.summary.messageCount, 2, "the new turn is counted");

    clearSessionSummaryCache();
    const d = summarizeSessionFile(f);
    assert.notEqual(d, c, "clearing the cache forces a re-parse");
    assert.equal(d?.summary.messageCount, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
