import type { Component } from "./types.js";

const PREVIEW_CHARACTER_LIMIT = 700;
const ACTIVE_TURN_TOLERANCE_PX = 8;

export const CONVERSATION_TURNS_EVENT = "pi-conversation-turns-update";

export interface ConversationTurnPreview {
  entryId: string;
  user: string;
  agent: string;
}

export function truncateTurnPreview(
  text: string,
  maxLength = PREVIEW_CHARACTER_LIMIT,
): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) { return normalized; }
  return `${normalized.slice(0, Math.max(0, maxLength - 1)).trimEnd()}…`;
}

export function findActiveTurnIndex(
  positions: readonly number[],
  viewportAnchor: number,
  tolerance = ACTIVE_TURN_TOLERANCE_PX,
): number {
  if (positions.length === 0) { return -1; }
  for (let index = positions.length - 1; index >= 0; index--) {
    if (positions[index]! <= viewportAnchor + tolerance) { return index; }
  }
  return 0;
}

export function getTurnTickPercent(index: number, count: number): number {
  if (count <= 1) { return 50; }
  return Math.max(0, Math.min(100, (index / (count - 1)) * 100));
}

export function getHoverTickWidth(distance: number): number {
  return [22, 16, 12, 9][Math.abs(distance)] ?? 7;
}

interface ConversationMinimapOptions {
  onNavigate?: () => void;
  onLoadTurn?: (entryId: string) => void;
}

export class ConversationMinimap implements Component<Record<string, never>> {
  readonly el: HTMLElement;

  private readonly ticks: HTMLElement;
  private readonly tooltip: HTMLElement;
  private readonly userPreview: HTMLElement;
  private readonly agentPreview: HTMLElement;
  private readonly observer: MutationObserver;
  private turns: ConversationTurnPreview[] = [];
  private tickButtons: HTMLButtonElement[] = [];
  private activeIndex = -1;
  private previewTurn: ConversationTurnPreview | null = null;
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
    this.scrollContainer.addEventListener("scroll", this.scheduleUpdate, { passive: true });
    window.addEventListener("resize", this.scheduleUpdate, { passive: true });
    window.addEventListener(CONVERSATION_TURNS_EVENT, this.handleTurnsUpdate);

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
    this.scrollContainer.removeEventListener("scroll", this.scheduleUpdate);
    window.removeEventListener("resize", this.scheduleUpdate);
    window.removeEventListener(CONVERSATION_TURNS_EVENT, this.handleTurnsUpdate);
    if (this.updateFrame !== null) { cancelAnimationFrame(this.updateFrame); }
    this.el.remove();
  }

  private readonly handleTurnsUpdate = (event: Event): void => {
    if (!(event instanceof CustomEvent) || !Array.isArray(event.detail)) { return; }
    const nextTurns = event.detail.flatMap((value: unknown): ConversationTurnPreview[] => {
      if (!value || typeof value !== "object") { return []; }
      const turn = value as Record<string, unknown>;
      if (
        typeof turn.entryId !== "string"
        || typeof turn.user !== "string"
        || typeof turn.agent !== "string"
      ) {
        return [];
      }
      return [{ entryId: turn.entryId, user: turn.user, agent: turn.agent }];
    });
    const sameTurns = nextTurns.length === this.turns.length
      && nextTurns.every((turn, index) => turn.entryId === this.turns[index]?.entryId);
    const previewEntryId = this.previewTurn?.entryId;
    this.turns = nextTurns;
    if (sameTurns) {
      this.previewTurn = nextTurns.find((turn) => turn.entryId === previewEntryId) ?? null;
      if (this.previewTurn) { this.updateTooltipContent(this.previewTurn); }
      return;
    }
    this.rebuildTicks();
    this.updateMinimapHeight();
  };

  private readonly scheduleUpdate = (): void => {
    if (this.updateFrame !== null) { return; }
    this.updateFrame = requestAnimationFrame(() => {
      this.updateFrame = null;
      this.updateMinimapHeight();
      this.updateActiveTurn();
      if (this.previewTurn) { this.updateTooltipContent(this.previewTurn); }
    });
  };

  private rebuildTicks(): void {
    this.previewTurn = null;
    this.tooltip.hidden = true;
    this.tickButtons = this.turns.map((turn, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "conversation-minimap-tick";
      button.style.top = `${getTurnTickPercent(index, this.turns.length)}%`;
      button.setAttribute("aria-label", `Jump to user message ${index + 1}`);
      button.addEventListener("mouseenter", () => {
        this.showTooltip(this.turns[index] ?? turn, button, index);
      });
      button.addEventListener("click", () => this.navigateTo(this.turns[index] ?? turn));
      return button;
    });
    this.ticks.replaceChildren(...this.tickButtons);
    this.el.hidden = this.turns.length === 0;
    this.activeIndex = -1;
    this.updateActiveTurn();
  }

  private updateMinimapHeight(): void {
    const preferredHeight = Math.max(16, (this.turns.length - 1) * 10);
    const viewportLimit = Math.max(28, Math.min(320, window.innerHeight * 0.42));
    this.el.style.height = `${Math.min(preferredHeight, viewportLimit)}px`;
  }

  private findLoadedUser(entryId: string): HTMLElement | undefined {
    return Array.from(
      this.scrollContainer.querySelectorAll<HTMLElement>(".message.user[data-entry-id]"),
    ).find((message) => message.getAttribute("data-entry-id") === entryId);
  }

  private updateActiveTurn(): void {
    const messages = Array.from(
      this.scrollContainer.querySelectorAll<HTMLElement>(".message.user[data-entry-id]"),
    );
    const containerTop = this.scrollContainer.getBoundingClientRect().top;
    const positions = messages.map((message) =>
      message.getBoundingClientRect().top - containerTop + this.scrollContainer.scrollTop,
    );
    const anchor = this.scrollContainer.scrollTop
      + Math.min(120, this.scrollContainer.clientHeight * 0.25);
    const loadedIndex = findActiveTurnIndex(positions, anchor);
    const entryId = loadedIndex >= 0 ? messages[loadedIndex]?.getAttribute("data-entry-id") : null;
    const nextIndex = entryId
      ? this.turns.findIndex((turn) => turn.entryId === entryId)
      : messages.length === 0 && this.turns.length > 0 ? this.turns.length - 1 : -1;
    if (nextIndex === this.activeIndex) { return; }
    if (this.activeIndex >= 0) {
      this.tickButtons[this.activeIndex]?.classList.remove("active");
      this.tickButtons[this.activeIndex]?.removeAttribute("aria-current");
    }
    this.activeIndex = nextIndex;
    if (nextIndex >= 0) {
      this.tickButtons[nextIndex]?.classList.add("active");
      this.tickButtons[nextIndex]?.setAttribute("aria-current", "true");
    }
  }

  private navigateTo(turn: ConversationTurnPreview): void {
    this.options.onNavigate?.();
    const message = this.findLoadedUser(turn.entryId);
    if (!message) {
      this.options.onLoadTurn?.(turn.entryId);
      return;
    }
    const containerTop = this.scrollContainer.getBoundingClientRect().top;
    const targetTop = message.getBoundingClientRect().top
      - containerTop
      + this.scrollContainer.scrollTop;
    this.scrollContainer.scrollTo({ top: Math.max(0, targetTop), behavior: "smooth" });
  }

  private showTooltip(
    turn: ConversationTurnPreview,
    button: HTMLButtonElement,
    hoveredIndex: number,
  ): void {
    this.previewTurn = turn;
    for (let index = 0; index < this.tickButtons.length; index++) {
      const tick = this.tickButtons[index]!;
      tick.removeAttribute("aria-describedby");
      tick.style.setProperty("--conversation-minimap-tick-width", `${getHoverTickWidth(index - hoveredIndex)}px`);
    }
    this.updateTooltipContent(turn);
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
    this.previewTurn = null;
    this.tooltip.hidden = true;
    for (const button of this.tickButtons) {
      button.removeAttribute("aria-describedby");
      button.style.removeProperty("--conversation-minimap-tick-width");
    }
  };

  private updateTooltipContent(turn: ConversationTurnPreview): void {
    const loadedUser = this.findLoadedUser(turn.entryId);
    const userText = loadedUser ? this.readMessageText(loadedUser) : turn.user;
    const loadedAgentParts: string[] = [];
    let sibling = loadedUser?.nextElementSibling ?? null;
    while (sibling && !sibling.matches(".message.user")) {
      if (sibling instanceof HTMLElement && sibling.matches(".message.assistant")) {
        const text = this.readMessageText(sibling, true);
        if (text) { loadedAgentParts.push(text); }
      }
      sibling = sibling.nextElementSibling;
    }

    this.userPreview.textContent = userText || "User message";
    const agentText = loadedAgentParts.length > 0
      ? truncateTurnPreview(loadedAgentParts.join(" "))
      : turn.agent;
    this.agentPreview.textContent = agentText || "Waiting for response…";
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
