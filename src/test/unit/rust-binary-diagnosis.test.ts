// Diagnosis quality for a Rust binary that will not run.
//
// Three unrelated faults all reached the user as one sentence — "RPC 'get_state' timed out after
// 15000ms": a binary that could not exec (glibc floor above the host's), an extension package the
// runtime could not load, and a cold package cache. Each of them names itself on the child's
// stderr, which we discarded. These tests pin the parts that make the reason visible.
import { test } from "node:test";
import assert from "node:assert/strict";
import { firstLine } from "../../rust-resolver.js";

test("firstLine: lifts the dynamic linker's complaint out of a multi-line failure", () => {
  // Shape of a real execFileSync rejection: the useful line is the SECOND one.
  const msg = [
    "Command failed: /home/u/.vscode-server/data/User/globalStorage/nimbletron.pi-code-gui/rust-pi/pi --version",
    "/path/pi: /lib/aarch64-linux-gnu/libm.so.6: version `GLIBC_2.43' not found (required by /path/pi)",
  ].join("\n");
  const got = firstLine(msg);
  assert.match(got, /GLIBC_2\.43/, "the glibc requirement must survive — it is the actionable part");
  assert.doesNotMatch(got, /^Command failed/, "must not return the useless first line");
});

test("firstLine: recognises the other ways a binary refuses to exec", () => {
  assert.match(firstLine("Command failed: x\n/bin/pi: cannot execute binary file: Exec format error"),
    /Exec format error/);
  assert.match(firstLine("Command failed: x\n/bin/pi: No such file or directory"),
    /No such file or directory/);
});

test("firstLine: falls back to the first line when nothing matches, and never returns empty", () => {
  assert.equal(firstLine("some opaque failure"), "some opaque failure");
  assert.equal(firstLine("\n\n  odd  \n"), "odd");
  assert.equal(firstLine(""), "");
});

test("firstLine: is bounded, so a huge blob cannot flood a notification", () => {
  assert.ok(firstLine("z".repeat(5000)).length <= 300);
});
