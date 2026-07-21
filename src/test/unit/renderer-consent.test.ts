// Consent gate for custom message renderers (audit H3). A pi extension registers a renderer by
// shipping SOURCE CODE that the webview injects as a <script> with the CSP nonce and executes —
// arbitrary JS in the chat view. The feature stays, but only with remembered user consent.
import { test } from "node:test";
import assert from "node:assert/strict";
import { confirmRendererConsent, resetRendererConsent, __setRendererConsentContextForTest } from "../../renderer-consent.js";

type Any = ReturnType<typeof JSON.parse>;

function ctx(): Any {
  const store: Record<string, Any> = {};
  return { globalState: { get: (k: string, d?: Any) => store[k] ?? d, update: async (k: string, v: Any) => { store[k] = v; } } };
}
const mock = () => (globalThis as Any).__vscodeMock;

test("allowing is remembered — the user is asked only once", async () => {
  __setRendererConsentContextForTest(ctx());
  mock().calls = [];
  mock().quickPick = [];
  // showWarningMessage returns items[0] in the stub, i.e. "Allow".
  assert.equal(await confirmRendererConsent("my-card"), true);
  const asked = mock().calls.filter((c: Any) => c.kind === "warn").length;
  assert.equal(asked, 1);
  assert.equal(await confirmRendererConsent("my-card"), true, "second call uses the stored decision");
  assert.equal(mock().calls.filter((c: Any) => c.kind === "warn").length, asked, "not asked again");
});

test("concurrent registrations for one type prompt only once", async () => {
  __setRendererConsentContextForTest(ctx());
  mock().calls = [];
  const [a, b, c] = await Promise.all([
    confirmRendererConsent("burst"), confirmRendererConsent("burst"), confirmRendererConsent("burst"),
  ]);
  assert.deepEqual([a, b, c], [true, true, true]);
  assert.equal(mock().calls.filter((x: Any) => x.kind === "warn").length, 1, "one prompt for three registrations");
});

test("no extension context → fails CLOSED (no source reaches the webview)", async () => {
  __setRendererConsentContextForTest(null);
  assert.equal(await confirmRendererConsent("x"), false);
});

test("resetRendererConsent clears remembered decisions", async () => {
  const c = ctx();
  __setRendererConsentContextForTest(c);
  mock().calls = [];
  await confirmRendererConsent("resettable");
  await resetRendererConsent();
  mock().calls = [];
  await confirmRendererConsent("resettable");
  assert.equal(mock().calls.filter((x: Any) => x.kind === "warn").length, 1, "asked again after reset");
});

test("denying is remembered, and DISMISSING is not consent (asks again next time)", async () => {
  __setRendererConsentContextForTest(ctx());
  mock().calls = [];
  mock().messageChoice = ["Don't allow"];
  assert.equal(await confirmRendererConsent("nope"), false);
  mock().messageChoice = [];
  assert.equal(await confirmRendererConsent("nope"), false, "denial remembered");
  assert.equal(mock().calls.filter((x: Any) => x.kind === "warn").length, 1, "not re-asked after an explicit denial");

  // Dismissal (undefined) must NOT be stored as a decision.
  mock().calls = [];
  mock().messageChoice = [undefined];
  assert.equal(await confirmRendererConsent("dismissed"), false, "dismiss denies for now");
  mock().messageChoice = ["Allow"];
  assert.equal(await confirmRendererConsent("dismissed"), true, "asked again — dismissal was not remembered");
  assert.equal(mock().calls.filter((x: Any) => x.kind === "warn").length, 2);
});
