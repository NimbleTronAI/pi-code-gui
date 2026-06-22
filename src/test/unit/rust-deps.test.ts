// Headless unit tests for the rust-pi tool-dependency command builder.
// Run via `pnpm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installCommandForPlatform, RUST_TOOL_DEPS } from "../../rust-deps.js";

const find = RUST_TOOL_DEPS.find((d) => d.tool === "find")!;
const grep = RUST_TOOL_DEPS.find((d) => d.tool === "grep")!;

test("dep table covers find->fd and grep->rg", () => {
  assert.ok(find && find.cmds.includes("fd") && find.cmds.includes("fdfind") && find.apt === "fd-find");
  assert.ok(grep && grep.cmds.includes("rg") && grep.apt === "ripgrep" && grep.brew === "ripgrep");
});

test("linux: both missing -> apt install both + fd symlink fallback", () => {
  const cmd = installCommandForPlatform([find, grep], "linux");
  assert.ok(cmd!.includes("apt-get install -y fd-find ripgrep"));
  assert.ok(cmd!.includes("ln -sf") && cmd!.includes("fdfind"), "fd symlink fallback present");
});

test("linux: only grep missing -> no fd symlink clause", () => {
  const cmd = installCommandForPlatform([grep], "linux");
  assert.ok(cmd!.includes("apt-get install -y ripgrep"));
  assert.ok(!cmd!.includes("fdfind"), "no fd symlink when find isn't missing");
});

test("darwin: brew install", () => {
  assert.equal(installCommandForPlatform([find, grep], "darwin"), "brew install fd ripgrep");
});

test("win32 / unknown platform -> null (caller shows docs)", () => {
  assert.equal(installCommandForPlatform([find, grep], "win32"), null);
});

test("empty missing set -> null", () => {
  assert.equal(installCommandForPlatform([], "linux"), null);
});
