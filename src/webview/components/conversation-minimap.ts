import type { Component } from "./types.js";

const PREVIEW_CHARACTER_LIMIT = 700;

export function truncateTurnPreview(
  text: string,
  maxLength = PREVIEW_CHARACTER_LIMIT,
): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) { return normalized; }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function getTurnTickPercent(index: number, count: number): number {
  if (count <= 1) { return 50; }
  return Math.max(0, Math.min(100, (index / (count - 1)) * 100));
}

interface ConversationMinimapOptions {
  onNavigate?: () => void;
}

export class ConversationMinimap implements Component<Record<string, never>> {
  readonly el: HTMLElement;

  private readonly ticks: HTMLElement;
  private readonly tooltip: HTMLElement;
  private readonly userPreview: HTMLElement;
  private readonly agentPreview: HTMLElement;
  private readonly observer: MutationObserver;
  private userMessages: HTMLElement[] = [];
  private tickButtons: HTMLButtonElement[] = [];
  private previewUser: HTMLElement | null = null;
  private updateFrame: number | null = null;

  constructor(
    private readonly scrollContainer: HTMLElement,
    private readonly options: ConversationMinimapOptions = {},
  ) {
    this.el = document.createElement("nav");
    this.el.className = "conversation-minimap";
    this.el.setAttribute("aria-label", "Conversation minimap");

    this.ticks = document.createElement("div");
    this.ticks.className = "conversation-minimap-ticks";

    this.tooltip = document.createElement("div");
    this.tooltip.className = "conversation-minimap-tooltip";
    this.tooltip.id = `conversation-minimap-tooltip-${Math.random().toString(36).slice(2, 8)}`;
    this.tooltip.setAttribute("role", "tooltip");
    this.tooltip.hidden = true;

    this.userPreview = document.createElement("div");
    this.userPreview.className = "conversation-minimap-tooltip-user";
    this.agentPreview = document.createElement("div");
    this.agentPreview.className = "conversation-minimap-tooltip-agent";

    this.tooltip.append(this.userPreview, this.agentPreview);
    this.el.append(this.ticks, this.tooltip);

    this.el.addEventListener("mouseleave", this.hideTooltip);
    window.addEventListener("resize", this.scheduleUpdate, { passive: true });

    this.observer = new MutationObserver(this.scheduleUpdate);
    this.observer.observe(this.scrollContainer, {
      childList: true,
      subtree: true,
      characterData: true,
    });
    this.scheduleUpdate();
  }

  mount(container: HTMLElement): void {
    container.appendChild(this.el);
    this.scheduleUpdate();
  }

  update(): void {
    this.scheduleUpdate();
  }

  destroy(): void {
    this.observer.disconnect();
    window.removeEventListener("resize", this.scheduleUpdate);
    if (this.updateFrame !== null) { cancelAnimationFrame(this.updateFrame); }
    this.el.remove();
  }

  private readonly scheduleUpdate = (): void => {
    if (this.updateFrame !== null) { return; }
    this.updateFrame = requestAnimationFrame(() => {
      this.updateFrame = null;
      this.sync();
    });
  };

  private sync(): void {
    const messages = Array.from(
      this.scrollContainer.querySelectorAll<HTMLElement>(".message.user"),
    );
    const changed = messages.length !== this.userMessages.length
      || messages.some((message, index) => message !== this.userMessages[index]);
    if (changed) {
      this.userMessages = messages;
      this.rebuildTicks();
    }
    this.updateMinimapHeight();
    if (this.previewUser?.isConnected) { this.updateTooltipContent(this.previewUser); }
  }

  private rebuildTicks(): void {
    this.previewUser = null;
    this.tooltip.hidden = true;
    this.tickButtons = this.userMessages.map((message, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "conversation-minimap-tick";
      button.style.top = `${getTurnTickPercent(index, this.userMessages.length)}%`;
      button.setAttribute("aria-label", `Jump to user message ${index + 1}`);
      button.addEventListener("mouseenter", () => this.showTooltip(message, button));
      button.addEventListener("click", () => this.navigateTo(message));
      return button;
    });
    this.ticks.replaceChildren(...this.tickButtons);
    this.el.hidden = this.userMessages.length === 0;
  }

  private updateMinimapHeight(): void {
    const preferredHeight = Math.max(16, (this.userMessages.length - 1) * 10);
    const viewportLimit = Math.max(28, Math.min(320, window.innerHeight * 0.42));
    this.el.style.height = `${Math.min(preferredHeight, viewportLimit)}px`;
  }

  private navigateTo(message: HTMLElement): void {
    const containerTop = this.scrollContainer.getBoundingClientRect().top;
    const targetTop = message.getBoundingClientRect().top
      - containerTop
      + this.scrollContainer.scrollTop;
    this.options.onNavigate?.();
    this.scrollContainer.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
  }

  private showTooltip(message: HTMLElement, button: HTMLButtonElement): void {
    this.previewUser = message;
    for (const tick of this.tickButtons) { tick.removeAttribute("aria-describedby"); }
    this.updateTooltipContent(message);
    this.tooltip.hidden = false;
    const minimapTop = this.el.getBoundingClientRect().top;
    const desiredCenter = minimapTop + button.offsetTop + button.offsetHeight / 2;
    const halfHeight = this.tooltip.offsetHeight / 2;
    const clampedCenter = Math.max(
      halfHeight + 8,
      Math.min(window.innerHeight - halfHeight - 8, desiredCenter),
    );
    this.tooltip.style.top = `${clampedCenter - minimapTop}px`;
    button.setAttribute("aria-describedby", this.tooltip.id);
  }

  private readonly hideTooltip = (): void => {
    this.previewUser = null;
    this.tooltip.hidden = true;
    for (const button of this.tickButtons) { button.removeAttribute("aria-describedby"); }
  };

  private updateTooltipContent(userMessage: HTMLElement): void {
    this.userPreview.textContent = this.readMessageText(userMessage) || "User message";
    const agentParts: string[] = [];
    let sibling = userMessage.nextElementSibling;
    while (sibling && !sibling.matches(".message.user")) {
      if (sibling instanceof HTMLElement && sibling.matches(".message.assistant")) {
        const text = this.readMessageText(sibling, true);
        if (text) { agentParts.push(text); }
      }
      sibling = sibling.nextElementSibling;
    }
    this.agentPreview.textContent = agentParts.length > 0
      ? truncateTurnPreview(agentParts.join(" "))
      : "Waiting for response…";
  }

  private readMessageText(message: HTMLElement, excludeThinking = false): string {
    const content = message.querySelector<HTMLElement>(":scope > .message-content");
    if (!content) { return ""; }
    const previewContent = excludeThinking
      ? content.cloneNode(true) as HTMLElement
      : content;
    if (excludeThinking) {
      previewContent.querySelectorAll(".thinking-block").forEach((element) => element.remove());
    }
    const text = Array.from(previewContent.childNodes)
      .map((node) => node.textContent ?? "")
      .join(" ");
    return truncateTurnPreview(text);
  }
}
