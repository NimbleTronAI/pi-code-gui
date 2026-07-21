// ── CodeBlock component ───────────────────────────────────────
//
// Syntax-highlighted code display with line numbers, copy button,
// and a self-contained scroll container.  Replaces renderFileContent
// and renderCodeBlockHTML from engine.ts.
//
// Used by: write tool, read tool, edit tool, assistant messages.
//
// Props:
//   code      — source code to display
//   lang      — language for syntax highlighting (e.g. "typescript")
//   showHeader — show the header bar (lang label + copy button)
//   showCopy  — show the copy button

import type { Component } from "./types.js";
import { escapeHtml as sharedEscapeHtml } from "../../shared/escape-html.js";
import { highlightCode } from "../highlight.js";

export interface CodeBlockProps {
  code: string;
  lang?: string;
  showHeader?: boolean;
  showCopy?: boolean;
}

export class CodeBlock implements Component<CodeBlockProps> {
  readonly el: HTMLElement;

  private preEl: HTMLElement;
  private copyBtn: HTMLElement | null = null;
  private langLabel: HTMLElement | null = null;
  private _copyTimeout: ReturnType<typeof setTimeout> | null = null;

  constructor(props: CodeBlockProps) {
    this.el = document.createElement("div");
    this.el.className = "code-block-wrapper";
    this.preEl = document.createElement("pre");
    this.render(props);
  }

  mount(container: HTMLElement): void {
    container.appendChild(this.el);
  }

  update(props: CodeBlockProps): void {
    this.render(props);
  }

  destroy(): void {
    if (this._copyTimeout) {
      clearTimeout(this._copyTimeout);
      this._copyTimeout = null;
    }
    this.el.remove();
  }

  // ── internal ──────────────────────────────────────────

  private render(props: CodeBlockProps): void {
    const code = (props.code || "").replace(/\r\n?/g, "\n").replace(/\n+$/, "");
    const lang = props.lang || "";
    const showHeader = props.showHeader !== false;
    const showCopy = props.showCopy !== false;

    // Build content
    const inner = this.buildContent(code, lang, showHeader, showCopy);
    // Use morphdom if already in DOM, otherwise innerHTML
    if (this.el.parentElement) {
      window.morphdom(this.el, inner);
    } else {
      this.el.innerHTML = "";
      // Copy children from temp div
      while (inner.firstChild) {
        this.el.appendChild(inner.firstChild);
      }
      // Re-cache refs
      this.cacheRefs();
      this.wireCopyBtn();
    }
  }

  private buildContent(
    code: string,
    lang: string,
    showHeader: boolean,
    showCopy: boolean,
  ): HTMLElement {
    const wrapper = document.createElement("div");
    wrapper.className = "code-block-wrapper";

    if (showHeader) {
      const header = document.createElement("div");
      header.className = "code-block-header";
      if (lang) {
        const lbl = document.createElement("span");
        lbl.className = "code-lang-label";
        lbl.textContent = lang;
        header.appendChild(lbl);
      }
      if (showCopy) {
        const btn = document.createElement("button");
        btn.className = "code-copy-btn";
        btn.type = "button";
        btn.textContent = "Copy";
        header.appendChild(btn);
      }
      wrapper.appendChild(header);
    }

    const pre = document.createElement("pre");
    pre.className = "code-block";
    pre.setAttribute("data-lang", lang);

    const codeEl = document.createElement("code");
    codeEl.innerHTML = this.buildNumberedLines(code, lang);
    pre.appendChild(codeEl);
    wrapper.appendChild(pre);

    return wrapper;
  }

  private buildNumberedLines(code: string, lang: string): string {
    // Skip highlighting when lang is empty/unknown — just escape
    if (!lang) { return this.escapeHtml(code); }
    const highlighted = highlightCode(code, lang);
    const lines = highlighted.split("\n");
    return lines
      .map((line) => `<span class="code-ln"></span>${line}`)
      .join("\n");
  }

  private escapeHtml(text: string): string { return sharedEscapeHtml(text); }

  private cacheRefs(): void {
    this.preEl = this.el.querySelector(".code-block") || this.preEl;
    this.copyBtn = this.el.querySelector(".code-copy-btn");
    this.langLabel = this.el.querySelector(".code-lang-label");
  }

  private wireCopyBtn(): void {
    if (!this.copyBtn) { return; }
    this.copyBtn.addEventListener("click", () => {
      const text = this.preEl?.textContent || "";
      navigator.clipboard.writeText(text).then(
        () => {
          if (this.copyBtn) { this.copyBtn.textContent = "Copied!"; }
          this._copyTimeout = setTimeout(() => {
            if (this.copyBtn) { this.copyBtn.textContent = "Copy"; }
          }, 2000);
        },
        () => {
          if (this.copyBtn) { this.copyBtn.textContent = "Failed"; }
          this._copyTimeout = setTimeout(() => {
            if (this.copyBtn) { this.copyBtn.textContent = "Copy"; }
          }, 2000);
        },
      );
    });
  }
}
