#!/usr/bin/env node
// Opt-in smoke test against a REAL pi_agent_rust binary: spawns `<binary> --mode
// rpc` in a temp session dir, round-trips get_state, and asserts the RPC contract
// fields this extension depends on (the fake-server unit tests can't catch real
// protocol drift). Run with `pnpm run test:rust-smoke`; resolves the binary from
// PI_RUST_BIN, then ~/.local/bin/rust-pi — and SKIPS (exit 0) when neither exists,
// so CI without the binary stays green while a drifted binary fails loudly.
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const candidates = [process.env.PI_RUST_BIN, join(homedir(), ".local", "bin", "rust-pi")].filter(Boolean);
const bin = candidates.find((p) => existsSync(p));
if (!bin) {
  console.log(`SKIP: no rust-pi binary (checked: ${candidates.join(", ")}). Set PI_RUST_BIN to run.`);
  process.exit(0);
}

const tmp = mkdtempSync(join(tmpdir(), "rust-smoke-"));
const child = spawn(bin, ["--mode", "rpc", "--session-dir", tmp, "--no-extensions", "--no-skills", "--no-prompt-templates"], {
  cwd: tmp, stdio: ["pipe", "pipe", "pipe"],
});

let buf = "";
let done = false;
const fail = (msg) => { if (done) return; done = true; console.error(`FAIL: ${msg}`); cleanup(); process.exit(1); };
const pass = (msg) => { if (done) return; done = true; console.log(`OK: ${msg}`); cleanup(); process.exit(0); };
const cleanup = () => { try { child.kill("SIGTERM"); } catch { /* ignore */ } try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } };

const timer = setTimeout(() => fail("get_state did not answer within 15s"), 15000);
timer.unref();

child.on("error", (e) => fail(`spawn error: ${e.message}`));
child.on("exit", (code) => { if (!done) fail(`binary exited before answering (code ${code})`); });
child.stdout.setEncoding("utf8");
child.stdout.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === "response" && o.id === "smoke-1") {
      if (!o.success) return fail(`get_state success=false: ${JSON.stringify(o.error)}`);
      const d2 = o.data ?? {};
      // The contract fields the extension's applyState/status pipeline depends on.
      const model = d2.model ?? d2.activeModel;
      if (!model || typeof model !== "object") return fail(`get_state has no model object: ${JSON.stringify(d2).slice(0, 300)}`);
      if (typeof (d2.thinkingLevel ?? d2.thinking) !== "string") return fail(`get_state has no thinkingLevel: ${JSON.stringify(d2).slice(0, 300)}`);
      return pass(`get_state contract holds (model=${model.id ?? "?"}, thinkingLevel=${d2.thinkingLevel ?? d2.thinking}) — ${bin}`);
    }
  }
});
child.stdin.write(JSON.stringify({ type: "get_state", id: "smoke-1" }) + "\n");
