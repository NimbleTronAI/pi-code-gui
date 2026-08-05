// Tests for seeding auth.json into the RELOCATED Rust agent home, so an OAuth login done via
// /login actually reaches the Rust runtime.
//
// The bug this pins: the old code returned early whenever the destination merely EXISTED. On the
// copy fallback (symlinks unavailable) that copy was therefore never refreshed — a user would run
// /login, see it succeed, and Rust would keep using a stale credential forever.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync, lstatSync, readFileSync, symlinkSync, utimesSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { seedAuthFrom } from "../../rust-models.js";

const AUTH = JSON.stringify({ anthropic: { type: "oauth", token: "t1" } });

function tmp(): string { return mkdtempSync(join(tmpdir(), "authseed-")); }

test("seeds a SYMLINK when nothing is there (so future logins track automatically)", () => {
  const d = tmp();
  try {
    const src = join(d, "src.json"), dst = join(d, "dst.json");
    writeFileSync(src, AUTH);
    assert.equal(seedAuthFrom(src, dst), null, "no warning on the happy path");
    assert.ok(lstatSync(dst).isSymbolicLink(), "symlink preferred");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("an existing symlink is left alone", () => {
  const d = tmp();
  try {
    const src = join(d, "src.json"), dst = join(d, "dst.json");
    writeFileSync(src, AUTH);
    symlinkSync(src, dst);
    assert.equal(seedAuthFrom(src, dst), null);
    assert.ok(lstatSync(dst).isSymbolicLink());
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("a stale COPY is refreshed — the actual bug (a login after the copy now reaches Rust)", () => {
  const d = tmp();
  try {
    const src = join(d, "src.json"), dst = join(d, "dst.json");
    writeFileSync(src, AUTH);
    // Simulate the fallback state: a real file, not a symlink, holding OLD credentials.
    writeFileSync(dst, JSON.stringify({ anthropic: { type: "oauth", token: "STALE" } }));
    const old = new Date(Date.now() - 60_000);
    utimesSync(dst, old, old);
    // ...and the user has since run /login, so the source is newer.
    const now = new Date();
    utimesSync(src, now, now);

    assert.equal(seedAuthFrom(src, dst), null);
    const after = readFileSync(dst, "utf-8");
    assert.ok(!after.includes("STALE"), "stale credential replaced");
    assert.ok(after.includes("t1"), "new credential present");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("a missing/empty/corrupt source is not seeded, and a stale symlink to it is cleaned up", () => {
  const d = tmp();
  try {
    const src = join(d, "missing.json"), dst = join(d, "dst.json");
    symlinkSync(src, dst);                       // dangling link, as after the source was removed
    assert.equal(seedAuthFrom(src, dst), null);
    assert.equal(existsSync(dst), false, "dangling symlink removed (binary would mark it corrupt)");

    // An empty source is equally unusable.
    const empty = join(d, "empty.json");
    writeFileSync(empty, "");
    const dst2 = join(d, "dst2.json");
    assert.equal(seedAuthFrom(empty, dst2), null);
    assert.equal(existsSync(dst2), false);
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("a copied destination is UPGRADED to a symlink when symlinking becomes possible", () => {
  const d = tmp();
  try {
    const src = join(d, "src.json"), dst = join(d, "dst.json");
    writeFileSync(src, AUTH);
    writeFileSync(dst, AUTH);                    // a plain file left by the copy fallback
    assert.ok(!lstatSync(dst).isSymbolicLink());
    assert.equal(seedAuthFrom(src, dst), null);
    assert.ok(lstatSync(dst).isSymbolicLink(), "upgraded, so it stops going stale");
  } finally { rmSync(d, { recursive: true, force: true }); }
});
