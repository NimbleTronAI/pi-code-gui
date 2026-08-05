// Headless tests for the shared logger (logger.ts). It type-imports `vscode`
// only, so it loads without the VS Code runtime — we inject a fake
// LogOutputChannel and assert level routing, teardown-safety, and that NOTHING
// is ever written to the shared console.

import { test } from "node:test";
import assert from "node:assert/strict";
import { initLogger, disposeLogger, piDebug, piLog, piWarn } from "../../logger.js";

type Call = { level: string; msg: string };

/** A minimal LogOutputChannel stub recording which level each message hit. */
function fakeChannel(throwOn?: string) {
  const calls: Call[] = [];
  const mk = (level: string) => (msg: string) => {
    if (throwOn === level) { throw new Error("channel has been closed"); }
    calls.push({ level, msg });
  };
  const channel = {
    name: "Pi Code Gui",
    trace: mk("trace"), debug: mk("debug"), info: mk("info"),
    warn: mk("warn"), error: mk("error"),
    append: () => {}, appendLine: () => {}, replace: () => {},
    clear: () => {}, show: () => {}, hide: () => {}, dispose: () => {},
  };
  return { calls, channel: channel as unknown as Parameters<typeof initLogger>[0] };
}

test("routes each helper to its matching channel level", () => {
  const { calls, channel } = fakeChannel();
  initLogger(channel);
  piDebug("a"); piLog("b"); piWarn("c");
  assert.deepEqual(calls, [
    { level: "debug", msg: "a" },
    { level: "info", msg: "b" },
    { level: "warn", msg: "c" },
  ]);
  disposeLogger();
});

test("never writes to the shared console", () => {
  const { channel } = fakeChannel();
  initLogger(channel);
  const seen: string[] = [];
  const orig = { ...console } as Record<string, unknown>;
  for (const m of ["debug", "log", "info", "warn", "error"] as const) {
    (console as unknown as Record<string, unknown>)[m] = (...a: unknown[]) => seen.push(`${m}:${String(a[0])}`);
  }
  try {
    piDebug("x"); piLog("y"); piWarn("z");
  } finally {
    for (const m of ["debug", "log", "info", "warn", "error"] as const) {
      (console as unknown as Record<string, unknown>)[m] = orig[m];
    }
  }
  assert.deepEqual(seen, [], "logger must not touch console.*");
  disposeLogger();
});

test("logs before initLogger are dropped silently (no throw)", () => {
  disposeLogger(); // ensure no channel is set
  assert.doesNotThrow(() => { piDebug("a"); piLog("b"); piWarn("c"); });
});

test("logs after disposeLogger are dropped silently (no throw)", () => {
  const { calls, channel } = fakeChannel();
  initLogger(channel);
  piLog("before");
  disposeLogger();
  assert.doesNotThrow(() => { piDebug("after"); piLog("after"); piWarn("after"); });
  assert.deepEqual(calls.map((c) => c.msg), ["before"], "no writes after dispose");
});

test("a throwing channel never propagates and latches off", () => {
  const { calls, channel } = fakeChannel("info");
  initLogger(channel);
  assert.doesNotThrow(() => piLog("boom")); // info throws inside the channel
  // After a channel error the logger disowns the channel — later calls are no-ops.
  piWarn("later");
  assert.deepEqual(calls, [], "channel disowned after it threw");
  disposeLogger();
});
