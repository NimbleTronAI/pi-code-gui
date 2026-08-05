// Tests for secret redaction. The output channel persists to on-disk log files that users attach
// to bug reports, and the same strings reach the webview as error cards (init failures, and the
// Rust child's stderr tail attached to RPC rejections). Before this, nothing filtered them.
import { test } from "node:test";
import assert from "node:assert/strict";
import { redactSecrets, registerSecret, clearRegisteredSecrets } from "../../logger.js";

const REDACTED = "‹redacted›";

test("vendor key shapes are scrubbed", () => {
  clearRegisteredSecrets();
  assert.ok(!redactSecrets("key sk-ant-api03-AbCdEf0123456789xyz here").includes("AbCdEf0123456789"));
  assert.ok(!redactSecrets("using sk-proj-0123456789abcdefghij now").includes("0123456789abcdefghij"));
  assert.ok(!redactSecrets("token ghp_0123456789abcdefghijABCDEF").includes("0123456789abcdefghij"));
});

test("authorization headers are scrubbed", () => {
  clearRegisteredSecrets();
  const out = redactSecrets("Authorization: Bearer eyJhbGciOi.J9payload.sig");
  assert.ok(!out.includes("eyJhbGciOi"), out);
  assert.ok(out.includes(REDACTED));
});

test("key=value / \"api_key\": \"...\" pairs are scrubbed", () => {
  clearRegisteredSecrets();
  assert.ok(!redactSecrets('{"api_key": "abcdefghijklmnop123"}').includes("abcdefghijklmnop123"));
  assert.ok(!redactSecrets("access_token=abcdefghijklmnop123").includes("abcdefghijklmnop123"));
});

test("a REGISTERED custom key is scrubbed even though it matches no vendor prefix", () => {
  clearRegisteredSecrets();
  const custom = "my-self-hosted-gateway-token-9931";
  assert.ok(redactSecrets(`failed with ${custom}`).includes(custom), "not scrubbed before registering");
  registerSecret(custom);
  const out = redactSecrets(`provider rejected key ${custom} (401)`);
  assert.ok(!out.includes(custom), "scrubbed once registered");
  assert.ok(out.includes(REDACTED));
  clearRegisteredSecrets();
});

test("registration ignores empty/short values so ordinary text isn't mangled", () => {
  clearRegisteredSecrets();
  registerSecret("");
  registerSecret(undefined);
  registerSecret("short");           // < 8 chars — would otherwise shred normal prose
  assert.equal(redactSecrets("a short message"), "a short message");
});

test("ordinary log lines pass through untouched", () => {
  clearRegisteredSecrets();
  const line = "RustProcess: spawn /home/node/.local/bin/rust-pi --mode rpc --model deepseek-v4-pro";
  assert.equal(redactSecrets(line), line);
  assert.equal(redactSecrets(""), "");
});

test("the sk-ant- rule wins over the generic sk- rule (no double-mangling)", () => {
  clearRegisteredSecrets();
  const out = redactSecrets("sk-ant-api03-ZZZZZZZZZZZZZZZZZZZZ");
  assert.ok(out.startsWith("sk-ant-"), out);
  assert.ok(!out.includes("ZZZZZZZZ"));
});
