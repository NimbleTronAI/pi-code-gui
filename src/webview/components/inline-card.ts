// ── InlineCard component ──────────────────────────────────────
//
// Custom message cards rendered inline in the conversation stream.
// Owns action button delegation via data-command attributes.
//
// Replaces renderInlineCustomMessage in handlers/index.ts.
//
// Props:
//   customType — identifying string (e.g. "nimble-observe")
//   content    — trusted HTML (output of renderMarkdown)
//   renderer   — optional custom renderer function

import type { Component } from "./types.js";
import { html } from "../render/html.js";

export interface InlineCardProps {
  customType: string;
  content: string; // trusted HTML
  renderer?: (data: any, container: HTMLElement, escapeHtml: (s: string) => string) => void;
  rawData?: any; // passed to renderer
  escapeHtmlFn?: (s: string) => string;
}

export class InlineCard implements Component<InlineCardProps> {
  readonly el: HTMLElement;

  private bodyEl: HTMLElement;

  constructor(props: InlineCardProps) {
    this.el = document.createElement("div");
    this.el.className = "custom-message-inline";
    this.el.setAttribute("data-custom-type", props.customType);

    this.el.innerHTML = html`
      <div class="custom-message-header">
        <span class="custom-message-label">${props.customType}</span>
      </div>
      <div class="custom-message-body"></div>`;

    this.bodyEl = this.el.querySelector(".custom-message-body")!;

    // Wire action buttons: data-command sends slash command
    this.el.addEventListener("click", (e): void => {
      const btn = (e.target as HTMLElement).closest("[data-command]");
      if (btn) {
        e.preventDefault();
        const cmd = btn.getAttribute("data-command");
        if (cmd && (window as any).__vscode) {
          (window as any).__vscode.postMessage({
            type: "slashCommand",
            command: cmd,
          });
        }
      }
    });

    // Render content
    if (props.renderer && props.rawData) {
      props.renderer(props.rawData, this.bodyEl, props.escapeHtmlFn || escapeHtmlPolyfill);
    } else {
      this.bodyEl.innerHTML = props.content;
    }
  }

  mount(container: HTMLElement): void {
    container.appendChild(this.el);
  }

  update(props: InlineCardProps): void {
    if (props.renderer && props.rawData) {
      this.bodyEl.innerHTML = "";
      props.renderer(props.rawData, this.bodyEl, props.escapeHtmlFn || escapeHtmlPolyfill);
    } else {
      this.bodyEl.innerHTML = props.content;
    }
  }

  destroy(): void {
    this.el.remove();
  }
}

import { escapeHtml as escapeHtmlPolyfill } from "../../shared/escape-html.js";
