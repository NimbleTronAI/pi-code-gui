// Tests for API-key storage + the one-way migration out of plaintext settings.
import { test } from "node:test";
import assert from "node:assert/strict";
import { initSecrets, getApiKey, setApiKey, __resetSecretsForTest } from "../../secrets.js";

type Any = ReturnType<typeof JSON.parse>;

/** An in-memory SecretStorage. `failing` models a keychain that isn't available. */
function fakeStore(initial: Record<string, string> = {}, failing = false): Any {
  const map = new Map(Object.entries(initial));
  return {
    map,
    get: async (k: string) => { if (failing) { throw new Error("keychain unavailable"); } return map.get(k); },
    store: async (k: string, v: string) => { if (failing) { throw new Error("keychain unavailable"); } map.set(k, v); },
    delete: async (k: string) => { map.delete(k); },
  };
}

test("migrates a plaintext settings key into SecretStorage and CLEARS the setting", async () => {
  __resetSecretsForTest();
  const store = fakeStore();
  const settings: Record<string, string | undefined> = { anthropicApiKey: "sk-ant-plaintext-value-123" };
  const cleared: string[] = [];
  await initSecrets(store, (k) => settings[k], async (k) => { cleared.push(k); delete settings[k]; });

  assert.equal(getApiKey("anthropicApiKey"), "sk-ant-plaintext-value-123", "usable immediately");
  assert.equal(store.map.get("pi-code-gui.anthropicApiKey"), "sk-ant-plaintext-value-123", "now in SecretStorage");
  assert.deepEqual(cleared, ["anthropicApiKey"], "plaintext copy removed");
  assert.equal(settings.anthropicApiKey, undefined);
});

test("an already-stored secret is used and does not need settings", async () => {
  __resetSecretsForTest();
  const store = fakeStore({ "pi-code-gui.openaiApiKey": "sk-stored-0123456789" });
  const cleared: string[] = [];
  await initSecrets(store, () => undefined, async (k) => { cleared.push(k); });
  assert.equal(getApiKey("openaiApiKey"), "sk-stored-0123456789");
  assert.deepEqual(cleared, [], "nothing to clear");
});

test("SecretStorage wins when both exist, and the plaintext copy is still cleared", async () => {
  __resetSecretsForTest();
  const store = fakeStore({ "pi-code-gui.anthropicApiKey": "sk-ant-stored-999999" });
  const settings: Record<string, string | undefined> = { anthropicApiKey: "sk-ant-stale-synced-111" };
  const cleared: string[] = [];
  await initSecrets(store, (k) => settings[k], async (k) => { cleared.push(k); delete settings[k]; });
  assert.equal(getApiKey("anthropicApiKey"), "sk-ant-stored-999999", "stored value wins");
  assert.deepEqual(cleared, ["anthropicApiKey"], "the synced plaintext copy is removed");
});

test("no keys anywhere → undefined, no crash", async () => {
  __resetSecretsForTest();
  await initSecrets(fakeStore(), () => undefined, async () => {});
  assert.equal(getApiKey("anthropicApiKey"), undefined);
  assert.equal(getApiKey("openaiApiKey"), undefined);
});

test("an unavailable keychain degrades gracefully and still serves the settings value", async () => {
  __resetSecretsForTest();
  const settings: Record<string, string | undefined> = { openaiApiKey: "sk-fallback-0123456789" };
  await assert.doesNotReject(() =>
    initSecrets(fakeStore({}, true), (k) => settings[k], async () => {}),
  );
  // Migration couldn't store it, so the setting is deliberately left in place and still used.
  assert.equal(getApiKey("openaiApiKey"), "sk-fallback-0123456789");
  assert.equal(settings.openaiApiKey, "sk-fallback-0123456789", "not cleared when it couldn't be stored");
});

test("setApiKey stores and clears at runtime", async () => {
  __resetSecretsForTest();
  const store = fakeStore();
  await initSecrets(store, () => undefined, async () => {});
  await setApiKey("anthropicApiKey", "sk-ant-runtime-set-4444");
  assert.equal(getApiKey("anthropicApiKey"), "sk-ant-runtime-set-4444");
  await setApiKey("anthropicApiKey", undefined);
  assert.equal(getApiKey("anthropicApiKey"), undefined, "cleared");
  assert.equal(store.map.has("pi-code-gui.anthropicApiKey"), false);
});
