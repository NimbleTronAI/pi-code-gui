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

  test("unimplemented ui methods still no-op through the proxy", async () => {
    const { uiContext } = await captureUIContext();

    assert.doesNotThrow(() => uiContext.setFooter(undefined));
  });
});
