import * as assert from "node:assert";
import * as vscode from "vscode";
import {
  clearProviderApiKeys,
  getProviderSecretKey,
  readProviderApiKey,
  storeProviderApiKey,
} from "../provider-credentials.js";

function createSecretStorage(initial: Record<string, string> = {}): {
  storage: vscode.SecretStorage;
  values: Map<string, string>;
} {
  const values = new Map(Object.entries(initial));
  const storage = {
    get: async (key: string) => values.get(key),
    store: async (key: string, value: string) => { values.set(key, value); },
    delete: async (key: string) => { values.delete(key); },
  } as unknown as vscode.SecretStorage;
  return { storage, values };
}

function createLegacyConfiguration(initial: Record<string, string>): {
  configuration: vscode.WorkspaceConfiguration;
  cleared: Array<{ key: string; target: vscode.ConfigurationTarget }>;
} {
  const values = new Map(Object.entries(initial));
  const cleared: Array<{ key: string; target: vscode.ConfigurationTarget }> = [];
  const configuration = {
    get: <T>(key: string): T | undefined => values.get(key) as T | undefined,
    inspect: <T>(key: string) => {
      const value = values.get(key) as T | undefined;
      return value === undefined ? undefined : {
        key: `pi-on-code.${key}`,
        defaultValue: undefined,
        globalValue: value,
        workspaceValue: undefined,
        workspaceFolderValue: undefined,
        defaultLanguageValue: undefined,
        globalLanguageValue: undefined,
        workspaceLanguageValue: undefined,
        workspaceFolderLanguageValue: undefined,
        languageIds: undefined,
      };
    },
    update: async (key: string, value: unknown, target: vscode.ConfigurationTarget) => {
      if (value === undefined) { values.delete(key); }
      cleared.push({ key, target });
    },
    has: (key: string) => values.has(key),
  } as vscode.WorkspaceConfiguration;
  return { configuration, cleared };
}

suite("Provider credential storage", () => {
  test("stores and reads provider API keys from SecretStorage", async () => {
    const { storage } = createSecretStorage();
    const { configuration } = createLegacyConfiguration({
      anthropicApiKey: "old-plaintext-value",
    });

    await storeProviderApiKey(storage, "anthropic", "  secret-value  ");

    assert.strictEqual(
      await readProviderApiKey(storage, configuration, "anthropic"),
      "secret-value",
    );
    assert.strictEqual(configuration.get("anthropicApiKey"), undefined);
  });

  test("migrates legacy settings and clears their plaintext value", async () => {
    const { storage, values } = createSecretStorage();
    const { configuration, cleared } = createLegacyConfiguration({
      openaiApiKey: "legacy-key",
    });

    assert.strictEqual(
      await readProviderApiKey(storage, configuration, "openai"),
      "legacy-key",
    );
    assert.strictEqual(values.get(getProviderSecretKey("openai")), "legacy-key");
    assert.deepStrictEqual(cleared, [{
      key: "openaiApiKey",
      target: vscode.ConfigurationTarget.Global,
    }]);
  });

  test("clears both providers and legacy settings", async () => {
    const { storage, values } = createSecretStorage({
      [getProviderSecretKey("anthropic")]: "a",
      [getProviderSecretKey("openai")]: "o",
    });
    const { configuration } = createLegacyConfiguration({
      anthropicApiKey: "legacy-a",
      openaiApiKey: "legacy-o",
    });

    await clearProviderApiKeys(storage, configuration);

    assert.strictEqual(values.size, 0);
    assert.strictEqual(configuration.get("anthropicApiKey"), undefined);
    assert.strictEqual(configuration.get("openaiApiKey"), undefined);
  });
});
