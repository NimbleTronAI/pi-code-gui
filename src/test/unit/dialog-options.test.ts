// The select dialog renders its options as real, clickable elements — not as literal markup.
//
// The option labels go through an inner html`` (which escapes them), and the resulting string
// was then interpolated into the OUTER html``, which escaped it again. Users saw the raw
// `<div class="pi-dialog-option" data-index="0"> Option A </div>` as the dialog body with no
// way to choose. Latent since the 0.1.3 XSS hardening and only surfaced when rust-pi's `ask`
// tool became the first thing to routinely open a select dialog.

import { test, before } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";

let DialogMod: any;

before(async () => {
  const dom = new JSDOM(`<!DOCTYPE html><html><body><div id="host"></div></body></html>`);
  const g = globalThis as any;
  g.window = dom.window;
  g.document = dom.window.document;
  const spec = "../../webview/components/dialog.js";
  DialogMod = await import(spec);
});

function openSelect(options: string[], prompt = "Which option?") {
  const host = document.getElementById("host")!;
  host.innerHTML = "";
  const Ctor = DialogMod.Dialog ?? DialogMod.default;
  const d = new Ctor({ dialogType: "select", id: "d1", prompt, options, defaultValue: "" });
  const el = d.mount ? d.mount(host) : d.el;
  if (el && !host.contains(el)) { host.appendChild(el); }
  return host;
}

/** Capture what the dialog posts back, the way the webview's vscode bridge would. */
function openSelectCapturing(options: string[]) {
  const sent: any[] = [];
  (globalThis as any).window.__vscode = { postMessage: (m: any) => sent.push(m) };
  const host = openSelect(options);
  return { host, sent };
}

function click(el: Element, type = "click") {
  el.dispatchEvent(new (globalThis as any).window.MouseEvent(type, { bubbles: true }));
}

test("select dialog renders one clickable element per option", () => {
  const host = openSelect(["Option A", "Option B"]);
  const rendered = host.querySelectorAll(".pi-dialog-option");
  assert.equal(rendered.length, 2, "two real option elements, not escaped text");
  assert.equal(rendered[0].textContent?.trim(), "Option A");
  assert.equal(rendered[1].textContent?.trim(), "Option B");
  assert.equal(rendered[0].getAttribute("data-index"), "0");
});

test("select dialog shows no raw markup as text", () => {
  const host = openSelect(["Option A", "Option B"]);
  assert.ok(!(host.textContent || "").includes("pi-dialog-option"),
    "the class name must never appear as visible text");
  assert.ok(!(host.textContent || "").includes("<div"),
    "no literal tags in the dialog body");
});

test("an option label containing HTML is still escaped, not executed", () => {
  // The double-escape was the bug; escaping ONCE is the point of the template.
  const host = openSelect(["<img src=x onerror=alert(1)>", "safe"]);
  assert.equal(host.querySelectorAll(".pi-dialog-option").length, 2);
  assert.equal(host.querySelectorAll("img").length, 0, "no element created from the label");
  assert.ok((host.textContent || "").includes("<img src=x onerror=alert(1)>"),
    "the label is shown literally, as escaped text");
});

// ── answering the dialog ────────────────────────────────────────────
// Options highlighted on hover (pure CSS) but had NO click handler, and the keydown listener
// sat on an element that could never take focus. So a select dialog was unanswerable except by
// pressing OK, which committed whatever index it started on.

test("clicking an option selects it, and OK submits that choice", () => {
  const { host, sent } = openSelectCapturing(["Option A", "Option B"]);
  const opts = host.querySelectorAll(".pi-dialog-option");
  click(opts[1]);
  assert.ok(opts[1].classList.contains("selected"), "clicked option is marked selected");
  assert.ok(!opts[0].classList.contains("selected"), "the default is deselected");
  click(host.querySelector(".pi-dialog-confirm")!);
  assert.equal(sent.length, 1);
  assert.equal(sent[0].value, "Option B", "submits what was clicked, not the default");
});

test("clicking an option does not cancel the dialog through the overlay handler", () => {
  // The overlay treats stray clicks as cancel; without stopPropagation a click on an option
  // would select and immediately cancel.
  const { host, sent } = openSelectCapturing(["Option A", "Option B"]);
  click(host.querySelectorAll(".pi-dialog-option")[1]);
  assert.equal(sent.length, 0, "no response posted merely by choosing");
});

test("double-clicking an option commits it", () => {
  const { host, sent } = openSelectCapturing(["Option A", "Option B"]);
  const opt = host.querySelectorAll(".pi-dialog-option")[1];
  click(opt);
  click(opt, "dblclick");
  assert.equal(sent.length, 1);
  assert.equal(sent[0].value, "Option B");
});

test("the dialog is focusable, so its key handler can actually run", () => {
  const host = openSelect(["Option A", "Option B"]);
  const overlay = host.querySelector(".pi-dialog-overlay")!;
  assert.equal(overlay.getAttribute("tabindex"), "-1",
    "a plain div cannot take keyboard focus — without this, arrows/Enter/Escape never arrive");
});

// ── the dialog must leave nothing behind ────────────────────────────
// Answering a dialog used to leave an empty full-screen fixed layer (#dialog-overlay, inset 0,
// z-index 1000) on top of the UI: Dialog.destroy() removed only its own element, never the
// wrapper the handler created. The chat then looked normal but ate every click and scroll for
// the rest of the session.

test("answering removes the dialog's own overlay from the DOM", () => {
  const { host, sent } = openSelectCapturing(["Option A", "Option B"]);
  assert.equal(host.querySelectorAll(".pi-dialog-overlay").length, 1);
  click(host.querySelector(".pi-dialog-confirm")!);
  assert.equal(sent.length, 1);
  assert.equal(host.querySelectorAll(".pi-dialog-overlay").length, 0,
    "nothing is left covering the UI");
});

test("cancelling removes it too", () => {
  const { host, sent } = openSelectCapturing(["Option A", "Option B"]);
  click(host.querySelector(".pi-dialog-cancel")!);
  assert.equal(sent[0].value, null, "cancel reports no answer");
  assert.equal(host.querySelectorAll(".pi-dialog-overlay").length, 0);
});

test("no full-screen layer survives a dialog cycle", () => {
  // Guards the specific regression: ANY leftover fixed, inset-0 element blocks the whole webview.
  const { host } = openSelectCapturing(["Option A", "Option B"]);
  click(host.querySelector(".pi-dialog-confirm")!);
  assert.equal(document.getElementById("dialog-overlay"), null,
    "the wrapper container must not outlive the dialog");
});
