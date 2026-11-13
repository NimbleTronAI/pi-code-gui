// The webview ↔ host protocol (src/shared/protocol.ts) must not carry messages one side no longer
// speaks. A message the webview posts but the host's switch has no case for is silently dropped —
// a button that does nothing. A message type the host never produces leaves dead UI in the webview.
// A static scan is the right shape: the failure is a MISSING producer or handler.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const srcDir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..", "src");

function tsText(dir: string, skip: string[] = []): string {
  const parts: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) { if (!skip.includes(e.name)) { parts.push(tsText(full, skip)); } }
    else if (e.name.endsWith(".ts")) { parts.push(readFileSync(full, "utf-8")); }
  }
  return parts.join("\n");
}

const protocol = readFileSync(join(srcDir, "shared", "protocol.ts"), "utf-8");
const split = protocol.indexOf("Webview → Extension schemas");
const literals = (s: string): string[] => [...s.matchAll(/type: z\.literal\("([^"]+)"\)/g)].map((m) => m[1]);
const toWebview = literals(protocol.slice(0, split));
const toHost = literals(protocol.slice(split));

test("sanity: both directions of the protocol were found", () => {
  assert.ok(toWebview.length > 20 && toHost.length > 10, `${toWebview.length} / ${toHost.length}`);
});

test("every webview→host message type has a case in the host's message switch", () => {
  const panel = readFileSync(join(srcDir, "webview-panel.ts"), "utf-8");
  const sw = panel.slice(panel.indexOf("onDidReceiveMessage("), panel.indexOf("private setupServiceHandlers"));
  const handled = new Set([...sw.matchAll(/case "([^"]+)":/g)].map((m) => m[1]));
  const unhandled = toHost.filter((t) => !handled.has(t));
  assert.deepEqual(unhandled, [], `the webview may send these, and the host drops them: ${unhandled.join(", ")}`);
});

test("every message type the webview posts is in the webview→host schema", () => {
  const webview = tsText(join(srcDir, "webview"));
  const posted = new Set([...webview.matchAll(/post\w*\(\{\s*type:\s*"([^"]+)"/g)].map((m) => m[1]));
  const unknown = [...posted].filter((t) => !toHost.includes(t));
  assert.deepEqual(unknown, [], `posted by the webview but rejected by validation: ${unknown.join(", ")}`);
});

// Produced nowhere before this test existed, and unrelated to it; listed so the scan stays strict
// for everything else.
const KNOWN_UNPRODUCED = new Set(["user-messages-list"]);

test("every host→webview message type is produced somewhere in the extension host", () => {
  // Comments stripped, so a type named only in prose does not count as produced. Still a text
  // scan: a `type: "X"` literal in an unrelated object would pass, which is accepted here.
  const host = tsText(srcDir, ["webview", "shared", "test"])
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
  const dead = toWebview.filter((t) => !KNOWN_UNPRODUCED.has(t) && !host.includes(`type: "${t}"`));
  assert.deepEqual(dead, [], `the webview handles these, but the host never sends them: ${dead.join(", ")}`);
});
