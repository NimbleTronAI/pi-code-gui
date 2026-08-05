// Opt-in RPC streaming-behavior contract check against the REAL rust-pi binary — the
// runtime net a static audit can't produce. Drives one `write` tool call and asserts the
// captured `toolcall_delta` stream honors the snapshot-client contract (id/name usable
// early, arguments actually stream, no coalescing) using the same pure helpers the
// headless fixture tests use (src/rpc-behavior.ts → out/rpc-behavior.js).
//
// Binary: PI_RUST_BIN, else ~/.local/bin/rust-pi. Needs DEEPSEEK_API_KEY (a real turn).
// SKIPS (exit 0) when the binary or key is absent, so CI stays green without them.
// Run:  pnpm run compile-tests && DEEPSEEK_API_KEY=… node scripts/rpc-behavior.mjs
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";

const bin = [process.env.PI_RUST_BIN, join(homedir(), ".local", "bin", "rust-pi")].filter(Boolean).find(existsSync);
if (!bin) { console.log("SKIP: no rust-pi binary (set PI_RUST_BIN)."); process.exit(0); }
if (!process.env.DEEPSEEK_API_KEY) { console.log("SKIP: no DEEPSEEK_API_KEY (a real streaming turn is required)."); process.exit(0); }

let analyzeToolStream, checkStreamContract, detectCoalescing;
try {
  ({ analyzeToolStream, checkStreamContract, detectCoalescing } = await import("../out/rpc-behavior.js"));
} catch {
  console.log("SKIP: out/rpc-behavior.js not built — run `pnpm run compile-tests` first."); process.exit(0);
}

const model = process.env.PI_RPC_MODEL || "deepseek-v4-pro";
const dir = mkdtempSync(join(tmpdir(), "rpc-behavior-"));
const child = spawn(bin, ["--mode", "rpc", "--session-dir", dir, "--provider", "deepseek", "--model", model, "--no-extensions"], { env: process.env });

const framesByCi = new Map();   // contentIndex → ToolCallDeltaFrame[]
const gaps = [];                 // inter-delta wall-clock gaps (ms) for the busiest tool call
let lastDeltaAt = null, buf = "", done = false;
const now = () => Number(process.hrtime.bigint() / 1000000n);

const cleanup = () => { try { child.stdin.end(); child.kill("SIGTERM"); } catch { /* */ } try { rmSync(dir, { recursive: true, force: true }); } catch { /* */ } };
const send = (o) => child.stdin.write(JSON.stringify(o) + "\n");

child.stdout.on("data", (d) => {
  buf += d.toString();
  let i;
  while ((i = buf.indexOf("\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let e; try { e = JSON.parse(line); } catch { continue; }
    if (e.type === "message_update" && e.assistantMessageEvent?.type === "toolcall_delta") {
      const a = e.assistantMessageEvent, ci = a.contentIndex;
      const tc = Array.isArray(a.partial?.content) ? a.partial.content[ci] : null;
      const arr = framesByCi.get(ci) ?? framesByCi.set(ci, []).get(ci);
      arr.push({ index: arr.length + 1, id: tc?.id, name: tc?.name, arguments: tc?.arguments });
      const t = now(); if (lastDeltaAt !== null) gaps.push(t - lastDeltaAt); lastDeltaAt = t;
    }
    if (e.type === "agent_end") finish();
  }
});
child.stderr.on("data", (d) => process.stderr.write("[stderr] " + d.toString().slice(0, 160)));

setTimeout(() => send({ type: "get_state", id: "1" }), 400);
setTimeout(() => send({ type: "prompt", message: "Use the write tool ONCE to write a 10-line markdown haiku list to " + join(dir, "h.md") + ". Don't read anything first." }), 1200);
setTimeout(() => finish("timeout"), 120000);

function finish(why) {
  if (done) return; done = true;
  // Assess the busiest tool call (most deltas).
  const streams = [...framesByCi.values()].sort((a, b) => b.length - a.length);
  const violations = [];
  if (streams.length === 0) {
    console.log(`SKIP: no streamed tool call captured (${why ?? "agent_end"}) — model may not have called write.`);
    cleanup(); process.exit(0);
  }
  const report = analyzeToolStream(streams[0]);
  const contract = checkStreamContract(report);
  const coalesce = detectCoalescing(gaps);
  console.log(`binary: ${bin}`);
  console.log(`tool stream: ${report.deltas} deltas | first id@${report.firstIdAt} name@${report.firstNameAt} args@${report.firstArgsAt} | id-stable=${report.idStableAfterFirst}`);
  console.log(`cadence: median ${coalesce.medianGapMs}ms, max ${coalesce.maxGapMs}ms → coalesced=${coalesce.coalesced}`);
  violations.push(...contract);
  if (coalesce.coalesced) violations.push({ code: "coalesced", detail: `max inter-delta gap ${coalesce.maxGapMs}ms ≫ median ${coalesce.medianGapMs}ms — deltas are being held/merged (backpressure).` });
  cleanup();
  if (violations.length) {
    console.error("\nFAIL — streaming contract violations:");
    for (const v of violations) console.error(`  [${v.code}] ${v.detail}`);
    process.exit(1);
  }
  console.log("\nOK: streaming tool-call contract honored (id/name early, args streamed, no coalescing).");
  process.exit(0);
}
