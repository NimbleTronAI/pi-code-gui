import * as assert from "node:assert";
import {
  navigateAutocompleteSelection,
  nextAutocompleteIndex,
  scrollSelectedAutocompleteItemIntoView,
} from "../webview/render/autocomplete-navigation.js";

suite("Webview autocomplete navigation", () => {
  test("moves within menu bounds", () => {
    assert.strictEqual(nextAutocompleteIndex(0, 4, "next"), 1);
    assert.strictEqual(nextAutocompleteIndex(3, 4, "next"), 3);
    assert.strictEqual(nextAutocompleteIndex(2, 4, "previous"), 1);
    assert.strictEqual(nextAutocompleteIndex(0, 4, "previous"), 0);
    assert.strictEqual(nextAutocompleteIndex(0, 0, "next"), 0);
  });

  test("renders and scrolls the selected item after keyboard navigation", () => {
    let selectedIndex = -1;
    let receivedOptions: boolean | ScrollIntoViewOptions | undefined;
    const selectedItem = {
      scrollIntoView: (options?: boolean | ScrollIntoViewOptions) => {
        receivedOptions = options;
      },
    } as Element;
    const container = {
      querySelector: (selector: string) => selector === ".selected" ? selectedItem : null,
    } as unknown as ParentNode;

    const nextIndex = navigateAutocompleteSelection({
      currentIndex: 4,
      itemCount: 12,
      direction: "next",
      container,
      renderSelection: (index) => { selectedIndex = index; },
    });

    assert.strictEqual(nextIndex, 5);
    assert.strictEqual(selectedIndex, 5);
    assert.deepStrictEqual(receivedOptions, { block: "nearest", inline: "nearest" });
  });

  test("does nothing when no item is selected", () => {
    const container = {
      querySelector: () => null,
    } as unknown as ParentNode;

    assert.doesNotThrow(() => scrollSelectedAutocompleteItemIntoView(container));
  });
});
