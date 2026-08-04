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

// ── error-card classification ────────────────────────────────────────
// An expired OAuth token must not be filed as "API key required". The backend's own advice text
// offers an API key as an ALTERNATIVE ("Or set API key directly via environment variable"), so a
// naive /api.?key/ test matches it and sends a user whose subscription simply expired off to
// configure a key they do not need. The actual fix is to log in again.
test("an expired-OAuth failure is reported as a sign-in problem, not a missing API key", () => {
  const doc = (globalThis as any).document;
  doc.getElementById("chat-container").innerHTML = "";
  handlers.addErrorMessage(
    "Pi init failed: Failed to start Rust Pi: Rust process exited immediately (code 1) — last stderr: " +
    "Error: Authentication error: OAuth token refresh failed for: anthropic " +
    '(Anthropic token refresh failed: {"error":"invalid_grant"})\n' +
    "OAuth token expired or invalid\nSuggestions:\n  • Run 'pi login <provider>' to re-authenticate\n" +
    "  • Or set API key directly via environment variable",
  );
  const card = doc.querySelector(".message-content.error");
  const text = card.textContent;
  assert.match(text, /Sign-in expired/, "must name the real problem");
  assert.doesNotMatch(text, /API key required/, "must not send them to configure an API key");
  assert.match(text, /\/login/, "must give the actionable fix");
});

test("a genuine missing-API-key error still classifies as one", () => {
  const doc = (globalThis as any).document;
  doc.getElementById("chat-container").innerHTML = "";
  handlers.addErrorMessage("No API key found for provider anthropic.");
  assert.match(doc.querySelector(".message-content.error").textContent, /API key required/);
});

// ── the failed-session catch-22 ──────────────────────────────────────
// A failed init disabled the prompt box outright. The failure message tells the user to run
// /login — and the only place to type it was the box we had just disabled, so a session that
// failed to authenticate could not be recovered from inside its own tab.
test("a failed init leaves the input USABLE, not disabled", () => {
  handlers.handleStatus({ runtime: "rust", ready: false, model: "init failed" });
  const st = stateMod.state;
  assert.equal(st.promptInput.disabled, false, "disabling this is what trapped the user");
  assert.equal(st.sendButton.disabled, false);
  assert.equal(st.sessionUnavailable, true);
  assert.match(st.promptInput.placeholder, /\/login/, "the placeholder must name a way out");
});

test("with no backend, a local slash command is still dispatched", () => {
  const doc = (globalThis as any).document;
  handlers.handleStatus({ runtime: "rust", ready: false, model: "init failed" });
  const st = stateMod.state;
  const sent: any[] = [];
  (globalThis as any).window.__vscode.postMessage = (m: any) => sent.push(m);
  st.promptInput.value = "/login";
  handlers.sendPrompt();
  assert.deepEqual(sent, [{ type: "slashCommand", command: "login" }],
    "/login must reach the extension even with a dead backend");
  doc.getElementById("chat-container").innerHTML = "";
});

test("with no backend, a free-form prompt is refused with a way forward — not swallowed", () => {
  const doc = (globalThis as any).document;
  handlers.handleStatus({ runtime: "rust", ready: false, model: "init failed" });
  const st = stateMod.state;
  const sent: any[] = [];
  (globalThis as any).window.__vscode.postMessage = (m: any) => sent.push(m);
  st.promptInput.value = "please refactor this file";
  handlers.sendPrompt();
  assert.deepEqual(sent, [], "a prompt with no backend must not be sent into the void");
  assert.match(doc.querySelector(".message-content.error").textContent, /\/login/);
  doc.getElementById("chat-container").innerHTML = "";
});

test("a ready session clears the limited mode", () => {
  handlers.handleStatus({ runtime: "rust", ready: true, model: { provider: "anthropic", id: "x" } });
  assert.equal(stateMod.state.sessionUnavailable, false);
  assert.equal(stateMod.state.promptInput.disabled, false);
});
