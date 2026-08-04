// Headless unit tests for the RPC transport (RustProcess). Drives a real Node
// subprocess acting as a fake rust-pi RPC server, so framing/correlation/exit
// behaviour is exercised end-to-end without the binary. Run via `pnpm run test:unit`.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RustProcess, type RustEvent } from "../../rust-process.js";

// A minimal line-delimited JSON-RPC server: `\\n` in this template becomes the
// two-char escape "\n" in the written source (so the server emits real newlines).
const FAKE_SRC = `
let buf = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => {
  buf += d;
  let i;
  while ((i = buf.indexOf("\\n")) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let o; try { o = JSON.parse(line); } catch { continue; }
    if (o.type === "ping") process.stdout.write(JSON.stringify({ type: "response", id: o.id, command: "ping", success: true, data: { pong: true } }) + "\\n");
    else if (o.type === "emit2") process.stdout.write(JSON.stringify({ type: "evA" }) + "\\n" + JSON.stringify({ type: "evB" }) + "\\n");
    else if (o.type === "garbage") process.stdout.write("this is not json\\n" + JSON.stringify({ type: "evC" }) + "\\n");
    else if (o.type === "bye") process.exit(3);
    else if (o.type === "crash") { process.stderr.write("panic: something exploded\\n"); setTimeout(() => process.exit(9), 30); }
  }
});
setInterval(() => {}, 60000);
`;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Reproduces the real startup failure whose diagnosis was being thrown away: the binary writes
// an explanatory error to stderr and exits non-zero straight away. Node fires "exit" before
// stdio has necessarily drained, so reading the stderr tail at that moment raced the very
// message that explains the exit. Live example: an expired OAuth token exited 1 having printed
// "OAuth token expired or invalid / Run 'pi login <provider>'", and the user was shown a bare
// "Rust process exited immediately (code 1)".
const FAILING_SRC = `
process.stderr.write("Error: Authentication error: OAuth token refresh failed for: anthropic\\n");
process.stderr.write("OAuth token expired or invalid\\n");
process.exit(1);
`;

let tmp: string;
let fakeBin: string;
let failingBin: string;
before(() => {
  tmp = mkdtempSync(join(tmpdir(), "rpc-test-"));
  fakeBin = join(tmp, "fake.mjs");
  writeFileSync(fakeBin, FAKE_SRC);
  failingBin = join(tmp, "failing.mjs");
  writeFileSync(failingBin, FAILING_SRC);
});
after(() => { try { rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ } });

interface FakeOpts { readyCommand?: string; readyTimeoutMs?: number; binaryPath?: string; args?: string[] }
function spawnFake(extra: FakeOpts = {}) {
  const events: RustEvent[] = [];
  let exitCode: number | null | undefined = undefined;
  const rp = new RustProcess({
    binaryPath: extra.binaryPath ?? process.execPath,
    args: extra.args ?? [fakeBin],
    cwd: tmp,
    onEvent: (e) => events.push(e),
    onExit: (c) => { exitCode = c; },
    ...(extra.readyCommand ? { readyCommand: extra.readyCommand } : {}),
    ...(extra.readyTimeoutMs ? { readyTimeoutMs: extra.readyTimeoutMs } : {}),
  });
  return { rp, events, getExit: () => exitCode };
}

test("isAlive after spawn; request/response correlates by id", async () => {
  const { rp } = spawnFake();
  await rp.spawn();
  assert.equal(rp.isAlive(), true);
  const r = await rp.request("ping", {}, 3000);
  assert.equal(r.success, true);
  assert.deepEqual(r.data, { pong: true });
  rp.dispose();
  assert.equal(rp.isAlive(), false);
});

test("framing: two JSON objects in one write dispatch as two events", async () => {
  const { rp, events } = spawnFake();
  await rp.spawn();
  rp.send("emit2");
  await delay(200);
  const types = events.map((e) => e.type);
  assert.ok(types.includes("evA"), "evA dispatched");
  assert.ok(types.includes("evB"), "evB dispatched");
  rp.dispose();
});

test("a non-JSON stdout line is ignored; a later valid line still dispatches", async () => {
  const { rp, events } = spawnFake();
  await rp.spawn();
  rp.send("garbage");
  await delay(200);
  assert.ok(events.some((e) => e.type === "evC"));
  rp.dispose();
});

test("request rejects on timeout when no response arrives", async () => {
  const { rp } = spawnFake();
  await rp.spawn();
  await assert.rejects(() => rp.request("slow", {}, 150), /timed out/);
  rp.dispose();
});

test("a pending request rejects when the process exits", async () => {
  const { rp } = spawnFake();
  await rp.spawn();
  const pending = rp.request("never", {}, 5000);
  rp.send("bye"); // server process.exit(3)
  await assert.rejects(() => pending, /exited/);
  rp.dispose();
});

test("onExit fires with the code on an unexpected exit; isAlive flips false", async () => {
  const { rp, getExit } = spawnFake();
  await rp.spawn();
  rp.send("bye");
  await delay(250);
  assert.equal(getExit(), 3);
  assert.equal(rp.isAlive(), false);
});

test("dispose() does NOT call onExit (intentional teardown is not a crash)", async () => {
  const { rp, getExit } = spawnFake();
  await rp.spawn();
  rp.dispose();
  await delay(250);
  assert.equal(getExit(), undefined);
  assert.equal(rp.isAlive(), false);
});

// ── F20: readiness signal ─────────────────────────────────────────────
test("spawn() with readyCommand resolves only on the first RPC response", async () => {
  const { rp } = spawnFake({ readyCommand: "ping" });
  await rp.spawn(); // resolves because the fake answers "ping", not on a timer
  assert.equal(rp.isAlive(), true);
  rp.dispose();
});

test("spawn() rejects on readiness timeout when readyCommand is never answered", async () => {
  const { rp } = spawnFake({ readyCommand: "slow", readyTimeoutMs: 200 });
  await assert.rejects(() => rp.spawn(), /timed out/);
  rp.dispose();
});

test("spawn() rejects when the process exits immediately", async () => {
  const { rp } = spawnFake({ binaryPath: process.execPath, args: ["-e", "process.exit(2)"] });
  await assert.rejects(() => rp.spawn(), /exited immediately/);
});

test("a pending request rejected by a crash carries the binary's stderr", async () => {
  // onStderr drains stderrBuf line-by-line, so a retained tail is what makes this possible;
  // without it a mid-session crash rejected in-flight RPCs with a bare "exited (code N)".
  const { rp } = spawnFake();
  await rp.spawn();
  await assert.rejects(
    rp.request("crash", {}, 5000),
    (e: Error) => {
      assert.match(e.message, /Rust process exited/, "still says what happened");
      assert.match(e.message, /last stderr/, "carries the stderr tail");
      assert.match(e.message, /panic: something exploded/, "includes the binary's own words");
      return true;
    },
  );
  rp.dispose();
});

test("an immediate non-zero exit carries the stderr that EXPLAINS it", async () => {
  const { rp } = spawnFake({ binaryPath: process.execPath, args: [failingBin] });
  await assert.rejects(
    () => rp.spawn(),
    (e: Error) => {
      assert.match(e.message, /exited immediately \(code 1\)/);
      // The point of the fix: without draining, this assertion fails and the user is left with
      // an exit code and nothing else.
      assert.match(e.message, /last stderr:/, "the failure must carry its stderr, not just a code");
      assert.match(e.message, /OAuth token expired or invalid/, "…and specifically the ACTIONABLE line");
      return true;
    },
  );
  rp.dispose();
});
