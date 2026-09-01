// Regression cover for the entry the extension appends to a Rust session JSONL to record the
// tab's display name.
//
// THE BUG THIS EXISTS FOR: we appended a `session_info` entry — a type rust-pi itself knows —
// carrying an extension-generated id and `parentId: null`. rust-pi builds a tree from the entry
// types it recognises; ours didn't fit, and the build failed WHOLESALE. One appended line turned
// an intact 137-message session into `get_messages -> {"messages":[]}`, so resuming opened a
// blank tab and the model started with no context. Eight sessions (490 messages) were affected
// before it was caught.
//
// Verified black-box against rust-pi 0.1.22 by driving `--mode rpc` on real session files:
//   clean baseline .............. 136 messages
//   + unknown entry type ........ 136   <- what we do now (also 4-in-a-row, and interleaved)
//   + `session_info` ............   0   <- what we used to do
//   + duplicated real entry .....   0   (same tree-collision mechanism)
//   + extra field on the header . 136
//
// These tests can't run the binary, so they guard the two things that a headless test CAN pin:
// the type we write must never again be one rust-pi owns, and both the new and legacy types must
// still READ (titles written before the fix have to survive).
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  RUST_SESSION_NAME_ENTRY,
  censusSessionFile,
  summarizeSessionFile,
  clearSessionSummaryCache,
} from "../../session-format.js";

const HEADER = '{"type":"session","version":3,"id":"62b29024","timestamp":"2026-07-21T13:16:43.777Z","cwd":"/workspaces/pi-vscode-gui","provider":"deepseek","modelId":"deepseek-v4-pro"}';
const MSG = (t: string): string => JSON.stringify({ type: "message", message: { role: "user", content: t } });

function withDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "pi-name-"));
  try { return fn(dir); } finally { rmSync(dir, { recursive: true, force: true }); }
}

test("the name entry type is NOT one rust-pi owns", () => {
  // The precise regression: `session_info` is fatal to rust-pi's loader. Anything namespaced to
  // this extension is skipped harmlessly. If someone ever "tidies" this back to a bare, plausible
  // name, this fails.
  assert.notEqual(RUST_SESSION_NAME_ENTRY, "session_info");
  assert.ok(
    RUST_SESSION_NAME_ENTRY.startsWith("pi-code-gui."),
    `the name entry must be namespaced to this extension so rust-pi treats it as unknown; got ${RUST_SESSION_NAME_ENTRY}`,
  );
});

test("the extension no longer writes the name entry at all — the binary does", () => {
  // This used to assert the shape of our own append (namespaced type, no tree fields, because
  // id/parentId are what made the old entry look like a tree node to rust-pi). That append is
  // gone: rust-pi 0.3.0's set_session_name writes the entry itself, while it owns the file.
  // What matters now is that the extension does not write into that JSONL behind the binary.
  const raw = readFileSync(new URL("../../pi-service.js", import.meta.url), "utf-8");
  const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  // Narrowly the RUST naming path: _forcePersistEntry still appends for the TypeScript SDK
  // (tools_active_change and friends), which is a different file and a different owner.
  assert.doesNotMatch(src, /_appendRustSessionInfo/, "the Rust name append helper is gone");
  assert.doesNotMatch(src, /_flushRustSessionInfo/, "and its idle-gated flush with it");
  assert.match(src, /setSessionName\(name\)/, "naming goes through the backend seam");
});


test("summarizeSessionFile reads the NEW name entry", () => {
  withDir((dir) => {
    clearSessionSummaryCache();
    const p = join(dir, "s.jsonl");
    writeFileSync(p, [HEADER, MSG("hi"), JSON.stringify({ type: RUST_SESSION_NAME_ENTRY, timestamp: "2026-07-21T21:00:00.000Z", name: "my title" })].join("\n") + "\n");
    assert.equal(summarizeSessionFile(p)?.summary.name, "my title");
  });
});

test("summarizeSessionFile still reads the LEGACY session_info name", () => {
  // Sessions titled before the fix carry their name this way. Dropping the legacy read would
  // silently blank every existing tab title.
  withDir((dir) => {
    clearSessionSummaryCache();
    const p = join(dir, "s.jsonl");
    writeFileSync(p, [HEADER, MSG("hi"), JSON.stringify({ type: "session_info", id: "pi-ext-1", parentId: null, timestamp: "2026-07-20T21:00:00.000Z", name: "old title" })].join("\n") + "\n");
    assert.equal(summarizeSessionFile(p)?.summary.name, "old title");
  });
});

test("censusSessionFile counts messages and legacy entries — the loud-fail inputs", () => {
  withDir((dir) => {
    const p = join(dir, "s.jsonl");
    writeFileSync(p, [
      HEADER, MSG("a"), MSG("b"), MSG("c"),
      JSON.stringify({ type: "session_info", name: "x" }),
      JSON.stringify({ type: "session_info", name: "y" }),
      JSON.stringify({ type: RUST_SESSION_NAME_ENTRY, name: "z" }),
    ].join("\n") + "\n");
    const c = censusSessionFile(p);
    assert.equal(c?.messages, 3);
    // Only the FATAL type is counted — the namespaced one is harmless and must not be reported
    // as a cause.
    assert.equal(c?.legacyNameEntries, 2);
  });
});

test("censusSessionFile: unreadable file → null, empty session → zeroes", () => {
  withDir((dir) => {
    assert.equal(censusSessionFile(join(dir, "nope.jsonl")), null);
    const p = join(dir, "fresh.jsonl");
    writeFileSync(p, HEADER + "\n");
    assert.deepEqual(censusSessionFile(p), { messages: 0, legacyNameEntries: 0 });
  });
});

test("the guard fires only when the file has messages the runtime didn't load", () => {
  // Encodes the decision table for warnIfHistoryWasNotLoaded, so the "genuinely new session"
  // case can't regress into a false alarm on every fresh Rust tab.
  const src = readFileSync(new URL("../../rust-service.js", import.meta.url), "utf-8");
  const start = src.indexOf("warnIfHistoryWasNotLoaded(loaded");
  assert.notEqual(start, -1, "the guard exists");
  const body = src.slice(start, src.indexOf("\n    }", src.indexOf("custom-message", start)));
  assert.match(body, /loaded > 0/, "returns early when history DID load");
  assert.match(body, /messages === 0/, "returns early when the file is genuinely empty");
  assert.match(body, /legacyNameEntries/, "names the session_info cause when present");
});
