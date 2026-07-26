import * as vscode from "vscode";

export type ApiKeyProvider = "anthropic" | "openai";

const SECRET_KEYS: Record<ApiKeyProvider, string> = {
  anthropic: "pi-on-code.apiKey.anthropic",
  openai: "pi-on-code.apiKey.openai",
};

const LEGACY_SETTING_KEYS: Record<ApiKeyProvider, string> = {
  anthropic: "anthropicApiKey",
  openai: "openaiApiKey",
};

export function getProviderSecretKey(provider: ApiKeyProvider): string {
  return SECRET_KEYS[provider];
}

export async function readProviderApiKey(
  secrets: vscode.SecretStorage | undefined,
  configuration: vscode.WorkspaceConfiguration,
  provider: ApiKeyProvider,
  onMigrationError?: (error: unknown) => void,
): Promise<string | undefined> {
  const storedValue = (await secrets?.get(SECRET_KEYS[provider]))?.trim();
  if (storedValue) {
    try {
      await clearLegacySetting(configuration, LEGACY_SETTING_KEYS[provider]);
    } catch (error: unknown) {
      onMigrationError?.(error);
    }
    return storedValue;
  }

  // Migrate values written by releases before 0.2.0 from settings.json into
  // VS Code SecretStorage. Keep returning the value if migration cleanup fails
  // so an existing user is not unexpectedly logged out.
  const legacyKey = LEGACY_SETTING_KEYS[provider];
  const legacyValue = configuration.get<string>(legacyKey)?.trim();
  if (!legacyValue) { return undefined; }

  if (secrets) {
    try {
      await secrets.store(SECRET_KEYS[provider], legacyValue);
      await clearLegacySetting(configuration, legacyKey);
    } catch (error: unknown) {
      onMigrationError?.(error);
    }
  }
  return legacyValue;
}

export async function storeProviderApiKey(
  secrets: vscode.SecretStorage,
  provider: ApiKeyProvider,
  value: string,
): Promise<void> {
  const normalized = value.trim();
  if (!normalized) { throw new Error("API key cannot be empty."); }
  await secrets.store(SECRET_KEYS[provider], normalized);
}

export async function clearProviderApiKeys(
  secrets: vscode.SecretStorage,
  configuration: vscode.WorkspaceConfiguration,
): Promise<void> {
  await Promise.all(Object.values(SECRET_KEYS).map((key) => secrets.delete(key)));
  await Promise.all(Object.values(LEGACY_SETTING_KEYS).map((key) =>
    clearLegacySetting(configuration, key),
  ));
}

async function clearLegacySetting(
  configuration: vscode.WorkspaceConfiguration,
  key: string,
): Promise<void> {
  const inspected = configuration.inspect<string>(key);
  if (!inspected) { return; }

  const targets: Array<{ value: string | undefined; target: vscode.ConfigurationTarget }> = [
    { value: inspected.workspaceFolderValue, target: vscode.ConfigurationTarget.WorkspaceFolder },
    { value: inspected.workspaceValue, target: vscode.ConfigurationTarget.Workspace },
    { value: inspected.globalValue, target: vscode.ConfigurationTarget.Global },
  ];
  for (const { value, target } of targets) {
    if (value !== undefined) {
      await configuration.update(key, undefined, target);
    }
  }
}
