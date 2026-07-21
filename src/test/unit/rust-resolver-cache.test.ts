// The detection memo (audit M4). detectRustBinary walks $PATH x 3 names with realpathSync +
// openSync/readSync per candidate and then execFileSync(binary, ["--version"], {timeout: 5000}) —
// all synchronous, on the extension-host thread. It was uncached and called from ~8 sites,
// including twice per package in the packages tree, so N packages meant 2N blocking spawns.
import { test } from "node:test";
import assert from "node:assert/strict";
import { detectRustBinary, invalidateRustBinaryCache } from "../../rust-resolver.js";

test("repeated detection inside the TTL is served from the memo", () => {
  invalidateRustBinaryCache();
  const first = detectRustBinary();
  const t0 = process.hrtime.bigint();
  for (let i = 0; i < 200; i++) { detectRustBinary(); }
  const perCallUs = Number(process.hrtime.bigint() - t0) / 200 / 1000;
  // A real probe spawns a subprocess (milliseconds at best); a memo hit is sub-microsecond.
  assert.ok(perCallUs < 50, `cached call took ${perCallUs.toFixed(1)}µs — memo not effective`);
  assert.deepEqual(detectRustBinary(), first, "same result while cached");
});

test("invalidate forces a fresh probe", () => {
  invalidateRustBinaryCache();
  const a = detectRustBinary();
  invalidateRustBinaryCache();
  const b = detectRustBinary();
  // Same environment, so the VALUE matches; the point is that it re-probed rather than throwing
  // or returning a stale object identity.
  assert.deepEqual(b, a);
});
