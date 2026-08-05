// The identity block both backends inject into their system prompt.
//
// Cover for a real failure: two review agents were asked which runtime they were on. One
// inspected `ps`, found a `rust-pi` process belonging to a DIFFERENT session open in the same
// workspace, and reported itself as the Rust backend while actually running the in-process
// TypeScript SDK — invalidating every claim it framed as "first-hand evidence from my own
// runtime". A session genuinely cannot tell from the inside: workspace, session dir and process
// table are identical across backends. So we state it, from one shared builder, on both paths.
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildRuntimeIdentityPrompt } from "../../runtime-identity.js";

test("names the backend unambiguously and differently per runtime", () => {
  const rust = buildRuntimeIdentityPrompt({ runtime: "rust" });
  const ts = buildRuntimeIdentityPrompt({ runtime: "typescript" });
  assert.match(rust, /Backend: \*\*Rust\*\*/);
  assert.match(rust, /pi --mode rpc/);
  assert.match(ts, /Backend: \*\*TypeScript\*\*/);
  assert.match(ts, /in-process/);
  assert.notEqual(rust, ts, "the two runtimes must not produce identical text");
});

test("carries the runtime id verbatim, so an agent can quote it without paraphrasing", () => {
  assert.match(buildRuntimeIdentityPrompt({ runtime: "rust" }), /Runtime id: `rust`/);
  assert.match(buildRuntimeIdentityPrompt({ runtime: "typescript" }), /Runtime id: `typescript`/);
});

test("includes the model when known, and OMITS it rather than guessing when not", () => {
  const withModel = buildRuntimeIdentityPrompt({ runtime: "rust", model: { provider: "deepseek", id: "deepseek-v4-pro" } });
  assert.match(withModel, /Model: `deepseek\/deepseek-v4-pro`/);
  for (const m of [null, undefined]) {
    assert.doesNotMatch(buildRuntimeIdentityPrompt({ runtime: "rust", model: m }), /Model:/,
      "an unknown model must be absent, not blank or guessed");
  }
});

test("explicitly forbids the inference that caused the misreport", () => {
  // The specific failure mode: another backend's session running concurrently in the same
  // workspace looks exactly like yours from the process table.
  const p = buildRuntimeIdentityPrompt({ runtime: "typescript" });
  assert.match(p, /Do NOT infer/);
  assert.match(p, /`ps`/, "must name the exact source that misled the reviewer");
  assert.match(p, /Another session running the OTHER backend/);
  assert.match(p, /say you cannot determine it/, "must prescribe abstaining over inferring");
});

test("backend version appears only when supplied", () => {
  assert.match(buildRuntimeIdentityPrompt({ runtime: "rust", backendVersion: "0.1.23" }), /Backend version: `0\.1\.23`/);
  assert.doesNotMatch(buildRuntimeIdentityPrompt({ runtime: "rust" }), /Backend version/);
});
