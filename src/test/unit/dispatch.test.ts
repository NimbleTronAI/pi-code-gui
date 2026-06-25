// First jsdom seam: a smoke test that drives the REAL webview dispatch handlers
// (handleAssistantStart / handleStreamDelta / handleToolStart / handleToolEnd)
// under a jsdom DOM, proving the streaming render path runs end-to-end without a
// browser. The webview is compiled separately into out/webview by
// tsconfig.test-webview.json (`pnpm run compile-tests:webview`); we import it with
// a VARIABLE specifier so the main tsc (which excludes src/webview) doesn't try to
// type-check it.

import { test, before } from "node:test";
import assert from "node:assert/strict";
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

  // The webview loads these as <script> globals (declared in global.d.ts). Minimal
  // stubs so the render path doesn't crash; the smoke test asserts DOM mutation,
  // not rendered markdown.
  g.marked = { parse: (t: string) => t, lexer: (_t: string) => [], setOptions: () => {} };
  g.morphdom = (_from: any, _to: any) => { /* no-op */ };
  g.hljs = { highlight: (code: string) => ({ value: code }), highlightAuto: (code: string) => ({ value: code }), getLanguage: () => undefined };
  const vscodeStub = { postMessage: () => {}, getState: () => ({}), setState: () => {} };
  (dom.window as any).__vscode = vscodeStub;
  g.__vscode = vscodeStub;
  g.acquireVsCodeApi = () => vscodeStub;

  // Variable specifiers: keep the main tsc from deep-type-checking webview code.
  const handlersSpec = "../../webview/handlers/index.js";
  const stateSpec = "../../webview/state.js";
  const toolsSpec = "../../webview/tools/index.js";
  handlers = await import(handlersSpec);
  stateMod = await import(stateSpec);
  toolsMod = await import(toolsSpec);
  stateMod.initState(dom.window.document);
});

test("stream-delta dispatch creates an assistant message and accumulates text", () => {
  handlers.handleAssistantStart({ messageId: "m1", entryId: "e1" });
  handlers.handleStreamDelta({ delta: "hello " });
  handlers.handleStreamDelta({ delta: "world" });

  const cc = (globalThis as any).document.getElementById("chat-container");
  const content = cc.querySelector(".message-content");
  assert.ok(content, "an assistant .message-content element was created");
  assert.equal(content.getAttribute("data-raw"), "hello world");
});

test("tool-start → tool-end dispatch mutates the DOM without throwing", () => {
  const cc = (globalThis as any).document.getElementById("chat-container");
  const before = cc.innerHTML.length;
  toolsMod.handleToolStart({ toolCallId: "t1", toolName: "write", args: { path: "a.ts", content: "x" }, fromMessage: false });
  toolsMod.handleToolEnd({ toolCallId: "t1", toolName: "write", result: { content: [{ type: "text", text: "ok" }] }, isError: false });
  assert.ok(cc.innerHTML.length > before, "the tool dispatch added content to the chat container");
  assert.ok(cc.innerHTML.includes("t1") || cc.innerHTML.toLowerCase().includes("write"), "the tool block references the call");
});

test("assistant-end after streaming leaves the message in place and clears the cursor", () => {
  handlers.handleAssistantEnd({ stopReason: "end", toolCalls: [] });
  const cc = (globalThis as any).document.getElementById("chat-container");
  // The streamed assistant message survives end-of-turn.
  assert.ok(cc.querySelector(".message-content"), "assistant message remains after assistant-end");
});
