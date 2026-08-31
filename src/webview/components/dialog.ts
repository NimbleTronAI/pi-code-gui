// ── Dialog component ──────────────────────────────────────────
//
// Overlays the prompt area for interactive extension UI methods:
// select(), confirm(), input().  Captures keyboard input and
// posts the result back to the extension host.
//
// Keyboard shortcuts:
//   Enter — confirm selection / submit input
//   Esc   — cancel
//   Up/Down — navigate select options

import type { Component } from "./types.js";
import { html, safe } from "../render/html.js";

export type DialogType = "select" | "confirm" | "input";

export interface DialogProps {
  dialogType: DialogType;
  id: string;
  prompt: string;
  options?: string[];
  defaultValue?: string;
}

export class Dialog implements Component<DialogProps> {
  readonly el: HTMLElement;

  private promptEl: HTMLElement;
  private inputEl: HTMLInputElement | null = null;
  private optionsEl: HTMLElement | null = null;
  private confirmBtn: HTMLElement;
  private cancelBtn: HTMLElement;

  private _selectedIdx = 0;
  private _options: string[] = [];

  constructor(private props: DialogProps) {
    this.el = document.createElement("div");
    this.el.className = "pi-dialog-overlay";
    this.el.setAttribute("data-dialog-id", props.id);
    // Focusable, or the keydown listener below is dead code. A plain <div> cannot take keyboard
    // focus, and only the INPUT dialog ever focused anything — so on a select dialog the arrow
    // keys, Enter and Escape all went to whatever had focus before the dialog opened, and the
    // dialog could only be dismissed with the mouse.
    this.el.setAttribute("tabindex", "-1");

    this._options = props.options || [];

    if (props.dialogType === "input") {
      this.el.innerHTML = html`
        <div class="pi-dialog">
          <div class="pi-dialog-prompt">${props.prompt}</div>
          <input class="pi-dialog-input" type="text" value="${props.defaultValue || ""}" autofocus>
          <div class="pi-dialog-actions">
            <button class="pi-dialog-btn pi-dialog-cancel">Cancel</button>
            <button class="pi-dialog-btn pi-dialog-confirm">OK</button>
          </div>
        </div>`;
      this.inputEl = this.el.querySelector(".pi-dialog-input")!;
    } else {
      // Select or confirm.
      //
      // optionsHtml is ALREADY-ESCAPED markup: each option's label goes through the inner
      // html`` above, which escapes it. Interpolating it into the outer html`` plainly would
      // escape it a SECOND time, rendering the option <div>s as literal text — which is exactly
      // what the dialog did, showing users `<div class="pi-dialog-option" ...> Option A </div>`
      // as the body. safe() is the marker for exactly this: content that is already escaped.
      // The labels are still escaped once, so the XSS hardening this template exists for is
      // unaffected.
      var optionsHtml = "";
      for (var i = 0; i < this._options.length; i++) {
        optionsHtml += html`
          <div class="pi-dialog-option${i === 0 ? " selected" : ""}" data-index="${i}">
            ${this._options[i]}
          </div>`;
      }
      this.el.innerHTML = html`
        <div class="pi-dialog">
          <div class="pi-dialog-prompt">${props.prompt}</div>
          <div class="pi-dialog-options">${safe(optionsHtml)}</div>
          <div class="pi-dialog-actions">
            <button class="pi-dialog-btn pi-dialog-cancel">Cancel</button>
            <button class="pi-dialog-btn pi-dialog-confirm">OK</button>
          </div>
        </div>`;
      this.optionsEl = this.el.querySelector(".pi-dialog-options")!;
    }

    this.promptEl = this.el.querySelector(".pi-dialog-prompt")!;
    this.confirmBtn = this.el.querySelector(".pi-dialog-confirm")!;
    this.cancelBtn = this.el.querySelector(".pi-dialog-cancel")!;

    // Wire events
    this.confirmBtn.addEventListener("click", (): void => this.submit());
    this.cancelBtn.addEventListener("click", (): void => this.cancel());

    // Keyboard handling
    this.el.addEventListener("keydown", (e): void => this.handleKey(e));

    // Option clicks. There was NO handler here: options highlighted on hover (pure CSS) and
    // then did nothing, so a select dialog could not actually be answered with the mouse — the
    // choice was stuck on whatever _selectedIdx started at. Delegated from the container so it
    // survives any future re-render of the option list.
    if (this.optionsEl) {
      this.optionsEl.addEventListener("click", (e): void => {
        const target = e.target as HTMLElement | null;
        const option = target?.closest?.(".pi-dialog-option") as HTMLElement | null;
        if (!option) { return; }
        const idx = Number(option.getAttribute("data-index"));
        if (!Number.isInteger(idx) || idx < 0 || idx >= this._options.length) { return; }
        e.stopPropagation();   // the overlay's own click handler treats stray clicks as cancel
        this._selectedIdx = idx;
        this.highlightOption();
      });
      // Double-click commits, so a decisive user does not have to travel to the OK button.
      this.optionsEl.addEventListener("dblclick", (e): void => {
        const target = e.target as HTMLElement | null;
        if (!target?.closest?.(".pi-dialog-option")) { return; }
        e.stopPropagation();
        this.submit();
      });
    }

    // Close on overlay click (click outside dialog box)
    this.el.addEventListener("click", (e): void => {
      if (e.target === this.el) { this.cancel(); }
    });
  }

  mount(container: HTMLElement): void {
    container.appendChild(this.el);
    // Focus the input if present; otherwise focus the dialog itself so keys reach handleKey.
    if (this.inputEl) {
      setTimeout((): void => this.inputEl!.focus(), 50);
    } else {
      setTimeout((): void => this.el.focus(), 50);
    }
  }

  update(_props: DialogProps): void {
    // Dialog is one-shot — no updates needed
  }

  destroy(): void {
    this.el.remove();
  }

  // ── internal ──────────────────────────────────────────

  private handleKey(e: KeyboardEvent): void {
    switch (e.key) {
      case "Enter":
        e.preventDefault();
        this.submit();
        break;
      case "Escape":
        e.preventDefault();
        this.cancel();
        break;
      case "ArrowDown":
        if (this._options.length > 0) {
          e.preventDefault();
          this._selectedIdx = Math.min(this._selectedIdx + 1, this._options.length - 1);
          this.highlightOption();
        }
        break;
      case "ArrowUp":
        if (this._options.length > 0) {
          e.preventDefault();
          this._selectedIdx = Math.max(this._selectedIdx - 1, 0);
          this.highlightOption();
        }
        break;
    }
  }

  private highlightOption(): void {
    if (!this.optionsEl) { return; }
    var items = this.optionsEl.querySelectorAll(".pi-dialog-option");
    for (var i = 0; i < items.length; i++) {
      if (i === this._selectedIdx) {
        items[i].classList.add("selected");
      } else {
        items[i].classList.remove("selected");
      }
    }
  }

  private submit(): void {
    var value: unknown = null;
    if (this.props.dialogType === "input") {
      value = this.inputEl?.value || "";
    } else if (this.props.dialogType === "confirm") {
      value = true;
    } else {
      // select
      value = this._options[this._selectedIdx] || null;
    }
    this.postResponse(value);
  }

  private cancel(): void {
    this.postResponse(null); // null = cancelled
  }

  private postResponse(value: unknown): void {
    if (typeof window.__vscode !== "undefined") {
      window.__vscode.postMessage({
        type: "extension_ui_response",
        id: this.props.id,
        value: value,
      });
    }
    this.destroy();
  }
}
