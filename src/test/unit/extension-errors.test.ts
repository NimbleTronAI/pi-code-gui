// Headless tests for the runtime-error classifiers (extension-errors.ts).
// Inputs are the real strings observed in the Output log / chat, so these
// double as regression fixtures for the exact failures we set out to handle.

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyProviderConfigError, classifyRustLoadError, humanizeProviderError, formatRustLoadError, humanizeRustLoadError, explainAgentStop } from "../../extension-errors.js";

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
  // Remediation quotes what the binary itself recommends for this failure
  // ("Use `pi update npm:pi-web-access` …"), using the full source spec the package
  // manager expects rather than the bare name.
  assert.match(r.remediation ?? "", /pi update npm:pi-web-access/);
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
  assert.match(out, /pi update npm:pi-web-access/);
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

// ── digest/provenance mismatch: name the right package ──────────────
// Captured verbatim from rust-pi 0.3.0 stderr. The previous pattern required a trailing colon
// after the package, so on this line it backtracked into capturing the SOURCE SCHEME: the user
// was told Pi extension "npm" had failed and advised to run `pi remove npm` — not a package,
// and no help at all in finding the one that actually broke.
const PROVENANCE_LINE =
  "Warning: Failed to load skills/prompts/themes/extensions: Tool error: package_manager: " +
  "Package lock/provenance verification failed [provenance_mismatch]: resolved provenance " +
  "changed for npm:pi-web-access while source is immutable in this operation";

test("classifyRustLoadError: names the package, not its source scheme", () => {
  const e = classifyRustLoadError(PROVENANCE_LINE);
  assert.ok(e);
  assert.equal(e.kind, "digest-mismatch");
  assert.equal(e.packageName, "pi-web-access", "the scheme prefix is not the package");
  assert.ok(!/\bnpm\b/.test(e.packageName ?? ""), "must never surface as \"npm\"");
});

test("classifyRustLoadError: remediation uses the full source spec", () => {
  // The package manager wants the spec, not the bare name.
  const e = classifyRustLoadError(PROVENANCE_LINE);
  assert.ok((e?.remediation ?? "").includes("npm:pi-web-access"));
});

test("classifyRustLoadError: still works when the package has no scheme or is scoped", () => {
  const bare = classifyRustLoadError("provenance verification failed: changed for pi-memory while immutable");
  assert.equal(bare?.packageName, "pi-memory");
  const scoped = classifyRustLoadError("digest_mismatch for npm:@acme/pi-thing while source is immutable");
  assert.equal(scoped?.packageName, "@acme/pi-thing");
});

// ── terminal stop reasons ───────────────────────────────────────────
// A turn ending with stopReason "error" rendered as SILENCE: the webview handled only
// "aborted", so everything else fell through and the conversation stopped mid-thought. Seen
// live — a codebase review cut off as it was about to write its report, with the reason sitting
// unread in the transcript.

test("explainAgentStop: the tool ceiling names the setting that raises it", () => {
  const out = explainAgentStop("error", "Maximum tool iterations (50) exceeded");
  assert.ok(out);
  assert.match(out, /50 tool calls/, "says what happened");
  assert.match(out, /cut off mid-task/, "says the work is unfinished, not merely stopped");
  assert.match(out, /pi-code-gui\.maxToolIterations/, "names the lever the user owns");
});

test("explainAgentStop: an unrecognised error still surfaces its message", () => {
  const out = explainAgentStop("error", "provider stream closed unexpectedly");
  assert.ok(out);
  assert.match(out, /provider stream closed unexpectedly/, "never swallowed");
});

test("explainAgentStop: an error with no message still says the turn ended early", () => {
  const out = explainAgentStop("error", undefined);
  assert.ok(out);
  assert.match(out, /ended early/);
});

test("explainAgentStop: ordinary completions produce nothing", () => {
  // So the caller can push the result unconditionally without gating on the reason.
  for (const r of ["stop", "end_turn", "tool_use", "end", undefined]) {
    assert.equal(explainAgentStop(r, undefined), null, String(r));
  }
});

test("explainAgentStop: an unknown reason WITH a message still surfaces", () => {
  // The safety net: rather than allowlisting benign reasons (which is how the original silence
  // happened), any reason carrying an error message is treated as a failure.
  const out = explainAgentStop("something_new", "the wheels came off");
  assert.ok(out);
  assert.match(out, /the wheels came off/);
});

test("explainAgentStop: abort keeps its own wording", () => {
  assert.equal(explainAgentStop("aborted", "Operation aborted"), "Operation aborted");
});
