// Headless tests for the runtime-error classifiers (extension-errors.ts).
// Inputs are the real strings observed in the Output log / chat, so these
// double as regression fixtures for the exact failures we set out to handle.

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyProviderConfigError, classifyRustLoadError, humanizeProviderError, formatRustLoadError, humanizeRustLoadError } from "../../extension-errors.js";

test("provider key: the deepseek $ENV legacy-syntax failure", () => {
  const r = classifyProviderConfigError(
    'Failed to resolve API key for provider "deepseek" from environment variable: ENV',
  );
  assert.ok(r);
  assert.equal(r.provider, "deepseek");
  assert.deepEqual(r.envVars, ["ENV"]);
  assert.match(r.title, /deepseek/);
  // Tell-tale ENV var -> point at the obsolete $ENV:NAME syntax + the ${VAR} fix.
  assert.match(r.remediation, /\$ENV:NAME/);
  assert.match(r.remediation, /\$\{DEEPSEEK_API_KEY\}/);
});

test("provider key: plural env vars, non-legacy remediation", () => {
  const r = classifyProviderConfigError(
    'Failed to resolve API key for provider "openai" from environment variables: OPENAI_API_KEY, OPENAI_KEY',
  );
  assert.ok(r);
  assert.equal(r.provider, "openai");
  assert.deepEqual(r.envVars, ["OPENAI_API_KEY", "OPENAI_KEY"]);
  assert.match(r.detail, /are not set/);
  assert.match(r.remediation, /OPENAI_API_KEY or OPENAI_KEY/);
  assert.doesNotMatch(r.remediation, /\$ENV:NAME/);
});

test("provider key: unrelated messages return null", () => {
  assert.equal(classifyProviderConfigError(""), null);
  assert.equal(classifyProviderConfigError(null), null);
  assert.equal(classifyProviderConfigError("ECONNREFUSED 127.0.0.1:443"), null);
  // header resolution (no `provider "X"`) is not a provider-key error
  assert.equal(
    classifyProviderConfigError("Failed to resolve header X-Api from environment variable: FOO"),
    null,
  );
});

test("humanizeProviderError: composes title + detail + remediation, else null", () => {
  const out = humanizeProviderError('Failed to resolve API key for provider "deepseek" from environment variable: ENV');
  assert.ok(out);
  assert.match(out, /deepseek: API key could not be resolved/);
  assert.match(out, /not set/);
  assert.match(out, /\$\{DEEPSEEK_API_KEY\}/);
  assert.equal(humanizeProviderError("some unrelated error"), null);
});

test("rust load: digest mismatch extracts package + remediation", () => {
  const line =
    "Warning: Failed to load skills/prompts/themes/extensions: Tool error: package_manager: " +
    "Package lock/provenance verification failed [digest_mismatch]: digest changed for " +
    "npm:pi-web-access: expected 1be41cf, got ed06a4c";
  const r = classifyRustLoadError(line);
  assert.ok(r);
  assert.equal(r.kind, "digest-mismatch");
  assert.equal(r.packageName, "pi-web-access");
  assert.match(r.remediation ?? "", /pi remove pi-web-access/);
  assert.match(r.remediation ?? "", /pi install pi-web-access/);
});

test("rust load: unsupported module specifier extracts module + package", () => {
  const line =
    "Error: Extension error: Error resolving module 'node:dns/promises' from " +
    "'/home/node/.npm-global/lib/node_modules/pi-web-access/ssrf-protection.ts': " +
    "Unsupported module specifier: node:dns/promises";
  const r = classifyRustLoadError(line);
  assert.ok(r);
  assert.equal(r.kind, "unsupported-module");
  assert.equal(r.packageName, "pi-web-access");
  assert.match(r.detail, /node:dns\/promises/);
});

test("formatRustLoadError / humanizeRustLoadError: one-line user message", () => {
  const digestLine =
    "Warning: Failed to load extensions: [digest_mismatch]: digest changed for npm:pi-web-access: expected a, got b";
  const out = humanizeRustLoadError(digestLine);
  assert.ok(out);
  assert.match(out, /Pi extension "pi-web-access" failed to load \(digest-mismatch\)/);
  assert.match(out, /pi remove pi-web-access/);
  // direct format from a structured value (no package)
  assert.equal(
    formatRustLoadError({ kind: "load-failed", detail: "Failed to load themes: bad" }),
    "A Pi extension failed to load (load-failed): Failed to load themes: bad",
  );
  assert.equal(humanizeRustLoadError("ordinary stderr noise"), null);
});

test("rust load: generic load failure + non-load lines return null", () => {
  const generic = classifyRustLoadError("Warning: Failed to load extensions: something odd happened");
  assert.ok(generic);
  assert.equal(generic.kind, "load-failed");

  assert.equal(classifyRustLoadError(""), null);
  assert.equal(classifyRustLoadError("RustProcess: spawn /usr/bin/pi --mode rpc"), null);
});
