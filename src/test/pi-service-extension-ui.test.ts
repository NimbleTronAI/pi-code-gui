import * as assert from "node:assert";
import { PiService } from "../pi-service.js";

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- white-box access to the private UI bridge
type AnyRecord = Record<string, any>;

/**
 * Bind the extension UI context against a stub session and return it.
 *
 * The context is returned inside a wrapper because it is a Proxy that answers
 * every property with a no-op function — including `then`, which would make
 * `await` treat it as a never-settling thenable.
 */
async function captureUIContext(): Promise<{ uiContext: AnyRecord }> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any -- focused white-box regression test
  const service = new PiService() as any;
  let bindings: AnyRecord | undefined;
  service.session = {
    bindExtensions: async (received: AnyRecord) => { bindings = received; },
    dispose: () => undefined,
  };

  try {
    await service.bindExtensionUI();
  } finally {
    // Releases the widget staleness interval created by bindExtensionUI().
    service.dispose();
  }

  assert.ok(bindings, "bindExtensions() was not called");
  assert.ok(bindings.uiContext, "bindExtensions() received no uiContext");
  return { uiContext: bindings.uiContext as AnyRecord };
}

suite("PiService extension UI context", () => {
  test("ui.custom() resolves to undefined instead of returning undefined", async () => {
    const { uiContext } = await captureUIContext();

    assert.strictEqual(typeof uiContext.custom, "function");
    // ExtensionUIContext.custom() is declared as Promise<T>; extensions chain
    // .then() on the result, so a synchronous undefined crashes them.
    const result = uiContext.custom(() => ({ render: () => [] }), { overlay: true });
    assert.strictEqual(
      typeof result?.then,
      "function",
      "ui.custom() must return a Promise so extensions can chain .then()",
    );
    assert.strictEqual(await result, undefined);
  });

  test("renders and drives a focused custom component", async () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- focused white-box regression test
    const service = new PiService() as any;
    const events: AnyRecord[] = [];
    let bindings: AnyRecord | undefined;
    service.session = {
      bindExtensions: async (received: AnyRecord) => { bindings = received; },
      dispose: () => undefined,
    };
    service.onEvent((event: AnyRecord) => events.push(event));

    try {
      await service.bindExtensionUI();
      assert.ok(bindings?.uiContext);
      let selected = false;
      const resultPromise = bindings.uiContext.custom(
        (tui: AnyRecord, _theme: AnyRecord, keybindings: AnyRecord, done: (value: string) => void) => ({
          render: (width: number) => [
            `\x1b[36mwidth=${width}\x1b[0m`,
            selected ? "selected" : "idle",
            "safe\x1b[2J",
          ],
          handleInput: (data: string) => {
            if (keybindings.matches(data, "tui.select.down")) {
              selected = true;
              tui.requestRender();
            }
            if (keybindings.matches(data, "tui.select.confirm")) {
              done("accepted");
            }
          },
          invalidate: () => undefined,
        }),
        { overlay: true, overlayOptions: { width: 82, anchor: "top-center", maxHeight: "80%" } },
      );
      await new Promise<void>((resolve) => setImmediate(resolve));

      const open = events.find((event) => event.type === "custom-ui-open");
      assert.ok(open, "custom UI did not emit its initial frame");
      assert.deepStrictEqual(open.data.lines, ["\x1b[36mwidth=82\x1b[0m", "idle", "safe"]);
      assert.strictEqual(open.data.anchor, "top-center");
      assert.strictEqual(open.data.maxHeight, "80%");

      service.handleCustomUiInput(open.data.id, "\x1b[B", 72);
      const update = [...events].reverse().find((event) => event.type === "custom-ui-update");
      assert.deepStrictEqual(update?.data.lines, ["\x1b[36mwidth=72\x1b[0m", "selected", "safe"]);

      service.handleCustomUiInput(open.data.id, "\r", 72);
      assert.strictEqual(await resultPromise, "accepted");
      assert.ok(events.some((event) => event.type === "custom-ui-close"));
    } finally {
      service.dispose();
    }
  });

  test("provides a theme for extensions that format status text", async () => {
    const { uiContext } = await captureUIContext();

    assert.strictEqual(uiContext.theme.fg("accent", "MCP: connected"), "MCP: connected");
    assert.doesNotThrow(() => {
      const status = uiContext.theme
        ? uiContext.theme.fg("accent", "MCP: 1 server enabled (1 connected)")
        : "MCP: 1 server enabled (1 connected)";
      uiContext.setStatus("mcp", status);
    });
  });

  test("unimplemented ui methods still no-op through the proxy", async () => {
    const { uiContext } = await captureUIContext();

    assert.doesNotThrow(() => uiContext.setFooter(undefined));
  });
});
