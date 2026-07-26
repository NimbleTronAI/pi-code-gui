import * as assert from "node:assert";
import { scrollSelectedSlashItemIntoView } from "../webview/render/slash-navigation.js";

suite("Webview slash command navigation", () => {
  test("scrolls the keyboard-selected command into view", () => {
    let receivedOptions: boolean | ScrollIntoViewOptions | undefined;
    const selectedItem = {
      scrollIntoView: (options?: boolean | ScrollIntoViewOptions) => {
        receivedOptions = options;
      },
    } as Element;
    const container = {
      querySelector: (selector: string) => selector === ".slash-item.selected" ? selectedItem : null,
    } as unknown as ParentNode;

    scrollSelectedSlashItemIntoView(container);

    assert.deepStrictEqual(receivedOptions, { block: "nearest", inline: "nearest" });
  });

  test("does nothing when no command is selected", () => {
    const container = {
      querySelector: () => null,
    } as unknown as ParentNode;

    assert.doesNotThrow(() => scrollSelectedSlashItemIntoView(container));
  });
});
