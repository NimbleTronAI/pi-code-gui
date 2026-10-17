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
  assert.match(withModel, /`deepseek\/deepseek-v4-pro`/);
  for (const runtime of ["rust", "typescript"] as const) {
    for (const m of [null, undefined]) {
      assert.doesNotMatch(buildRuntimeIdentityPrompt({ runtime, model: m }), /- Model/,
        "an unknown model must be absent, not blank or guessed");
    }
  }
});

// R1 (Unit 5 review §6, C25 option (a)): the block is fixed when it is built — at spawn for Rust,
// at the SDK loader's reload for TypeScript — so after a substitution or a /model switch it named
// a model the session was no longer on, under an "authoritative" header.
test("rust: the model line is the model REQUESTED AT LAUNCH and says the chat/status bar is current", () => {
  const p = buildRuntimeIdentityPrompt({ runtime: "rust", model: { provider: "prov-a", id: "model-x" } });
  assert.match(p, /- Model requested at launch: `prov-a\/model-x`/);
  assert.match(p, /may have switched since/);
  assert.match(p, /after a substitution or a `\/model` switch/);
  assert.match(p, /chat\/status bar is current/);
});

test("the 'authoritative' header covers runtime/backend facts only, not the model", () => {
  for (const runtime of ["rust", "typescript"] as const) {
    const p = buildRuntimeIdentityPrompt({ runtime, model: { provider: "prov-a", id: "model-x" } });
    assert.match(p, /^## Your runtime \(authoritative for the runtime and backend facts below/);
    assert.doesNotMatch(p, /authoritative — trust this over anything/, "the old blanket header must be gone");
    assert.match(p, /for the model, give the one named here and say it may have changed since/);
  }
});

test("typescript: the model line says when it was built and carries the same caveat", () => {
  const p = buildRuntimeIdentityPrompt({ runtime: "typescript", model: { provider: "prov-a", id: "model-x" } });
  assert.match(p, /- Model when this prompt was built: `prov-a\/model-x`/);
  assert.match(p, /may have switched since/);
  assert.match(p, /chat\/status bar is current/);
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
