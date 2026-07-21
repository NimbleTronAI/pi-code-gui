// Headless tests for the extracted event bus (src/event-bus.ts).
import { test } from "node:test";
import assert from "node:assert/strict";
import { EventBus, type ValidateFn } from "../../event-bus.js";
import type { PiServiceEvent } from "../../types.js";

type Any = ReturnType<typeof JSON.parse>;
const ok: ValidateFn = () => ({ success: true });
const ev = (type: string): PiServiceEvent => ({ type, data: {} } as Any);

function makeBus(validate: ValidateFn = ok): { bus: EventBus; warns: string[] } {
  const warns: string[] = [];
  return { bus: new EventBus(validate, (m) => warns.push(m)), warns };
}

test("subscribe / emit: listener receives the event; listenerCount tracks subscriptions", () => {
  const { bus } = makeBus();
  const got: string[] = [];
  assert.equal(bus.listenerCount, 0);
  const off = bus.subscribe((e) => got.push((e as Any).type));
  assert.equal(bus.listenerCount, 1);
  bus.emit(ev("a"));
  assert.deepEqual(got, ["a"]);
  off();
  assert.equal(bus.listenerCount, 0);
  bus.emit(ev("b")); // no listeners
  assert.deepEqual(got, ["a"]);
});

test("multiple listeners all receive; unsubscribe removes only that one", () => {
  const { bus } = makeBus();
  const a: string[] = []; const b: string[] = [];
  const offA = bus.subscribe((e) => a.push((e as Any).type));
  bus.subscribe((e) => b.push((e as Any).type));
  bus.emit(ev("x"));
  offA();
  bus.emit(ev("y"));
  assert.deepEqual(a, ["x"]);
  assert.deepEqual(b, ["x", "y"]);
});

test("a throwing listener is isolated — others still run, and it's logged", () => {
  const { bus, warns } = makeBus();
  const got: string[] = [];
  bus.subscribe(() => { throw new Error("boom"); });
  bus.subscribe((e) => got.push((e as Any).type));
  bus.emit(ev("z"));
  assert.deepEqual(got, ["z"]); // second listener unaffected
  assert.ok(warns.some((w) => w.includes("boom") && w.includes("emit")));
});

test("validation failure: logs, dispatches a diagnostic custom-message, then STILL emits the original", () => {
  const validate: ValidateFn = (e) => ((e as Any).type === "bad" ? { success: false, error: "nope" } : { success: true });
  const { bus, warns } = makeBus(validate);
  const seen: Any[] = [];
  bus.subscribe((e) => seen.push(e));
  bus.emit(ev("bad"));
  // The diagnostic is emitted first (via emitSafe), then the original event.
  assert.equal(seen.length, 2);
  assert.equal(seen[0].type, "custom-message");
  assert.equal(seen[0].data.customType, "pi-gui-diagnostic");
  assert.ok(String(seen[0].data.content).includes("nope"));
  assert.equal(seen[1].type, "bad");
  assert.ok(warns.some((w) => w.includes("protocol") && w.includes("validation failed")));
});

test("emitSafe skips validation entirely (no diagnostic even for an invalid event)", () => {
  const validate: ValidateFn = () => ({ success: false, error: "x" });
  const { bus } = makeBus(validate);
  const seen: Any[] = [];
  bus.subscribe((e) => seen.push(e));
  bus.emitSafe(ev("whatever"));
  assert.equal(seen.length, 1); // just the event, no diagnostic
  assert.equal(seen[0].type, "whatever");
});

// ── M1: the outbound gate is schema-derived, not a hand-maintained list ──
test("isExtensionToWebviewType is derived from the schema (no drifting literal list)", async () => {
  const { isExtensionToWebviewType } = await import("../../shared/protocol.js");
  // Extension→webview types validate…
  assert.equal(isExtensionToWebviewType("status-update"), true);
  assert.equal(isExtensionToWebviewType("chat-message"), true);
  // …webview→extension types are not this schema's business…
  assert.equal(isExtensionToWebviewType("prompt"), false);
  assert.equal(isExtensionToWebviewType("openFile"), false);
  // …and unknown/garbage is not silently treated as validatable.
  assert.equal(isExtensionToWebviewType("totally-made-up"), false);
  assert.equal(isExtensionToWebviewType(undefined), false);
});
