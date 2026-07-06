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

// ── formatMissingToolsNotice — docs-only, clickable links ─────────────
// The notice names the missing tools and links each tool's own per-OS install guide
// as an explicit `[label](url)` markdown link (bare URLs don't autolink in the webview,
// so they'd render as dead text). No synthesized shell command: correct on every OS,
// and nothing to mangle in the pre-`marked` fallback. No markdown code markers.

test("notice uses clickable [install guide](url) links, no shell command, no code markers", () => {
  const msg = formatMissingToolsNotice([
    { name: "fd", docs: find.docs },
    { name: "rg", docs: grep.docs },
  ]);
  assert.ok(!msg.includes("`"), "no markdown code markers");
  assert.ok(!/apt-get|brew install|sudo /.test(msg), "no synthesized package-manager command");
  assert.match(msg, /fd and rg/);
  assert.ok(msg.includes(`[install guide](${find.docs})`), "fd guide is an explicit markdown link");
  assert.ok(msg.includes(`[install guide](${grep.docs})`), "rg guide is an explicit markdown link");
});

test("notice lists one 'name — [install guide](url)' line per missing tool", () => {
  const msg = formatMissingToolsNotice([
    { name: "fd", docs: find.docs },
    { name: "rg", docs: grep.docs },
  ]);
  const lines = msg.split("\n");
  assert.equal(lines[lines.length - 2], `fd — [install guide](${find.docs})`);
  assert.equal(lines[lines.length - 1], `rg — [install guide](${grep.docs})`);
});

test("single missing tool -> 'it' (not 'them'), one guide link", () => {
  const msg = formatMissingToolsNotice([{ name: "rg", docs: grep.docs }]);
  assert.match(msg, /install it\. Each tool's install guide/);
  assert.ok(msg.trimEnd().endsWith(`rg — [install guide](${grep.docs})`));
});
