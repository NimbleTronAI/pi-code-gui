// API-key storage.
//
// The keys used to live ONLY in `pi-code-gui.anthropicApiKey` / `openaiApiKey`, i.e. plaintext
// settings.json — carried by Settings Sync, and (before the scopes were fixed) writable into a
// workspace .vscode/settings.json and committable. VS Code's SecretStorage is the correct home:
// OS keychain-backed, never synced, never in a settings file.
//
// Migration is one-way and automatic: any value found in settings is copied into SecretStorage
// and then CLEARED from settings, so an existing user is fixed on next activation without being
// asked to re-enter anything.
//
// SecretStorage is async but the config seam (SdkDeps/RustDeps `config()`) is synchronous, so
// the keys are loaded into memory once at activation and served synchronously afterwards. They
// are registered with the logger so they are scrubbed from log/UI output regardless of origin.
import type * as vscode from "vscode";
import { piDebug, piWarn, registerSecret } from "./logger.js";

/** The settings ids that used to hold the keys, paired with their SecretStorage keys. */
const KEYS = [
  { setting: "anthropicApiKey", secret: "pi-code-gui.anthropicApiKey" },
  { setting: "openaiApiKey", secret: "pi-code-gui.openaiApiKey" },
] as const;

export type ApiKeyName = (typeof KEYS)[number]["setting"];

let _cache: Partial<Record<ApiKeyName, string>> = {};
let _store: vscode.SecretStorage | null = null;

/**
 * Load keys from SecretStorage, migrating any that still live in settings. Call once from
 * activate(). Never throws: a keychain that is unavailable (some remote/CI containers) degrades
 * to "no stored key", which is the same as not having configured one.
 */
export async function initSecrets(
  store: vscode.SecretStorage,
  getConfigValue: (setting: ApiKeyName) => string | undefined,
  clearConfigValue: (setting: ApiKeyName) => Promise<void>,
): Promise<void> {
  _store = store;
  _cache = {};
  for (const { setting, secret } of KEYS) {
    let value: string | undefined;
    try {
      value = (await store.get(secret)) ?? undefined;
    } catch (e: unknown) {
      piWarn(`SecretStorage unavailable for ${setting}: ${e instanceof Error ? e.message : String(e)}`);
    }

    const fromSettings = getConfigValue(setting)?.trim();
    if (!value && fromSettings) {
      // One-way migration: store it, then remove the plaintext copy.
      try {
        await store.store(secret, fromSettings);
        await clearConfigValue(setting);
        value = fromSettings;
        piDebug(`Migrated ${setting} from settings.json into SecretStorage`);
      } catch (e: unknown) {
        piWarn(`Could not migrate ${setting} to SecretStorage (leaving the setting in place): ${e instanceof Error ? e.message : String(e)}`);
        value = fromSettings;
      }
    } else if (value && fromSettings) {
      // Both present (e.g. a synced settings value arriving after migration): SecretStorage wins,
      // and the plaintext copy is cleared so it can't linger.
      try { await clearConfigValue(setting); } catch { /* best effort — the key still works */ }
    }

    if (value) {
      _cache[setting] = value;
      registerSecret(value); // scrub it from logs / webview error text
    }
  }
}

/** The stored key, or undefined. Synchronous by design — see the module header. */
export function getApiKey(name: ApiKeyName): string | undefined {
  return _cache[name];
}

/** Store (or clear, with an empty value) a key at runtime and refresh the cache. */
export async function setApiKey(name: ApiKeyName, value: string | undefined): Promise<void> {
  const entry = KEYS.find((k) => k.setting === name);
  if (!entry || !_store) { return; }
  const trimmed = value?.trim();
  if (trimmed) {
    await _store.store(entry.secret, trimmed);
    _cache[name] = trimmed;
    registerSecret(trimmed);
  } else {
    await _store.delete(entry.secret);
    delete _cache[name];
  }
}

/** Test seam: reset module state between cases. */
export function __resetSecretsForTest(): void { _cache = {}; _store = null; }
