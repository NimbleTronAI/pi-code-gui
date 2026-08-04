// Checksum verification for the managed Rust download (src/rust-install.ts).
//
// Cover for a real failure: v0.1.23 shipped 3 binaries on 2026-07-28, then added
// pi-linux-arm64 / pi-darwin-amd64 a week later with their hashes in a SEPARATE
// "SHA256SUMS.issue-146" file, leaving the original SHA256SUMS untouched. The installer read
// only the exactly-named asset, found no entry for the arm64 archive, and reported
// "Checksum verification failed" — indistinguishable from tampering, on a download that was
// in fact genuine. The fix concatenates every SHA256SUMS* asset before verifying, so these
// tests pin the behaviour against a combined manifest.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { verifyChecksum } from "../../rust-install.js";

function fixture(): { dir: string; archive: string; hash: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "sums-"));
  const archive = join(dir, "pi-linux-arm64.tar.xz");
  const body = "not really a tarball, but it hashes the same way";
  writeFileSync(archive, body);
  const hash = createHash("sha256").update(body).digest("hex");
  return { dir, archive, hash, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("verifies against an entry in the primary manifest", () => {
  const f = fixture();
  try {
    const sums = join(f.dir, "SHA256SUMS");
    writeFileSync(sums, `${f.hash}  pi-linux-arm64.tar.xz\n`);
    assert.equal(verifyChecksum(f.archive, "pi-linux-arm64.tar.xz", sums), true);
  } finally { f.cleanup(); }
});

test("verifies when the entry lives in a CONCATENATED second manifest (the v0.1.23 case)", () => {
  const f = fixture();
  try {
    // Exactly the shape the installer now builds: the original SHA256SUMS (which omits arm64)
    // joined with SHA256SUMS.issue-146 (which carries it).
    const primary = [
      "386db195fe662ed524366b56e590b45449f02d9187585217193d763822a19afb  pi-linux-amd64.tar.xz",
      "df23bdf23ad5f2099ae27135f30e9ec8e2df2de1414b1cec4f63baea8abf0a08  pi-windows-amd64.zip",
    ].join("\n");
    const secondary = `${f.hash}  pi-linux-arm64.tar.xz`;
    const sums = join(f.dir, "SHA256SUMS");
    writeFileSync(sums, primary + "\n" + secondary + "\n");
    assert.equal(verifyChecksum(f.archive, "pi-linux-arm64.tar.xz", sums), true);
  } finally { f.cleanup(); }
});

test("an absent entry is a hard FAIL, never a silent pass", () => {
  const f = fixture();
  try {
    const sums = join(f.dir, "SHA256SUMS");
    writeFileSync(sums, "deadbeef  some-other-file.tar.xz\n");
    assert.equal(verifyChecksum(f.archive, "pi-linux-arm64.tar.xz", sums), false);
  } finally { f.cleanup(); }
});

test("a wrong hash fails even when the name matches", () => {
  const f = fixture();
  try {
    const sums = join(f.dir, "SHA256SUMS");
    writeFileSync(sums, `${"0".repeat(64)}  pi-linux-arm64.tar.xz\n`);
    assert.equal(verifyChecksum(f.archive, "pi-linux-arm64.tar.xz", sums), false);
  } finally { f.cleanup(); }
});

test("the filename field matches EXACTLY — a sibling entry can't be borrowed", () => {
  const f = fixture();
  try {
    // Only "<name>.sig" is listed. A substring match would verify the archive against the
    // signature file's hash and wrongly pass.
    const sums = join(f.dir, "SHA256SUMS");
    writeFileSync(sums, `${f.hash}  pi-linux-arm64.tar.xz.sig\n`);
    assert.equal(verifyChecksum(f.archive, "pi-linux-arm64.tar.xz", sums), false);
  } finally { f.cleanup(); }
});

test("binary-mode entries (leading '*') still match", () => {
  const f = fixture();
  try {
    const sums = join(f.dir, "SHA256SUMS");
    writeFileSync(sums, `${f.hash} *pi-linux-arm64.tar.xz\n`);
    assert.equal(verifyChecksum(f.archive, "pi-linux-arm64.tar.xz", sums), true);
  } finally { f.cleanup(); }
});
