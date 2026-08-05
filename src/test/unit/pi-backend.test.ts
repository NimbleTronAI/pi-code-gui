// Tests for backendCapabilityDefaults — the single source of truth for capability flags that
// both backends and the PiService no-backend fallback derive from. Guards against the three
// copies drifting apart (they were hand-authored independently before; exportHtml had already
// been hand-corrected in the fallback, proving the drift risk).
import { test } from "node:test";
import assert from "node:assert/strict";
import { backendCapabilityDefaults, flipsStateEagerly, type BackendCapabilities } from "../../pi-backend.js";

const staticFlags = (c: BackendCapabilities) => ({
  kind: c.kind, bridgeTools: c.bridgeTools, customCards: c.customCards, toolsPicker: c.toolsPicker,
  fork: c.fork, reloadContext: c.reloadContext, exportHtml: c.exportHtml, rename: c.rename,
  interceptSlashCommands: c.interceptSlashCommands,
});

test("typescript defaults: everything on, thinking always live", () => {
  const c = backendCapabilityDefaults("typescript");
  assert.deepEqual(staticFlags(c), {
    kind: "typescript", bridgeTools: true, customCards: true, toolsPicker: true, fork: true,
    reloadContext: true, exportHtml: true, rename: true, interceptSlashCommands: true,
  });
  assert.equal(c.thinkingLevelLive(), true);
});

test("rust defaults: gated features off, exportHtml still on, thinking default off", () => {
  const c = backendCapabilityDefaults("rust");
  assert.deepEqual(staticFlags(c), {
    kind: "rust", bridgeTools: false, customCards: false, toolsPicker: false, fork: false,
    reloadContext: false, exportHtml: true, rename: false, interceptSlashCommands: false,
  });
  assert.equal(c.thinkingLevelLive(), false); // static default; RustService overrides per-model
});

test("exportHtml is the one flag true for BOTH runtimes (the drift the fallback had to hand-fix)", () => {
  assert.equal(backendCapabilityDefaults("typescript").exportHtml, true);
  assert.equal(backendCapabilityDefaults("rust").exportHtml, true);
});

test("every gated flag except exportHtml is exactly !rust", () => {
  const ts = backendCapabilityDefaults("typescript");
  const rs = backendCapabilityDefaults("rust");
  for (const k of ["bridgeTools", "customCards", "toolsPicker", "fork", "reloadContext", "rename", "interceptSlashCommands"] as const) {
    assert.equal(ts[k], true, `${k} on for TS`);
    assert.equal(rs[k], false, `${k} off for Rust`);
  }
});

// ── the one genuine state divergence ─────────────────────────────────
test("flipsStateEagerly: TS flips immediately, Rust waits for the wire echo", () => {
  assert.equal(flipsStateEagerly("typescript"), true, "SDK applies in-process — safe to flip now");
  assert.equal(flipsStateEagerly("rust"), false, "RPC may reject/clamp — flip only on the echo");
});
