// Headless unit tests for session-file runtime classification. Header shapes are
// taken verbatim from real ~/.pi/agent sessions. Run via `pnpm run test:unit`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isRustSessionHeader } from "../../session-format.js";

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
