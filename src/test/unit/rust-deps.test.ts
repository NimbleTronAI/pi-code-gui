// Headless unit tests for the rust-pi tool-dependency command builder.
// Run via `pnpm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { installCommandForPlatform, formatMissingToolsNotice, RUST_TOOL_DEPS } from "../../rust-deps.js";

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

// ── formatMissingToolsNotice — copy-paste safety ──────────────────────
// The notice can render before the webview's `marked` bundle loads (escaped-plain-text
// fallback). Any markdown code marker (inline backtick or ``` fence) would then survive
// literally, and a pasted backtick-wrapped command becomes bash command substitution
// ("Hit:1: command not found"). So the message must carry NO code markers, and the
// command must sit on its own line so a whole-card copy still pastes as one clean command.

test("notice with an install hint carries NO backticks or fences", () => {
  const hint = installCommandForPlatform([find, grep], "linux")!;
  const msg = formatMissingToolsNotice(["fd-find", "ripgrep"], hint);
  assert.ok(!msg.includes("`"), "no markdown code markers in the notice");
  assert.match(msg, /fd-find and ripgrep/);
  assert.match(msg, /install them\. Run:/);
});

test("notice puts the install command alone on the last line (whole-card copy is clean)", () => {
  const hint = installCommandForPlatform([find, grep], "linux")!;
  const msg = formatMissingToolsNotice(["fd-find", "ripgrep"], hint);
  const lines = msg.split("\n");
  assert.equal(lines[lines.length - 1], hint, "command is verbatim on its own final line");
  assert.equal(lines[lines.length - 2], "", "blank line separates prose from the command");
});

test("single missing tool -> 'it' (not 'them')", () => {
  const msg = formatMissingToolsNotice(["ripgrep"], "sudo apt-get install -y ripgrep");
  assert.match(msg, /install it\. Run:/);
});

test("no install hint (win32) -> plain sentence, no 'Run:' dangling", () => {
  const msg = formatMissingToolsNotice(["fd-find", "ripgrep"], null);
  assert.ok(!msg.includes("Run:"), "no 'Run:' lead-in without a command");
  assert.ok(!msg.includes("`"), "still no code markers");
  assert.ok(msg.trimEnd().endsWith("install them."));
});
