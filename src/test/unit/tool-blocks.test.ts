// Behavioural cover for state.currentToolBlocks, whose declared type was
//
//   Record<string, { el: HTMLElement; renderer?: unknown } | HTMLElement | undefined>
//
// The bare-HTMLElement arm was never produced by any writer, but nine read sites carried an
// `(entry as any).el || entry` fallback for it. That fallback was not merely dead — it was
// actively misleading: had `el` ever been falsy it would have yielded the ENTRY OBJECT, and the
// read sites that call `block.getAttribute(...)` unguarded would then have thrown on it. Removing
// the arm is only safe if every writer really does store the pair, so that is what these tests
// pin down — behaviourally, through the real handlers under jsdom, plus one static guard that
// fails if a future writer reintroduces the bare-element shape.
//
// Harness mirrors dispatch.test.ts: the webview is compiled separately by
// tsconfig.test-webview.json and imported through VARIABLE specifiers so the main tsc (which
// excludes src/webview) doesn't try to type-check it.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { JSDOM } from "jsdom";

const HTML = `<!DOCTYPE html><html><body>
  <div id="chat-container"></div>
  <textarea id="prompt-input"></textarea>
  <button id="send-button"></button>
  <button id="abort-button"></button>
  <button id="steer-dropdown"></button>
  <div id="welcome"></div>
  <div id="attachment-bar"></div>
  <div id="user-msg-overlay"></div>
  <div id="settings-overlay"></div>
  <div id="slash-autocomplete"></div>
  <div id="live-panel"></div>
</body></html>`;

let handlers: any;
let stateMod: any;
let toolsMod: any;
let debugMod: any;

before(async () => {
  const dom = new JSDOM(HTML, { pretendToBeVisual: true });
  const g = globalThis as any;
  g.window = dom.window;
  g.document = dom.window.document;
  g.requestAnimationFrame = dom.window.requestAnimationFrame
    ? dom.window.requestAnimationFrame.bind(dom.window)
    : (cb: any) => setTimeout(() => cb(Date.now()), 0);
  g.cancelAnimationFrame = dom.window.cancelAnimationFrame
    ? dom.window.cancelAnimationFrame.bind(dom.window)
    : (id: any) => clearTimeout(id);

  g.marked = { parse: (t: string) => t, lexer: (_t: string) => [], setOptions: () => {} };
  // Both spellings: engine.ts's morphRender calls `window.morphdom`, while other call sites use
  // the bare global. Stubbing only one leaves the bash-output path throwing.
  g.morphdom = (_from: any, _to: any) => { /* no-op */ };
  (dom.window as any).morphdom = g.morphdom;
  g.hljs = { highlight: (code: string) => ({ value: code }), highlightAuto: (code: string) => ({ value: code }), getLanguage: () => undefined };
  const vscodeStub = { postMessage: () => {}, getState: () => ({}), setState: () => {} };
  (dom.window as any).__vscode = vscodeStub;
  g.__vscode = vscodeStub;
  g.acquireVsCodeApi = () => vscodeStub;

  const handlersSpec = "../../webview/handlers/index.js";
  const stateSpec = "../../webview/state.js";
  const toolsSpec = "../../webview/tools/index.js";
  const debugSpec = "../../webview/debug.js";
  handlers = await import(handlersSpec);
  stateMod = await import(stateSpec);
  toolsMod = await import(toolsSpec);
  debugMod = await import(debugSpec);
  stateMod.initState(dom.window.document);
});

/** Clear the live maps between tests — the handlers share module-level state. */
function reset(): void {
  for (const k of Object.keys(stateMod.state.currentToolBlocks)) { delete stateMod.state.currentToolBlocks[k]; }
  for (const k of Object.keys(stateMod.state.bashBlocks)) { delete stateMod.state.bashBlocks[k]; }
  for (const k of Object.keys(stateMod.state.bashOutputs)) { delete stateMod.state.bashOutputs[k]; }
}

test("handleToolStart stores the {el, renderer} PAIR — never a bare element", () => {
  reset();
  toolsMod.handleToolStart({ toolCallId: "c1", toolName: "write", args: { path: "a.ts", content: "x" }, fromMessage: false });

  const entry: any = stateMod.state.currentToolBlocks["c1"];
  assert.ok(entry, "an entry was created");
  assert.equal("tagName" in entry, false, "the entry is NOT a bare element — that arm is what the refactor deleted");
  assert.ok(entry.el && entry.el.tagName, "entry.el is the card element");
  assert.equal(typeof entry.renderer, "object", "entry.renderer is the renderer that made the card");
  assert.equal(typeof entry.renderer.finalize, "function", "…and it can finalize the card later");
});

test("the bash-promotion path also stores the pair (bash block adopted by tool-start)", () => {
  reset();
  handlers.handleBashStart({ toolCallId: "c2", command: "ls -la", entryId: "e2" });
  const bashEl = stateMod.state.bashBlocks["c2"];
  assert.ok(bashEl, "handleBashStart created a bash block");
  assert.equal(stateMod.state.currentToolBlocks["c2"], undefined, "…and nothing in currentToolBlocks yet");

  toolsMod.handleToolStart({ toolCallId: "c2", toolName: "bash", args: { command: "ls -la" }, fromMessage: false });

  const entry: any = stateMod.state.currentToolBlocks["c2"];
  assert.ok(entry, "tool-start promoted the existing bash block instead of making a duplicate");
  assert.equal("tagName" in entry, false, "promoted as a pair, not as the bare element");
  assert.equal(entry.el, bashEl, "…wrapping the SAME element (no duplicate DOM node)");
  assert.equal(typeof entry.renderer.finalize, "function");
});

test("tool-update and tool-end route through entry.el, and tool-end clears the entry", () => {
  reset();
  toolsMod.handleToolStart({ toolCallId: "c3", toolName: "write", args: { path: "b.ts", content: "y" }, fromMessage: false });
  const el = stateMod.state.currentToolBlocks["c3"].el;

  toolsMod.handleToolUpdate({ toolCallId: "c3", partialResult: { content: [{ type: "text", text: '{"content":"yy"}' }] } });
  assert.ok(stateMod.state.currentToolBlocks["c3"], "update does not consume the entry");

  toolsMod.handleToolEnd({ toolCallId: "c3", toolName: "write", result: { content: [{ type: "text", text: "ok" }] }, isError: false, entryId: "e3" });
  assert.equal(stateMod.state.currentToolBlocks["c3"], undefined, "tool-end deletes the entry");
  assert.equal(el.getAttribute("data-status"), "done", "…after finalizing the card it pointed at");
});

test("tool-end marks the card errored when isError is set", () => {
  reset();
  toolsMod.handleToolStart({ toolCallId: "c4", toolName: "write", args: { path: "c.ts", content: "z" }, fromMessage: false });
  const el = stateMod.state.currentToolBlocks["c4"].el;
  toolsMod.handleToolEnd({ toolCallId: "c4", toolName: "write", result: { content: [{ type: "text", text: "boom" }] }, isError: true });
  assert.equal(el.getAttribute("data-status"), "error");
});

test("handleBashOutput falls back to currentToolBlocks when bashBlocks has no entry", () => {
  reset();
  // A tool-start-created bash card with NO bashBlocks entry — this is the path that read
  // `entry ? (entry as any).el || entry : null` and now reads `entry.el`.
  toolsMod.handleToolStart({ toolCallId: "c5", toolName: "bash", args: { command: "echo hi" }, fromMessage: false });
  delete stateMod.state.bashBlocks["c5"];
  assert.ok(stateMod.state.currentToolBlocks["c5"], "the entry is the only route to the card");

  assert.doesNotThrow(() => handlers.handleBashOutput({ toolCallId: "c5", output: "hi\n" }));
  assert.equal(stateMod.state.bashOutputs["c5"], "hi\n", "output was accumulated against the entry's card");
});

test("__piDebug.toolBlocks() reports the pair without a shape discriminant", () => {
  reset();
  toolsMod.handleToolStart({ toolCallId: "c6", toolName: "write", args: { path: "d.ts", content: "q" }, fromMessage: false });
  const rows = debugMod.piDebug
    ? debugMod.piDebug.toolBlocks()
    : (globalThis as any).window.__piDebug.toolBlocks();
  const row = rows.find((r: any) => r.id === "c6");
  assert.ok(row, "the live card is reported");
  assert.equal(row.hasRenderer, true, "…with its renderer, which the old `!(\"tagName\" in e)` test also had to prove");
  assert.equal(row.tag, "DIV");
});

// ── static guard ────────────────────────────────────────────
test("every writer into currentToolBlocks stores the {el, renderer} object form", () => {
  const here = dirname(fileURLToPath(import.meta.url));
  const repo = join(here, "..", "..", ".."); // out/test/unit → repo root
  const files = ["src/webview/tools/index.ts", "src/webview/handlers/index.ts", "src/webview/debug.ts", "src/webview/render/engine.ts"];

  let indexed = 0;
  let objectForm = 0;
  for (const f of files) {
    // Strip comments — prose describing the OLD shape would otherwise be counted as code.
    const code = readFileSync(join(repo, f), "utf-8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const m of code.matchAll(/currentToolBlocks\[[^\]]*\]\s*=\s*(.)/g)) {
      indexed++;
      if (m[1] === "{") { objectForm++; }
    }
  }

  assert.ok(indexed > 0, "sanity: found the writers");
  assert.equal(
    objectForm,
    indexed,
    "a writer stored something other than the { el, renderer } pair — the read sites no longer " +
    "carry an `|| entry` fallback for a bare element, so that would hand an object to code " +
    "that calls .getAttribute() on it",
  );
});

// ── numeric-string and non-string tool args (zero-any commit 2) ──────────────
//
// Tool args arrive as `Record<string, unknown>` on the wire — model-emitted JSON. Two places
// consumed them as if they were already the right primitive, which the `data: any` on the
// handlers hid. Both are pinned here because both are behaviour changes, not typing.

test("read: a numeric-STRING offset adds instead of concatenating (range label)", () => {
  reset();
  toolsMod.handleToolStart({
    toolCallId: "n1", toolName: "read",
    args: { path: "big.ts", offset: "10", limit: "5" }, // strings, as a model may emit them
    fromMessage: false,
  });
  const el = stateMod.state.currentToolBlocks["n1"].el;
  const pathText = el.textContent || "";
  // Before: ":" + "10" then "10" + "5" - 1 === "105" - 1 === 104  →  ":10-104"
  assert.ok(pathText.includes(":10-14"), `range label should be :10-14, got: ${pathText.slice(0, 120)}`);
  assert.ok(!pathText.includes(":10-104"), "the string-concatenation result must not come back");
});

test("read: continue-reading offset is numeric when the stored offset is a string", () => {
  reset();
  toolsMod.handleToolStart({
    toolCallId: "n2", toolName: "read",
    args: { path: "big.ts", offset: "100" },
    fromMessage: false,
  });
  toolsMod.handleToolEnd({
    toolCallId: "n2", toolName: "read", isError: false,
    result: {
      content: [{ type: "text", text: "line\n" }],
      // truncated: offset(100) + outputLines(50) = 150, of 400 total → 250 remaining
      details: { truncation: { truncated: true, totalLines: 400, outputLines: 50, outputBytes: 1 } },
    },
  });
  const el = (globalThis as any).document.getElementById("chat-container").textContent || "";
  // Before: ("100" || 0) + 50 === "10050", remaining 400 - 10050 → negative → link suppressed.
  assert.ok(el.includes("250 lines remaining"), `expected 250 remaining, got: ${el.slice(-200)}`);
});

test("tool-start dedup ignores a non-string path instead of rendering [object Object]", () => {
  reset();
  toolsMod.handleToolStart({ toolCallId: "n3", toolName: "read", args: { path: "real.ts" }, fromMessage: true });
  const el = stateMod.state.currentToolBlocks["n3"].el;

  // Second tool-start for the same call, carrying a malformed path.
  toolsMod.handleToolStart({ toolCallId: "n3", toolName: "read", args: { path: { nested: "oops" } }, fromMessage: false });

  const pathEl = el.querySelector(".tool-path");
  assert.ok(pathEl, "the card has a path element");
  assert.ok(!(pathEl.textContent || "").includes("[object Object]"), "a non-string path must not be stringified into the DOM");
});

test("tool-end with NO result finalizes the card instead of throwing", () => {
  reset();
  toolsMod.handleToolStart({ toolCallId: "n4", toolName: "write", args: { path: "x.ts", content: "c" }, fromMessage: false });
  const el = stateMod.state.currentToolBlocks["n4"].el;
  // protocol.ts marks tool-end.data.result optional; every finalize already guards `result &&`,
  // which is why the signature — not the callers — was what needed to change.
  assert.doesNotThrow(() => toolsMod.handleToolEnd({ toolCallId: "n4", toolName: "write", isError: false }));
  assert.equal(el.getAttribute("data-status"), "done");
});
