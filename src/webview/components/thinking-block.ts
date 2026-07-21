// ── ThinkingBlock component ────────────────────────────────────
//
// Collapsible thinking content block.  Owns the collapse/expand
// toggle state, fixing the "expanded content, collapsed arrow" bug.
//
// Used in assistant message stream to show model thinking.
//
// Props:
//   content  — the current thinking text (empty = initial state)
//   done     — true when thinking has completed (hides spinner)

import type { Component } from "./types.js";
import { html } from "../render/html.js";

export interface ThinkingBlockProps {
  content: string;
  done?: boolean;
}

export class ThinkingBlock implements Component<ThinkingBlockProps> {
  readonly el: HTMLElement;

  private contentEl: HTMLElement;
  private expandBtn: HTMLElement;
  private spinnerEl: HTMLElement;
  private lineCountEl: HTMLElement;

  private _collapsed = true;

  constructor(props: ThinkingBlockProps) {
    this.el = document.createElement("div");
    this.el.className = "thinking-block thinking-collapsed";
    this.el.innerHTML = html`
      <div class="thinking-header">
        <span class="thinking-label">Thinking</span>
        <span class="thinking-spinner"></span>
        <span class="thinking-line-count"></span>
      </div>
      <div class="thinking-content"></div>
      <button class="thinking-expand-btn">Show more</button>`;

    this.contentEl = this.el.querySelector(".thinking-content")!;
    this.expandBtn = this.el.querySelector(".thinking-expand-btn")!;
    this.spinnerEl = this.el.querySelector(".thinking-spinner")!;
    this.lineCountEl = this.el.querySelector(".thinking-line-count")!;

    // Wire toggle
    this.expandBtn.addEventListener("click", (): void => this.toggle());

    // Set initial content via textContent (safe, no HTML parse)
    this.setContent(props.content);
    this.updateDisplay(props.done);
  }

  mount(container: HTMLElement): void {
    container.appendChild(this.el);
  }

  update(props: ThinkingBlockProps): void {
    this.setContent(props.content);
    this.updateDisplay(props.done);
  }

  destroy(): void {
    this.el.remove();
  }

  // ── internal ──────────────────────────────────────────

  private setContent(content: string): void {
    this.contentEl.textContent = content;
    const lines = content ? content.split("\n").length : 0;
    this.lineCountEl.textContent = lines > 0 ? `(${lines} lines)` : "";
  }

  private updateDisplay(done?: boolean): void {
    if (done) {
      this.spinnerEl.remove();
      // Update expand button visibility based on overflow
      const overflowing =
        this.contentEl.scrollHeight > this.contentEl.clientHeight + 2;
      if (this._collapsed) {
        this.expandBtn.style.display = overflowing ? "" : "none";
        this.expandBtn.textContent = "Show more";
      } else {
        this.expandBtn.style.display = "";
        this.expandBtn.textContent = "Show less";
      }
    }
  }

  private toggle(): void {
    this._collapsed = !this._collapsed;
    if (this._collapsed) {
      this.el.classList.add("thinking-collapsed");
      this.expandBtn.textContent = "Show more";
      this.contentEl.scrollTop = 0;
      this.el.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      this.el.classList.remove("thinking-collapsed");
      this.expandBtn.textContent = "Show less";
    }
  }

  /** Auto-scroll the content area to the bottom (for streaming). */
  scrollToBottom(): void {
    this.contentEl.scrollTop = this.contentEl.scrollHeight;
  }

  /** Whether the thinking block is currently collapsed. */
  get collapsed(): boolean {
    return this._collapsed;
  }
}
