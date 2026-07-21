// Cover for deactivate(), which disposed sessions while iterating the LIVE `sessions` array.
// webviewPanel.dispose() fires onDidDispose → handlePanelDispose → removeSession →
// sessions.splice(), so a for…of over that same array SKIPPED every other session: its Rust
// subprocess was orphaned, and a TypeScript session's unflushed _rewriteFile() never ran —
// losing conversation entries on an ordinary window close with more than one tab open.
//
// extension.ts is imported headlessly via the vscode stub (scripts/vscode-stub.mjs); this is the
// first test to reach that module at all.
//
// HONESTY NOTE: `sessions` is module-private and only populated by activate() creating real
// panels, so a behavioural multi-session teardown test isn't reachable from here without
// exporting a test-only backdoor. Test 1 executes the real function; test 2 is a STRUCTURAL
// guard that fails if the snapshot copy is ever removed. Neither pretends to be the other.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { deactivate } from "../../extension.js";

test("deactivate() runs cleanly with no open sessions", async () => {
  await assert.doesNotReject(() => deactivate());
});

test("deactivate() iterates a COPY of sessions (dispose splices the live array mid-loop)", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  // out/test/unit → out/extension.js (the compiled module this test imports).
  const src = readFileSync(join(here, "..", "..", "extension.js"), "utf-8");
  const body = src.slice(src.indexOf("async function deactivate"));
  const loop = body.slice(0, body.indexOf("sessions.length = 0"));

  assert.match(
    loop,
    /for \(const \w+ of \[\.\.\.sessions\]\)/,
    "deactivate() must iterate a snapshot — iterating `sessions` directly skips every other session",
  );
  assert.doesNotMatch(
    loop,
    /for \(const \w+ of sessions\)\s*\{\s*\w+\.webviewPanel\.dispose/,
    "the pre-fix loop (iterating the live array while disposing) must not come back",
  );
});
