import * as assert from "node:assert";
import { readFileSync } from "node:fs";

interface ExtensionManifest {
  name: string;
  displayName: string;
  publisher: string;
  version: string;
  extensionKind?: string[];
  capabilities?: {
    untrustedWorkspaces?: { supported?: boolean };
    virtualWorkspaces?: { supported?: boolean };
  };
  activationEvents?: string[];
  scripts?: Record<string, string>;
  contributes?: {
    commands?: Array<{ command: string }>;
    keybindings?: Array<{ command: string }>;
    configuration?: { properties?: Record<string, unknown> };
  };
}

const manifestPath = new URL("../../package.json", import.meta.url);
const ignorePath = new URL("../../.vscodeignore", import.meta.url);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as ExtensionManifest;

suite("Marketplace manifest", () => {
  test("uses release identity and version metadata", () => {
    assert.strictEqual(manifest.publisher, "auchan");
    assert.strictEqual(manifest.name, "pion-code");
    assert.strictEqual(manifest.displayName, "Pion Code");
    assert.strictEqual(manifest.version, "0.2.0");
  });

  test("requires a trusted filesystem workspace", () => {
    assert.deepStrictEqual(manifest.extensionKind, ["workspace"]);
    assert.strictEqual(manifest.capabilities?.untrustedWorkspaces?.supported, false);
    assert.strictEqual(manifest.capabilities?.virtualWorkspaces?.supported, false);
    assert.ok(manifest.activationEvents?.includes("onStartupFinished"));
  });

  test("does not publish plaintext API key settings or conflicting shortcuts", () => {
    const properties = manifest.contributes?.configuration?.properties ?? {};
    assert.ok(!("pi-on-code.anthropicApiKey" in properties));
    assert.ok(!("pi-on-code.openaiApiKey" in properties));
    assert.deepStrictEqual(
      manifest.contributes?.keybindings?.map(({ command }) => command),
      ["pi-on-code.codeAgent"],
    );
  });

  test("publishes credential and installation commands", () => {
    const commands = new Set(
      manifest.contributes?.commands?.map(({ command }) => command) ?? [],
    );
    assert.ok(commands.has("pi-on-code.installPi"));
    assert.ok(commands.has("pi-on-code.setAnthropicApiKey"));
    assert.ok(commands.has("pi-on-code.setOpenAIApiKey"));
    assert.ok(commands.has("pi-on-code.clearApiKeys"));
  });

  test("publishes the exact validated VSIX instead of rescanning dependencies", () => {
    assert.strictEqual(
      manifest.scripts?.publish,
      "bun run build && bun scripts/publish-vsix.mjs",
    );
  });

  test("excludes internal instructions and bundled library sources", () => {
    const ignore = readFileSync(ignorePath, "utf8");
    assert.match(ignore, /^AGENTS\.md$/m);
    assert.match(ignore, /^media\/marked\.min\.js$/m);
    assert.match(ignore, /^media\/lib\/\*\*$/m);
  });
});
