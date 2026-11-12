// Headless tests for the runtime-error classifiers (extension-errors.ts).
// Inputs are the real strings observed in the Output log / chat, so these
// double as regression fixtures for the exact failures we set out to handle.

import { test } from "node:test";
import assert from "node:assert/strict";
import { classifyProviderConfigError, humanizeProviderError, explainAgentStop } from "../../extension-errors.js";

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

// ── terminal stop reasons ───────────────────────────────────────────
// A turn ending with stopReason "error" rendered as SILENCE: the webview handled only
// "aborted", so everything else fell through and the conversation stopped mid-thought. Seen
// live — a codebase review cut off as it was about to write its report, with the reason sitting
// unread in the transcript.

test("explainAgentStop: guidance never names a setting the extension no longer contributes", () => {
  // The tool-ceiling advice pointed at a setting that existed only for the retired runtime. Any
  // such stop now gets the generic treatment, with its own message intact.
  const out = explainAgentStop("error", "Maximum tool iterations (50) exceeded");
  assert.ok(out);
  assert.match(out, /Maximum tool iterations \(50\) exceeded/, "the message is surfaced as-is");
  assert.doesNotMatch(out, /pi-code-gui\.maxToolIterations/, "no advice to change a setting that is gone");
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
