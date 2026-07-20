// Headless tests for the extracted slash-command assembly + parsing (src/slash-commands.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildSlashCommandList, parseSlashCommand, type SlashCommand } from "../../slash-commands.js";
import type { BackendCapabilities } from "../../pi-backend.js";

const cmds = (list: SlashCommand[]): string[] => list.map((c) => c.cmd);

/** A capabilities object with everything off except what a test flips on. */
function caps(over: Partial<BackendCapabilities> = {}): BackendCapabilities {
  return {
    kind: "rust", bridgeTools: false, customCards: false, toolsPicker: false, fork: false,
    reloadContext: false, exportHtml: false, rename: false, interceptSlashCommands: false,
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

test("buildSlashCommandList: /export needs exportHtml AND the typescript runtime", () => {
  // Rust with exportHtml (it exports too) must NOT advertise /export from chat.
  assert.ok(!cmds(buildSlashCommandList([], caps({ kind: "rust", exportHtml: true }))).includes("/export"));
  // TS with exportHtml → /export offered.
  assert.ok(cmds(buildSlashCommandList([], caps({ kind: "typescript", exportHtml: true }))).includes("/export"));
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
