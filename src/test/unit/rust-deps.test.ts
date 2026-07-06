// Headless unit tests for the rust-pi tool-dependency command builder.
// Run via `pnpm run test:unit`.
import { test } from "node:test";
import assert from "node:assert/strict";
import { formatMissingToolsNotice, RUST_TOOL_DEPS } from "../../rust-deps.js";

const find = RUST_TOOL_DEPS.find((d) => d.tool === "find")!;
const grep = RUST_TOOL_DEPS.find((d) => d.tool === "grep")!;

test("dep table covers find->fd and grep->rg with authoritative install-guide URLs", () => {
  assert.ok(find && find.cmds.includes("fd") && find.cmds.includes("fdfind"));
  assert.equal(find.docs, "https://github.com/sharkdp/fd#installation");
  assert.ok(grep && grep.cmds.includes("rg"));
  assert.equal(grep.docs, "https://github.com/BurntSushi/ripgrep#installation");
});

// ── formatMissingToolsNotice — docs-only ──────────────────────────────
// The notice names the missing tools and links each tool's own per-OS install guide.
// No synthesized shell command: correct on every OS, and nothing to mangle when the
// card renders before the webview's `marked` bundle loads (the earlier apt-in-backticks
// paste bug). It must carry NO markdown code markers and NO package-manager command.

test("notice links both tools' install guides, no shell command, no code markers", () => {
  const msg = formatMissingToolsNotice([
    { name: "fd", docs: find.docs },
    { name: "rg", docs: grep.docs },
  ]);
  assert.ok(!msg.includes("`"), "no markdown code markers");
  assert.ok(!/apt-get|brew install|sudo /.test(msg), "no synthesized package-manager command");
  assert.match(msg, /fd and rg/);
  assert.ok(msg.includes(find.docs) && msg.includes(grep.docs), "both install-guide URLs present");
  assert.match(msg, /Install guide for your OS:/);
});

test("notice lists one 'name — url' guide line per missing tool", () => {
  const msg = formatMissingToolsNotice([
    { name: "fd", docs: find.docs },
    { name: "rg", docs: grep.docs },
  ]);
  const lines = msg.split("\n");
  assert.equal(lines[lines.length - 2], `fd — ${find.docs}`);
  assert.equal(lines[lines.length - 1], `rg — ${grep.docs}`);
});

test("single missing tool -> 'it' (not 'them'), one guide line", () => {
  const msg = formatMissingToolsNotice([{ name: "rg", docs: grep.docs }]);
  assert.match(msg, /install it\. Install guide/);
  assert.ok(msg.trimEnd().endsWith(`rg — ${grep.docs}`));
});
