// ── Remote custom TUI component ─────────────────────────────
//
// The extension host owns the component and sends rendered text frames. This
// Webview component displays those frames and forwards terminal-style input.

import { parseAnsi, type AnsiStyle } from "../render/ansi.js";

export interface CustomUiKeyEvent {
  key: string;
  ctrlKey: boolean;
  altKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  isComposing?: boolean;
}

const SPECIAL_KEYS: Record<string, string> = {
  ArrowUp: "\x1b[A",
  ArrowDown: "\x1b[B",
  ArrowRight: "\x1b[C",
  ArrowLeft: "\x1b[D",
  Home: "\x1b[H",
  End: "\x1b[F",
  PageUp: "\x1b[5~",
  PageDown: "\x1b[6~",
  Insert: "\x1b[2~",
  Delete: "\x1b[3~",
  Backspace: "\x7f",
  Enter: "\r",
  Escape: "\x1b",
  Tab: "\t",
};

/** Convert a browser key event into the input sequences understood by pi-tui. */
export function encodeCustomUiKey(event: CustomUiKeyEvent): string | null {
  if (event.isComposing || event.metaKey) { return null; }
  if (event.key === "Tab" && event.shiftKey) { return "\x1b[Z"; }

  const special = SPECIAL_KEYS[event.key];
  if (special) { return special; }

  if (event.ctrlKey && event.key.length === 1) {
    const upper = event.key.toUpperCase();
    const code = upper.charCodeAt(0);
    if (code >= 64 && code <= 95) {
      return String.fromCharCode(code - 64);
    }
  }

  if (event.key.length === 1 && !event.ctrlKey) {
    return event.altKey ? `\x1b${event.key}` : event.key;
  }
  return null;
}

/** Map vertical mouse-wheel movement to list navigation. */
export function encodeCustomUiWheel(deltaY: number): string | null {
  if (!Number.isFinite(deltaY) || deltaY === 0) { return null; }
  return deltaY > 0 ? SPECIAL_KEYS.ArrowDown : SPECIAL_KEYS.ArrowUp;
}

interface CustomUiHostWindow {
  __vscode: { postMessage(message: unknown): void };
}

function postHostMessage(message: unknown): void {
  (window as unknown as CustomUiHostWindow).__vscode.postMessage(message);
}

export interface CustomUiFrame {
  id: string;
  lines: string[];
  columns: number;
  overlay?: boolean;
  anchor?:
    | "center" | "top-left" | "top-right" | "bottom-left" | "bottom-right"
    | "top-center" | "bottom-center" | "left-center" | "right-center";
  maxHeight?: number | string;
}

const CUSTOM_UI_HORIZONTAL_CHROME_PX = 68;

/** Fit a preferred terminal width to the Webview viewport without self-measurement. */
export function fitCustomUiColumns(
  preferredColumns: number,
  viewportWidth: number,
  characterWidth: number,
): number {
  const preferred = Math.max(20, Math.min(240, Math.round(preferredColumns)));
  if (!Number.isFinite(viewportWidth) || !Number.isFinite(characterWidth) || characterWidth <= 0) {
    return preferred;
  }
  const available = Math.floor((viewportWidth - CUSTOM_UI_HORIZONTAL_CHROME_PX) / characterWidth);
  return Math.max(20, Math.min(preferred, available));
}

export class CustomUi {
  readonly el: HTMLElement;

  private readonly panelEl: HTMLElement;
  private readonly contentEl: HTMLElement;
  private readonly closeButton: HTMLButtonElement;
  private readonly preferredColumns: number;
  private readonly onViewportResize = () => this.reportViewportWidth();
  private columns: number;
  private closeRequested = false;

  constructor(private frame: CustomUiFrame) {
    this.preferredColumns = frame.columns;
    this.columns = frame.columns;
    this.el = document.createElement("div");
    this.el.className = `pi-custom-ui-backdrop${frame.overlay ? " overlay" : ""}`;
    this.el.dataset.customUiId = frame.id;

    this.panelEl = document.createElement("section");
    this.panelEl.className = "pi-custom-ui-panel";
    this.panelEl.setAttribute("role", "dialog");
    this.panelEl.setAttribute("aria-modal", "true");
    this.panelEl.setAttribute("aria-label", "Extension interface");
    this.panelEl.tabIndex = 0;
    this.setColumns(frame.columns);
    this.el.appendChild(this.panelEl);

    this.closeButton = document.createElement("button");
    this.closeButton.type = "button";
    this.closeButton.className = "pi-custom-ui-close";
    this.closeButton.title = "Close (Escape)";
    this.closeButton.setAttribute("aria-label", "Close extension interface");
    this.closeButton.textContent = "×";
    this.closeButton.addEventListener("click", () => this.requestClose());
    this.panelEl.appendChild(this.closeButton);

    this.contentEl = document.createElement("pre");
    this.contentEl.className = "pi-custom-ui-content";
    this.contentEl.setAttribute("aria-live", "polite");
    this.panelEl.appendChild(this.contentEl);
    this.renderLines(frame.lines);

    this.panelEl.addEventListener("keydown", (event) => this.handleKey(event));
    this.panelEl.addEventListener("pointerdown", () => this.panelEl.focus());
    this.panelEl.addEventListener("wheel", (event) => this.handleWheel(event), { passive: false });
    this.applyLayout(frame);
  }

  mount(): void {
    document.body.appendChild(this.el);
    window.addEventListener("resize", this.onViewportResize);
    requestAnimationFrame(() => {
      this.panelEl.focus();
      this.reportViewportWidth();
    });
  }

  update(frame: CustomUiFrame): void {
    if (frame.id !== this.frame.id) { return; }
    this.frame = frame;
    this.closeRequested = false;
    this.closeButton.disabled = false;
    this.setColumns(frame.columns);
    this.applyLayout(frame);
    this.renderLines(frame.lines);
  }

  destroy(): void {
    window.removeEventListener("resize", this.onViewportResize);
    this.el.remove();
  }

  private renderLines(lines: string[]): void {
    this.contentEl.replaceChildren();
    for (const segment of parseAnsi(lines.join("\n"))) {
      const span = document.createElement("span");
      span.textContent = segment.text;
      this.applyAnsiStyle(span, segment.style);
      this.contentEl.appendChild(span);
    }
  }

  private applyAnsiStyle(element: HTMLElement, style: AnsiStyle): void {
    let foreground = style.foreground;
    let background = style.background;
    if (style.inverse) {
      const previousForeground = foreground;
      foreground = background ?? "var(--vscode-editor-background)";
      background = previousForeground ?? "var(--vscode-editor-foreground)";
    }
    if (foreground) { element.style.color = foreground; }
    if (background) { element.style.backgroundColor = background; }
    if (style.bold) { element.style.fontWeight = "700"; }
    if (style.dim) { element.style.opacity = "0.7"; }
    if (style.italic) { element.style.fontStyle = "italic"; }
    const decorations = [
      style.underline ? "underline" : "",
      style.strikethrough ? "line-through" : "",
    ].filter(Boolean);
    if (decorations.length > 0) { element.style.textDecorationLine = decorations.join(" "); }
  }

  private applyLayout(frame: CustomUiFrame): void {
    this.el.dataset.anchor = frame.anchor ?? "center";
    if (typeof frame.maxHeight === "number") {
      const contentHeight = `${frame.maxHeight * 1.35}em`;
      this.panelEl.style.setProperty(
        "--pi-custom-ui-max-height",
        `min(calc(${contentHeight} + 34px), calc(100vh - 32px))`,
      );
      this.panelEl.style.setProperty(
        "--pi-custom-ui-content-max-height",
        `min(${contentHeight}, calc(100vh - 64px))`,
      );
    } else if (typeof frame.maxHeight === "string" && /^\d+(?:\.\d+)?%$/.test(frame.maxHeight)) {
      this.panelEl.style.setProperty(
        "--pi-custom-ui-max-height",
        `min(${frame.maxHeight}, calc(100vh - 32px))`,
      );
      this.panelEl.style.setProperty(
        "--pi-custom-ui-content-max-height",
        `min(calc(${frame.maxHeight} - 34px), calc(100vh - 64px))`,
      );
    } else {
      this.panelEl.style.removeProperty("--pi-custom-ui-max-height");
      this.panelEl.style.removeProperty("--pi-custom-ui-content-max-height");
    }
  }

  private setColumns(columns: number): void {
    this.columns = Math.max(20, Math.min(240, Math.round(columns)));
    this.panelEl.style.setProperty("--pi-custom-ui-width", `${this.columns}ch`);
  }

  private handleKey(event: KeyboardEvent): void {
    const input = encodeCustomUiKey(event);
    if (!input) { return; }
    event.preventDefault();
    event.stopPropagation();
    this.postInput(input);
  }

  private handleWheel(event: WheelEvent): void {
    if (event.ctrlKey || event.shiftKey) { return; }
    const input = encodeCustomUiWheel(event.deltaY);
    if (!input) { return; }
    event.preventDefault();
    this.postInput(input);
  }

  private requestClose(): void {
    if (this.closeRequested) { return; }
    this.closeRequested = true;
    this.closeButton.disabled = true;
    this.postInput("\x1b");
    this.panelEl.focus();
  }

  private postInput(input: string): void {
    postHostMessage({
      type: "custom_ui_input",
      id: this.frame.id,
      input,
      columns: this.columns,
    });
  }

  private reportViewportWidth(): void {
    const style = getComputedStyle(this.contentEl);
    const probe = document.createElement("span");
    probe.style.position = "absolute";
    probe.style.visibility = "hidden";
    probe.style.whiteSpace = "pre";
    probe.style.fontFamily = style.fontFamily;
    probe.style.fontSize = style.fontSize;
    probe.style.fontWeight = style.fontWeight;
    probe.style.fontStyle = style.fontStyle;
    probe.textContent = "0000000000";
    document.body.appendChild(probe);
    const characterWidth = probe.getBoundingClientRect().width / 10;
    probe.remove();

    const columns = fitCustomUiColumns(this.preferredColumns, window.innerWidth, characterWidth);
    if (columns === this.columns) { return; }
    this.columns = columns;
    postHostMessage({
      type: "custom_ui_resize",
      id: this.frame.id,
      columns,
    });
  }
}
