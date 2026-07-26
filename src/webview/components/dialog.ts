// ── Inline extension question component ──────────────────────
//
// Renders select(), confirm(), and input() requests as persistent cards in
// the conversation stream. The card remains after completion so the question
// and answer retain their place in the transcript.

import type { Component } from "./types.js";

export type DialogType = "select" | "confirm" | "input";

export interface DialogProps {
  dialogType: DialogType;
  id: string;
  prompt: string;
  options?: string[];
  /** Pi's input() second argument is a placeholder, not an initial value. */
  defaultValue?: string;
  /**
   * Combines an RPC fallback's `Type something.` select response and its
   * immediately following input request into one inline interaction.
   */
  onCustomSubmit?: (selection: string, answer: string) => void;
}

export interface DialogPromptParts {
  header?: string;
  question: string;
}

export interface DialogOptionParts {
  index?: string;
  label: string;
  description?: string;
}

/** Split the `[header] question` convention used by RPC questionnaires. */
export function parseDialogPrompt(prompt: string): DialogPromptParts {
  const match = prompt.match(/^\[([^\]\r\n]+)\]\s*([\s\S]*)$/);
  return match
    ? { header: match[1].trim(), question: match[2].trim() }
    : { question: prompt.trim() };
}

/** Split RPC option strings such as `1. Label — Description`. */
export function parseDialogOption(option: string): DialogOptionParts {
  const numbered = option.match(/^\s*(\d+)\.\s*([\s\S]*)$/);
  const index = numbered?.[1];
  const content = (numbered?.[2] ?? option).trim();
  const described = content.match(/^([\s\S]*?)\s+—\s+([\s\S]+)$/);
  return {
    index,
    label: (described?.[1] ?? content).trim(),
    description: described?.[2]?.trim() || undefined,
  };
}

const CUSTOM_OPTION_LABELS = new Set([
  "type something",
  "schreibe etwas",
  "escribe algo",
  "écrivez quelque chose",
  "digite algo",
  "escreva algo",
  "введите что-нибудь",
  "введіть щось",
  "输入内容",
]);

/** Recognize rpiv-ask-user-question's localized custom-answer sentinel. */
export function isCustomDialogOption(option: string): boolean {
  const label = parseDialogOption(option).label
    .toLocaleLowerCase()
    .replace(/[.!。！]+$/u, "")
    .trim();
  return CUSTOM_OPTION_LABELS.has(label);
}

/** Stable portion shared by the select prompt and custom-input follow-up. */
export function dialogQuestionStem(prompt: string): string {
  return parseDialogPrompt(prompt).question.split(/\n\s*\n/, 1)[0].trim();
}

function appendTextElement<K extends keyof HTMLElementTagNameMap>(
  parent: HTMLElement,
  tagName: K,
  className: string,
  text: string,
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tagName);
  element.className = className;
  element.textContent = text;
  parent.appendChild(element);
  return element;
}

export class Dialog implements Component<DialogProps> {
  readonly el: HTMLElement;

  private readonly cardEl: HTMLElement;
  private inputEl: HTMLInputElement | null = null;
  private optionsEl: HTMLElement | null = null;
  private actionsEl: HTMLElement;
  private optionButtons: HTMLButtonElement[] = [];
  private confirmBtn: HTMLButtonElement | null = null;
  private cancelBtn: HTMLButtonElement;

  private selectedIdx = 0;
  private readonly options: string[];
  private customInputMode = false;
  private awaitingCustomFollowUp = false;
  private settled = false;

  constructor(private readonly props: DialogProps) {
    this.el = document.createElement("section");
    this.el.className = "message assistant pi-dialog-message";
    this.el.dataset.dialogId = props.id;
    this.el.dataset.state = "active";
    this.el.setAttribute("role", "group");

    this.options = props.options ?? [];

    this.cardEl = document.createElement("div");
    this.cardEl.className = "pi-dialog";
    this.el.appendChild(this.cardEl);

    const card = this.cardEl;
    const prompt = parseDialogPrompt(props.prompt);
    const headingId = `pi-dialog-heading-${props.id}`;
    const kicker = appendTextElement(card, "div", "pi-dialog-kicker", "question");
    kicker.setAttribute("aria-hidden", "true");

    if (prompt.header) {
      appendTextElement(card, "div", "pi-dialog-header", prompt.header);
    }
    const questionEl = appendTextElement(card, "div", "pi-dialog-prompt", prompt.question);
    questionEl.id = headingId;
    this.el.setAttribute("aria-labelledby", headingId);

    if (props.dialogType === "input") {
      this.createInput(card);
    } else if (props.dialogType === "select") {
      this.createOptions(card);
    }

    this.actionsEl = document.createElement("div");
    this.actionsEl.className = "pi-dialog-actions";
    card.appendChild(this.actionsEl);

    this.cancelBtn = this.createAction("Cancel", "pi-dialog-cancel", () => this.cancel());
    if (props.dialogType !== "select") {
      const label = props.dialogType === "confirm" ? "Confirm" : "Submit";
      this.confirmBtn = this.createAction(label, "pi-dialog-confirm", () => this.submit());
    }

    this.el.addEventListener("keydown", (event) => this.handleKey(event));
  }

  mount(container: HTMLElement): void {
    container.appendChild(this.el);
    const focusTarget = this.inputEl ?? this.optionButtons[0] ?? this.confirmBtn ?? this.cancelBtn;
    setTimeout(() => focusTarget.focus(), 50);
  }

  update(_props: DialogProps): void {
    // Extension UI requests are one-shot.
  }

  destroy(): void {
    this.el.remove();
  }

  private createInput(card: HTMLElement): void {
    this.inputEl = document.createElement("input");
    this.inputEl.className = "pi-dialog-input";
    this.inputEl.type = "text";
    this.inputEl.placeholder = this.props.defaultValue ?? "";
    this.inputEl.autocomplete = "off";
    card.appendChild(this.inputEl);
  }

  private createOptions(card: HTMLElement): void {
    this.optionsEl = document.createElement("div");
    this.optionsEl.className = "pi-dialog-options";
    this.optionsEl.setAttribute("role", "listbox");
    card.appendChild(this.optionsEl);

    this.options.forEach((option, index) => {
      const parts = parseDialogOption(option);
      const button = document.createElement("button");
      button.className = `pi-dialog-option${index === 0 ? " selected" : ""}`;
      button.type = "button";
      button.dataset.index = String(index);
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", index === 0 ? "true" : "false");

      appendTextElement(button, "span", "pi-dialog-option-index", parts.index ?? String(index + 1));
      const body = document.createElement("span");
      body.className = "pi-dialog-option-body";
      button.appendChild(body);
      appendTextElement(body, "span", "pi-dialog-option-label", parts.label);
      if (parts.description) {
        appendTextElement(body, "span", "pi-dialog-option-description", parts.description);
      }

      button.addEventListener("click", () => {
        this.selectedIdx = index;
        this.highlightOption();
        this.submit();
      });
      button.addEventListener("focus", () => {
        if (!this.settled) {
          this.selectedIdx = index;
          this.highlightOption();
        }
      });

      this.optionButtons.push(button);
      this.optionsEl?.appendChild(button);
    });
  }

  private createAction(label: string, className: string, onClick: () => void): HTMLButtonElement {
    const button = document.createElement("button");
    button.className = `pi-dialog-btn ${className}`;
    button.type = "button";
    button.textContent = label;
    button.addEventListener("click", onClick);
    this.actionsEl.appendChild(button);
    return button;
  }

  private handleKey(event: KeyboardEvent): void {
    if (this.settled || this.awaitingCustomFollowUp) { return; }

    if (event.key === "Escape") {
      event.preventDefault();
      this.cancel();
      return;
    }

    if (this.customInputMode) {
      if (event.key === "Enter") {
        event.preventDefault();
        this.submitCustomAnswer();
      }
      return;
    }

    if (this.props.dialogType === "select" && this.options.length > 0) {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        const delta = event.key === "ArrowDown" ? 1 : -1;
        this.selectedIdx = Math.max(0, Math.min(this.selectedIdx + delta, this.options.length - 1));
        this.highlightOption();
        this.optionButtons[this.selectedIdx]?.focus();
      } else if (event.key === "Enter") {
        event.preventDefault();
        this.submit();
      }
      return;
    }

    if (event.key === "Enter") {
      event.preventDefault();
      this.submit();
    }
  }

  private highlightOption(): void {
    this.optionButtons.forEach((button, index) => {
      const selected = index === this.selectedIdx;
      button.classList.toggle("selected", selected);
      button.setAttribute("aria-selected", selected ? "true" : "false");
    });
  }

  private submit(): void {
    if (this.settled || this.awaitingCustomFollowUp) { return; }

    if (this.customInputMode) {
      this.submitCustomAnswer();
      return;
    }

    let value: unknown;
    if (this.props.dialogType === "input") {
      value = this.inputEl?.value ?? "";
    } else if (this.props.dialogType === "confirm") {
      value = true;
    } else {
      const selection = this.options[this.selectedIdx] ?? null;
      if (selection && this.props.onCustomSubmit && isCustomDialogOption(selection)) {
        this.beginCustomAnswer();
        return;
      }
      value = selection;
    }
    this.postResponse(value, false);
  }

  private beginCustomAnswer(): void {
    if (this.customInputMode) { return; }
    this.customInputMode = true;
    this.el.dataset.state = "custom-input";
    this.optionButtons.forEach((button) => { button.disabled = true; });

    const inputGroup = document.createElement("div");
    inputGroup.className = "pi-dialog-custom-input";
    appendTextElement(inputGroup, "label", "pi-dialog-custom-label", "Type your answer:");
    this.inputEl = document.createElement("input");
    this.inputEl.className = "pi-dialog-input";
    this.inputEl.type = "text";
    this.inputEl.autocomplete = "off";
    inputGroup.appendChild(this.inputEl);
    this.cardEl.insertBefore(inputGroup, this.actionsEl);

    this.confirmBtn = this.createAction("Submit", "pi-dialog-confirm", () => this.submitCustomAnswer());
    this.inputEl.focus();
  }

  private submitCustomAnswer(): void {
    if (!this.customInputMode || this.awaitingCustomFollowUp || !this.props.onCustomSubmit) { return; }
    const selection = this.options[this.selectedIdx];
    if (!selection) { return; }

    this.awaitingCustomFollowUp = true;
    this.el.dataset.state = "submitting";
    this.optionButtons.forEach((button) => { button.disabled = true; });
    if (this.inputEl) { this.inputEl.disabled = true; }
    this.cancelBtn.disabled = true;
    if (this.confirmBtn) { this.confirmBtn.disabled = true; }
    this.actionsEl.replaceChildren();
    appendTextElement(this.actionsEl, "span", "pi-dialog-status", "Submitting…");

    this.props.onCustomSubmit(selection, this.inputEl?.value ?? "");
  }

  /** Complete the original select card after its hidden input follow-up resolves. */
  completeCustomAnswer(answer: string): void {
    if (this.settled) { return; }
    if (this.inputEl) {
      this.inputEl.value = answer;
      this.inputEl.disabled = true;
    }
    this.finish(false);
  }

  private cancel(): void {
    this.postResponse(null, true);
  }

  private finish(cancelled: boolean): void {
    this.settled = true;
    this.el.dataset.state = cancelled ? "cancelled" : "answered";
    this.optionButtons.forEach((button) => { button.disabled = true; });
    if (this.inputEl) {
      this.inputEl.readOnly = true;
      this.inputEl.disabled = true;
    }
    this.cancelBtn.disabled = true;
    if (this.confirmBtn) { this.confirmBtn.disabled = true; }

    this.actionsEl.replaceChildren();
    appendTextElement(
      this.actionsEl,
      "span",
      `pi-dialog-status ${cancelled ? "cancelled" : "answered"}`,
      cancelled ? "Cancelled" : "Answered",
    );
  }

  private postResponse(value: unknown, cancelled: boolean): void {
    if (this.settled) { return; }
    this.finish(cancelled);
    this.sendResponse(value);
  }

  private sendResponse(value: unknown): void {
    const vscodeWindow = window as unknown as Window & {
      __vscode: { postMessage(message: unknown): void };
    };
    vscodeWindow.__vscode.postMessage({
      type: "extension_ui_response",
      id: this.props.id,
      value,
    });
  }
}
