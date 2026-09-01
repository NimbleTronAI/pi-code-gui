// Headless tests for the extracted slash-command assembly + parsing (src/slash-commands.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src");
import { buildSlashCommandList, parseSlashCommand, type SlashCommand } from "../../slash-commands.js";
import type { BackendCapabilities } from "../../pi-backend.js";

const cmds = (list: SlashCommand[]): string[] => list.map((c) => c.cmd);

/** A capabilities object with everything off except what a test flips on. */
function caps(over: Partial<BackendCapabilities> = {}): BackendCapabilities {
  return {
    kind: "rust", toolsPicker: false, sessionModes: false, fork: false,
    reloadContext: false, exportHtml: false, interceptSlashCommands: false,
    thinkingLevelLive: () => true, ...over,
  };
}

test("buildSlashCommandList: agent commands first, then the always-on GUI commands", () => {
  const agent: SlashCommand[] = [{ cmd: "/tldr", desc: "summarize", source: "extension" }];
  const list = buildSlashCommandList(agent, caps());
  assert.equal(list[0].cmd, "/tldr"); // agent commands lead
  for (const c of ["/model", "/new", "/compact", "/settings", "/login", "/logout", "/debug"]) {
    assert.ok(cmds(list).includes(c), `${c} present`);
  }
});

test("buildSlashCommandList: capability-gated commands appear only when enabled", () => {
  // All gates off (bare Rust) → none of the gated commands.
  const off = cmds(buildSlashCommandList([], caps()));
  for (const c of ["/resume", "/fork", "/export", "/tools"]) { assert.ok(!off.includes(c), `${c} absent`); }

  // fork → resume + fork.
  assert.ok(cmds(buildSlashCommandList([], caps({ fork: true }))).includes("/fork"));
  assert.ok(cmds(buildSlashCommandList([], caps({ fork: true }))).includes("/resume"));

  // toolsPicker → tools.
  assert.ok(cmds(buildSlashCommandList([], caps({ toolsPicker: true }))).includes("/tools"));
});

test("buildSlashCommandList: /export follows the CAPABILITY, on either runtime", () => {
  // This test previously asserted `exportHtml AND kind === "typescript"` — enshrining a leak
  // rather than protecting a behaviour. Both dual-runtime reviews flagged it independently: the
  // identity conjunct existed only because the handler reached for `this.session.exportToHtml`
  // (null on Rust). The handler now goes through PiBackend.exportToHtml, which BOTH backends
  // implement, so the capability alone decides — as it always claimed to.
  for (const kind of ["rust", "typescript"] as const) {
    assert.ok(cmds(buildSlashCommandList([], caps({ kind, exportHtml: true }))).includes("/export"),
      `${kind} advertises /export when the capability is on`);
    assert.ok(!cmds(buildSlashCommandList([], caps({ kind, exportHtml: false }))).includes("/export"),
      `${kind} hides /export when the capability is off`);
  }
});

test("/export is intercepted by the webview, so Rust never forwards it to the model", () => {
  // interceptSlashCommands is false on Rust, so anything not in the webview's local list is sent
  // to the binary as a literal prompt — a billed turn answering a question about the word
  // "/export" instead of exporting. Session artefacts show exactly that happening with /models.
  const state = readFileSync(join(SRC_DIR, "webview", "state.ts"), "utf-8");
  // Anchor on the ARRAY LITERAL, not the interface field (`localSlashCommands: string[]`),
  // whose `]` would truncate the slice to nothing and pass vacuously.
  const start = state.indexOf("localSlashCommands: [");
  assert.notEqual(start, -1, "the local-interception array must exist");
  const block = state.slice(start, state.indexOf("],", start));
  assert.match(block, /"\/export"/,
    "/export must be locally intercepted or Rust bills a model turn for it");
  assert.match(block, /"\/new"/, "sanity: the anchor really is the array");
});

test("parseSlashCommand: name only → cmd, empty arg", () => {
  assert.deepEqual(parseSlashCommand("/model"), { cmd: "model", arg: "" });
  assert.deepEqual(parseSlashCommand("/new"), { cmd: "new", arg: "" });
});

test("parseSlashCommand: argument is everything after the first space, trimmed", () => {
  assert.deepEqual(parseSlashCommand("/name  My Session  "), { cmd: "name", arg: "My Session" });
  assert.deepEqual(parseSlashCommand("/export /tmp/out.html"), { cmd: "export", arg: "/tmp/out.html" });
  // Compact with a multi-word instruction keeps the spaces inside the arg.
  assert.deepEqual(parseSlashCommand("/compact keep the test plan"), { cmd: "compact", arg: "keep the test plan" });
});

test("parseSlashCommand: a trailing space with no arg → empty arg (no crash, no phantom name)", () => {
  assert.deepEqual(parseSlashCommand("/name "), { cmd: "name", arg: "" });
});
