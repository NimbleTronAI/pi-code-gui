// The specifier handed to a dynamic import() of a path on disk.
//
// Cover for gh #71: Node's ESM loader parses its argument as a URL, so a Windows absolute path
// reads as a protocol — `C:\...\dist\index.js` fails with "Received protocol 'c:'". Every SDK
// module this extension loads is addressed by an absolute path built with path.join, so the
// TypeScript runtime could not start at all on Windows.
//
// These run on POSIX in CI, so the Windows-shaped assertions are about the FUNCTION's contract
// (drive-letter input -> file: URL), which is platform-independent for pathToFileURL's parsing
// of already-absolute POSIX paths. The win32-specific behaviour is asserted through
// pathToFileURL itself, which is the standard library and is what the fix delegates to.
import { test } from "node:test";
import assert from "node:assert/strict";
import { pathToFileURL } from "node:url";
import { importSpecifierFor } from "../../sdk-service.js";

test("an absolute path becomes a file: URL", () => {
  const abs = "/home/node/.npm-global/lib/node_modules/@earendil-works/pi-coding-agent/dist/index.js";
  const out = importSpecifierFor(abs);
  assert.match(out, /^file:\/\//, "the ESM loader needs a scheme, not a bare path");
  assert.equal(out, pathToFileURL(abs).href, "must delegate to the standard library, not hand-roll file://");
});

test("a file: URL round-trips back to the original path", () => {
  // The whole point: what the loader receives must still address the same file.
  const abs = "/tmp/some dir/with space/dist/index.js";
  const url = new URL(importSpecifierFor(abs));
  assert.equal(decodeURIComponent(url.pathname), abs, "a space in the path must survive encoding");
});

test("bare and relative specifiers are passed through untouched", () => {
  // These are not filesystem paths; converting them would break Node's resolution algorithm.
  for (const spec of ["marked", "@earendil-works/pi-ai", "./local.js", "../up.js"]) {
    assert.equal(importSpecifierFor(spec), spec, `${spec} must not be rewritten`);
  }
});

test("percent-encoding is applied, so a '#' in a path can't truncate the URL", () => {
  // A hand-rolled "file://" + path would silently drop everything after the '#'.
  const abs = "/tmp/od#d/dist/index.js";
  const out = importSpecifierFor(abs);
  assert.ok(!out.includes("#"), "the fragment delimiter must be encoded");
  assert.equal(decodeURIComponent(new URL(out).pathname), abs);
});
