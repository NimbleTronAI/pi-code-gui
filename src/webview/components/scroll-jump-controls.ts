import type { Component } from "./types.js";

export type ScrollJumpDestination = "top" | "previous-user" | "next-user" | "bottom";

const POSITION_TOLERANCE_PX = 8;

export function findPreviousUserMessageIndex(
  positions: readonly number[],
  scrollTop: number,
  tolerance = POSITION_TOLERANCE_PX,
): number {
  for (let index = positions.length - 1; index >= 0; index--) {
    if (positions[index]! < scrollTop - tolerance) { return index; }
  }
  return -1;
}

export function findNextUserMessageIndex(
  positions: readonly number[],
  scrollTop: number,
  tolerance = POSITION_TOLERANCE_PX,
): number {
  for (let index = 0; index < positions.length; index++) {
    if (positions[index]! > scrollTop + tolerance) { return index; }
  }
  return -1;
}

interface ScrollJumpControlsOptions {
  onNavigate?: (destination: ScrollJumpDestination) => void;
}

interface NavigationButton {
  element: HTMLButtonElement;
  destination: ScrollJumpDestination;
}

export class ScrollJumpControls implements Component<Record<string, never>> {
  readonly el: HTMLElement;

  private readonly trigger: HTMLButtonElement;
  private readonly buttons: NavigationButton[];
  private readonly observer: MutationObserver;
  private updateFrame: number | null = null;

  constructor(
    private readonly scrollContainer: HTMLElement,
    private readonly options: ScrollJumpControlsOptions = {},
  ) {
    this.el = document.createElement("nav");
    this.el.className = "scroll-jump-controls";
    this.el.setAttribute("aria-label", "Conversation navigation");

    this.trigger = document.createElement("button");
    this.trigger.type = "button";
    this.trigger.className = "scroll-jump-trigger";
    this.trigger.textContent = "↕";
    this.trigger.title = "Conversation navigation";
    this.trigger.setAttribute("aria-label", "Show conversation navigation");
    this.trigger.setAttribute("aria-expanded", "false");

    const actions = document.createElement("div");
    actions.className = "scroll-jump-actions";
    this.buttons = [
      this.createButton("top", "⤒", "Jump to top"),
      this.createButton("previous-user", "↑", "Previous user message"),
      this.createButton("next-user", "↓", "Next user message"),
      this.createButton("bottom", "⤓", "Jump to bottom"),
    ];
    actions.append(...this.buttons.map(({ element }) => element));
    this.el.append(this.trigger, actions);

    this.el.addEventListener("mouseenter", () => this.setExpandedState(true));
    this.el.addEventListener("mouseleave", () => this.setExpandedState(false));
    this.el.addEventListener("focusin", () => this.setExpandedState(true));
    this.el.addEventListener("focusout", (event) => {
      const nextTarget = event.relatedTarget;
      if (!(nextTarget instanceof Node) || !this.el.contains(nextTarget)) {
        this.setExpandedState(false);
      }
    });
    this.scrollContainer.addEventListener("scroll", this.scheduleUpdate, { passive: true });

    this.observer = new MutationObserver(this.scheduleUpdate);
    this.observer.observe(this.scrollContainer, { childList: true, subtree: true });
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
    if (this.updateFrame !== null) { cancelAnimationFrame(this.updateFrame); }
    this.el.remove();
  }

  private readonly scheduleUpdate = (): void => {
    if (this.updateFrame !== null) { return; }
    this.updateFrame = requestAnimationFrame(() => {
      this.updateFrame = null;
      this.updateButtonStates();
    });
  };

  private createButton(
    destination: ScrollJumpDestination,
    symbol: string,
    label: string,
  ): NavigationButton {
    const element = document.createElement("button");
    element.type = "button";
    element.className = "scroll-jump-button";
    element.textContent = symbol;
    element.title = label;
    element.setAttribute("aria-label", label);
    element.addEventListener("click", () => this.navigate(destination));
    return { element, destination };
  }

  private setExpandedState(expanded: boolean): void {
    this.trigger.setAttribute("aria-expanded", expanded ? "true" : "false");
  }

  private getUserMessages(): HTMLElement[] {
    return Array.from(this.scrollContainer.querySelectorAll<HTMLElement>(".message.user"));
  }

  private getMessagePositions(messages: readonly HTMLElement[]): number[] {
    const containerTop = this.scrollContainer.getBoundingClientRect().top;
    return messages.map((message) =>
      message.getBoundingClientRect().top - containerTop + this.scrollContainer.scrollTop,
    );
  }

  private navigate(destination: ScrollJumpDestination): void {
    const messages = this.getUserMessages();
    const positions = this.getMessagePositions(messages);
    let targetTop: number | undefined;

    switch (destination) {
      case "top":
        targetTop = 0;
        break;
      case "bottom":
        targetTop = this.scrollContainer.scrollHeight;
        break;
      case "previous-user": {
        const index = findPreviousUserMessageIndex(positions, this.scrollContainer.scrollTop);
        if (index >= 0) { targetTop = positions[index]; }
        break;
      }
      case "next-user": {
        const index = findNextUserMessageIndex(positions, this.scrollContainer.scrollTop);
        if (index >= 0) { targetTop = positions[index]; }
        break;
      }
    }

    if (targetTop === undefined) { return; }
    this.options.onNavigate?.(destination);
    this.scrollContainer.scrollTo({
      top: Math.max(0, targetTop),
      behavior: "smooth",
    });
  }

  private updateButtonStates(): void {
    const messages = this.getUserMessages();
    const positions = this.getMessagePositions(messages);
    const scrollTop = this.scrollContainer.scrollTop;
    const maxScroll = Math.max(0, this.scrollContainer.scrollHeight - this.scrollContainer.clientHeight);
    const previousIndex = findPreviousUserMessageIndex(positions, scrollTop);
    const nextIndex = findNextUserMessageIndex(positions, scrollTop);

    this.el.hidden = messages.length === 0 && maxScroll <= POSITION_TOLERANCE_PX;
    for (const { element, destination } of this.buttons) {
      switch (destination) {
        case "top":
          element.disabled = scrollTop <= POSITION_TOLERANCE_PX;
          break;
        case "bottom":
          element.disabled = maxScroll - scrollTop <= POSITION_TOLERANCE_PX;
          break;
        case "previous-user":
          element.disabled = previousIndex < 0;
          break;
        case "next-user":
          element.disabled = nextIndex < 0;
          break;
      }
    }
  }
}
