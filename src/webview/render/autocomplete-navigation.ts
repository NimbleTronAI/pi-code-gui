export type AutocompleteDirection = "next" | "previous";

export interface AutocompleteNavigationOptions {
  currentIndex: number;
  itemCount: number;
  direction: AutocompleteDirection;
  container: ParentNode;
  renderSelection: (index: number) => void;
}

export function nextAutocompleteIndex(
  currentIndex: number,
  itemCount: number,
  direction: AutocompleteDirection,
): number {
  if (itemCount <= 0) { return 0; }
  const delta = direction === "next" ? 1 : -1;
  return Math.max(0, Math.min(itemCount - 1, currentIndex + delta));
}

export function scrollSelectedAutocompleteItemIntoView(container: ParentNode): void {
  const selectedItem = container.querySelector(".selected");
  selectedItem?.scrollIntoView({ block: "nearest", inline: "nearest" });
}

export function navigateAutocompleteSelection(
  options: AutocompleteNavigationOptions,
): number {
  const nextIndex = nextAutocompleteIndex(
    options.currentIndex,
    options.itemCount,
    options.direction,
  );
  options.renderSelection(nextIndex);
  scrollSelectedAutocompleteItemIntoView(options.container);
  return nextIndex;
}
