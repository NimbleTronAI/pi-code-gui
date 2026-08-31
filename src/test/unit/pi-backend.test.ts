// Tests for backendCapabilityDefaults — the single source of truth for capability flags that
// both backends and the PiService no-backend fallback derive from. Guards against the three
// copies drifting apart (they were hand-authored independently before; exportHtml had already
// been hand-corrected in the fallback, proving the drift risk).
import { test } from "node:test";
import assert from "node:assert/strict";
import { backendCapabilityDefaults, flipsStateEagerly, type BackendCapabilities } from "../../pi-backend.js";

const staticFlags = (c: BackendCapabilities) => ({
  kind: c.kind, toolsPicker: c.toolsPicker, fork: c.fork, reloadContext: c.reloadContext,
  exportHtml: c.exportHtml, sessionModes: c.sessionModes,
  interceptSlashCommands: c.interceptSlashCommands,
});

test("typescript defaults: everything on, thinking always live", () => {
  const c = backendCapabilityDefaults("typescript");
  assert.deepEqual(staticFlags(c), {
    kind: "typescript", toolsPicker: true, fork: true, reloadContext: true, exportHtml: true,
    sessionModes: false, interceptSlashCommands: true,
  });
  assert.equal(c.thinkingLevelLive(), true);
});

test("rust defaults: gated features off, exportHtml still on, thinking default off", () => {
  const c = backendCapabilityDefaults("rust");
  assert.deepEqual(staticFlags(c), {
    kind: "rust", toolsPicker: false, fork: false,
    reloadContext: false, exportHtml: true, sessionModes: true, interceptSlashCommands: false,
  });
  assert.equal(c.thinkingLevelLive(), false); // static default; RustService overrides per-model
});

test("exportHtml is the one flag true for BOTH runtimes (the drift the fallback had to hand-fix)", () => {
  assert.equal(backendCapabilityDefaults("typescript").exportHtml, true);
  assert.equal(backendCapabilityDefaults("rust").exportHtml, true);
});

test("every gated flag except exportHtml and sessionModes is exactly !rust", () => {
  const ts = backendCapabilityDefaults("typescript");
  const rs = backendCapabilityDefaults("rust");
  for (const k of ["toolsPicker", "fork", "reloadContext", "interceptSlashCommands"] as const) {
    assert.equal(ts[k], true, `${k} on for TS`);
    assert.equal(rs[k], false, `${k} off for Rust`);
  }
});

test("sessionModes is the one flag that is TRUE for Rust and false for TS", () => {
  // Plan mode and the approval posture are rust-pi's, not the in-process SDK's — the only
  // capability that runs the other way, so it is asserted rather than folded into the loop.
  assert.equal(backendCapabilityDefaults("rust").sessionModes, true);
  assert.equal(backendCapabilityDefaults("typescript").sessionModes, false);
});

test("no capability flag exists without a reader", () => {
  // bridgeTools, customCards and rename were carried for releases with ZERO read sites, and
  // `rename: false` was actively wrong — rust-pi 0.3.0 has set_session_name. A flag nothing
  // consults is not a capability, it is an unchecked claim.
  const flags = Object.keys(backendCapabilityDefaults("rust"));
  for (const dead of ["bridgeTools", "customCards", "rename"]) {
    assert.ok(!flags.includes(dead), `${dead} was removed; re-add it only with a read site`);
  }
});

// ── the one genuine state divergence ─────────────────────────────────
test("flipsStateEagerly: TS flips immediately, Rust waits for the wire echo", () => {
  assert.equal(flipsStateEagerly("typescript"), true, "SDK applies in-process — safe to flip now");
  assert.equal(flipsStateEagerly("rust"), false, "RPC may reject/clamp — flip only on the echo");
});
