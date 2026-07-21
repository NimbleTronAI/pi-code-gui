// ── LiveCard component ────────────────────────────────────────
//
// Collapsible notification card rendered above the prompt input.
// Owns the collapse/expand toggle state, fixing the
// "expanded content, collapsed arrow" out-of-sync bug.
//
// Props:
//   cardType   — identifier for the card (e.g. "extension-notify")
//   label      — short label shown in the collapsed header
//   content    — full content (markdown HTML), rendered expanded
//   onDismiss  — callback when the close button is clicked

import type { Component } from "./types.js";
import { html, safe } from "../render/html.js";

export interface LiveCardProps {
  cardType: string;
  label: string;
  content: string; // trusted HTML (output of renderMarkdown)
  onDismiss?: () => void;
}

export class LiveCard implements Component<LiveCardProps> {
  readonly el: HTMLElement;

  private expandoEl: HTMLElement;
  private contentEl: HTMLElement;
  private closeBtn: HTMLElement;

  private _collapsed = true;

  constructor(props: LiveCardProps) {
    this.el = document.createElement("div");
    this.el.className = "live-card live-card-collapsed";
    this.el.setAttribute("data-type", props.cardType);
    this.el.innerHTML = html`
      <div class="live-card-label">
        <span class="live-card-expando">\u25B8</span> ${props.label}
      </div>
      <button class="live-card-close" title="Dismiss">&times;</button>
      <div class="live-card-content" style="display:none">${safe(props.content)}</div>`;

    this.expandoEl = this.el.querySelector(".live-card-expando")!;
    this.contentEl = this.el.querySelector(".live-card-content")!;
    this.closeBtn = this.el.querySelector(".live-card-close")!;

    // Wire events
    this.el.querySelector(".live-card-label")!.addEventListener(
      "click",
      (): void => this.toggle(),
    );
    this.closeBtn.addEventListener("click", (e): void => {
      e.stopPropagation();
      if (props.onDismiss) { props.onDismiss(); }
      this.destroy();
    });
  }

  mount(container: HTMLElement): void {
    container.appendChild(this.el);
  }

  update(props: LiveCardProps): void {
    // Update content
    this.contentEl.innerHTML = props.content;

    // Update label
    const labelEl = this.el.querySelector(".live-card-label");
    if (labelEl) {
      // Keep expando, update label text
      const expando = labelEl.querySelector(".live-card-expando");
      labelEl.textContent = "";
      if (expando) { labelEl.appendChild(expando); }
      labelEl.appendChild(document.createTextNode(" " + props.label));
    }

    // Collapse (re-collapse on update so user must re-expand)
    this._collapsed = true;
    this.el.classList.add("live-card-collapsed");
    this.expandoEl.textContent = "\u25B8";
    this.contentEl.style.display = "none";
  }

  destroy(): void {
    this.el.remove();
  }

  // ── internal ──────────────────────────────────────────

  private toggle(): void {
    this._collapsed = !this._collapsed;
    if (this._collapsed) {
      this.el.classList.add("live-card-collapsed");
      this.expandoEl.textContent = "\u25B8";
      this.contentEl.style.display = "none";
    } else {
      this.el.classList.remove("live-card-collapsed");
      this.expandoEl.textContent = "\u25BE";
      this.contentEl.style.display = "";
    }
  }

  /** Whether the card is currently collapsed. */
  get collapsed(): boolean {
    return this._collapsed;
  }
}
