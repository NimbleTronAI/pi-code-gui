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

test("seeds a REGULAR FILE when nothing is there (0.3.0 refuses a linked auth.json)", () => {
  const d = tmp();
  try {
    const src = join(d, "src.json"), dst = join(d, "dst.json");
    writeFileSync(src, AUTH);
    assert.equal(seedAuthFrom(src, dst), null, "no warning on the happy path");
    assert.ok(!lstatSync(dst).isSymbolicLink(), "never a symlink");
    assert.ok(lstatSync(dst).isFile(), "a real file rust-pi 0.3.0 will accept");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("an existing symlink is MIGRATED to a copy, not left alone", () => {
  const d = tmp();
  try {
    const src = join(d, "src.json"), dst = join(d, "dst.json");
    writeFileSync(src, AUTH);
    symlinkSync(src, dst);
    assert.equal(seedAuthFrom(src, dst), null);
    assert.ok(!lstatSync(dst).isSymbolicLink(), "the fatal link is gone");
    assert.ok(lstatSync(dst).isFile());
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

test("a copied destination is never turned back into a symlink", () => {
  const d = tmp();
  try {
    const src = join(d, "src.json"), dst = join(d, "dst.json");
    writeFileSync(src, AUTH);
    writeFileSync(dst, AUTH);                    // a plain file left by the copy fallback
    assert.ok(!lstatSync(dst).isSymbolicLink());
    assert.equal(seedAuthFrom(src, dst), null);
    // It used to be "upgraded" to a symlink here so it stopped going stale. That upgrade is now
    // the failure mode: rust-pi 0.3.0 refuses to start on a linked auth.json. Staleness is
    // handled by refreshing the copy when the source is newer (the test above), not by linking.
    assert.ok(!lstatSync(dst).isSymbolicLink(), "stays a regular file");
  } finally { rmSync(d, { recursive: true, force: true }); }
});

test("migrating a symlink does not write THROUGH it to the user's real auth.json", () => {
  // The trap in this migration: copyFileSync follows the link, so copying without unlinking
  // first would overwrite ~/.pi/agent/auth.json — the shared credential the pi CLI also uses —
  // and leave the fatal symlink in place. Unlink first, then copy.
  const dir = mkdtempSync(join(tmpdir(), "auth-migrate-"));
  try {
    const src = join(dir, "src.json");
    const dst = join(dir, "dst.json");
    writeFileSync(src, JSON.stringify({ token: "real" }));
    symlinkSync(src, dst);
    seedAuthFrom(src, dst);
    assert.ok(!lstatSync(dst).isSymbolicLink(), "link replaced");
    assert.equal(JSON.parse(readFileSync(src, "utf8")).token, "real", "source untouched");
    assert.equal(JSON.parse(readFileSync(dst, "utf8")).token, "real", "copy carries the credential");
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
