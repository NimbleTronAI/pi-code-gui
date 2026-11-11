// The resolver finds the extension-managed Rust install itself (batch 0.2.8, Unit 4).
//
// The managed install used to record its binary by WRITING AN ABSOLUTE PATH into the
// machine-scoped `pi-code-gui.rustBinaryPath` setting, because the resolver never looked in the
// extension's own storage folder. That value leaked to other machines (a Mac profile's
// `/Users/…/globalStorage/nimbletron.pi-code-gui/rust-pi/pi` applied inside a Linux container), so
// every Rust session warned "could not be used (the file does not exist …)" and then fell back
// correctly anyway. These tests pin the fix:
//   - the managed binary is a candidate of its own, with no setting;
//   - a missing value of exactly the shape our managed install writes is skipped QUIETLY;
//   - a user-typed missing path still warns;
//   - the managed install no longer writes the setting.
//
// Every fake binary is a DISTINCT COPY of a small native executable (/bin/echo answers
// `--version`). Symlinks to one file would dedupe by realpath and make an ordering test pass
// whatever the order.
import { test, before, after, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  detectRustBinary, invalidateRustBinaryCache, setManagedRustDir, isStaleManagedPath, removeManagedRustBinary,
} from "../../rust-resolver.js";
import { finishManagedInstall, detectAndRefresh, afterCurlInstall } from "../../rust-install.js";
import { cachedRuntimes, detectRuntimes } from "../../runtime-detection.js";
import { RustService, type RustDeps, type RustHost } from "../../rust-service.js";
import type { RustProcess, RustProcessOpts } from "../../rust-process.js";

type Mock = { config: Record<string, unknown>; calls: Array<{ kind: string; [k: string]: unknown }>; messageChoice: unknown[] };
const mock = (globalThis as unknown as { __vscodeMock: Mock }).__vscodeMock;

const NATIVE = "/bin/echo";
/** A native executable whose `--version` FAILS (exit 1): detection must skip it. */
const BROKEN = "/bin/false";
const KEY = "pi-code-gui.rustBinaryPath";
const MAC_VALUE = "/Users/jacknoppe/Library/Application Support/Code/User/globalStorage/nimbletron.pi-code-gui/rust-pi/pi";

let tmp: string;
let managedDir: string;   // <tmp>/globalStorage/nimbletron.pi-code-gui/rust-pi
let managedBin: string;
let pathDir: string;
let homeDir: string;
const saved: Record<string, string | undefined> = {};

function plant(file: string, from = NATIVE): string {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.copyFileSync(from, file);
  fs.chmodSync(file, 0o755);
  return fs.realpathSync(file);
}

before(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rust-managed-"));
  managedDir = path.join(tmp, "globalStorage", "nimbletron.pi-code-gui", "rust-pi");
  managedBin = path.join(managedDir, "pi");
  pathDir = path.join(tmp, "pathbin");
  homeDir = path.join(tmp, "home");
  fs.mkdirSync(pathDir, { recursive: true });
  fs.mkdirSync(homeDir, { recursive: true });
  for (const k of ["HOME", "PATH", "PI_BINARY_PATH"]) { saved[k] = process.env[k]; }
});
after(() => {
  for (const [k, v] of Object.entries(saved)) { if (v === undefined) { delete process.env[k]; } else { process.env[k] = v; } }
  setManagedRustDir(null);
  invalidateRustBinaryCache();
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
});

// Hermetic per test: no real ~/.local/bin/rust-pi, no real PATH, no env override, no setting.
beforeEach(() => {
  process.env.HOME = homeDir;
  process.env.PATH = pathDir;
  delete process.env.PI_BINARY_PATH;
  delete mock.config[KEY];
  mock.calls.length = 0;
  mock.messageChoice.length = 0;
  fs.rmSync(managedDir, { recursive: true, force: true });
  fs.rmSync(pathDir, { recursive: true, force: true }); fs.mkdirSync(pathDir, { recursive: true });
  fs.rmSync(homeDir, { recursive: true, force: true }); fs.mkdirSync(homeDir, { recursive: true });
  setManagedRustDir(managedDir);
});
afterEach(() => { delete mock.config[KEY]; invalidateRustBinaryCache(); });

test("managed binary is found with no rustBinaryPath setting", () => {
  const want = plant(managedBin);
  const s = detectRustBinary();
  assert.equal(s.installed, true);
  assert.equal(s.binaryPath, want);
  assert.equal(s.configuredPathError, undefined);
});

test("managed binary outranks a rust-pi on PATH and in ~/.local/bin", () => {
  const want = plant(managedBin);
  plant(path.join(pathDir, "rust-pi"));
  plant(path.join(homeDir, ".local", "bin", "rust-pi"));
  assert.equal(detectRustBinary().binaryPath, want);
});

test("PI_BINARY_PATH (an explicit choice) outranks the managed binary; the setting outranks both", () => {
  plant(managedBin);
  const env = plant(path.join(tmp, "envbin", "pi"));
  process.env.PI_BINARY_PATH = env;
  assert.equal(detectRustBinary().binaryPath, env);
  const typed = plant(path.join(tmp, "typed", "pi"));
  mock.config[KEY] = typed;
  invalidateRustBinaryCache();
  assert.equal(detectRustBinary().binaryPath, typed);
});

test("setManagedRustDir invalidates a memo taken before it", () => {
  setManagedRustDir(null);
  const want = plant(managedBin);
  // Compare paths, not `installed`: a machine with a native pi in /usr/local/bin finds THAT.
  assert.notEqual(detectRustBinary().binaryPath, want, "no managed dir known yet");
  setManagedRustDir(managedDir);
  assert.equal(detectRustBinary().binaryPath, want, "the setter dropped the stale memo");
});

test("isStaleManagedPath: only a missing value of our managed-install shape", () => {
  const here = "/home/node/.vscode-server/data/User/globalStorage/nimbletron.pi-code-gui/rust-pi";
  // Another machine's managed install — posix and Windows layouts.
  assert.equal(isStaleManagedPath(MAC_VALUE, here), true);
  assert.equal(isStaleManagedPath("C:\\Users\\J\\AppData\\Roaming\\Code\\User\\globalStorage\\nimbletron.pi-code-gui\\rust-pi\\pi.exe", here), true);
  assert.equal(isStaleManagedPath("/x/globalStorage/NimbleTron.Pi-Code-Gui/rust-pi/pi", here), true, "case-insensitive folder");
  // This machine's own managed path, gone missing — also written by us.
  assert.equal(isStaleManagedPath(path.join(managedDir, "pi"), managedDir), true);
  // Not ours: user-typed, another extension's storage, wrong leaf, wrong layout.
  assert.equal(isStaleManagedPath("/opt/mine/pi", here), false);
  assert.equal(isStaleManagedPath("/x/globalStorage/other.ext/rust-pi/pi", here), false);
  assert.equal(isStaleManagedPath("/x/globalStorage/nimbletron.pi-code-gui/rust-pi/rust-pi", here), false);
  assert.equal(isStaleManagedPath("/x/nimbletron.pi-code-gui/rust-pi/pi", here), false);
  // An EXISTING path is never stale — it is a real binary on this machine.
  const real = plant(path.join(tmp, "elsewhere", "globalStorage", "nimbletron.pi-code-gui", "rust-pi", "pi"));
  assert.equal(isStaleManagedPath(real, here), false);
  // No managed dir known → nothing is stale (conservative: warn).
  assert.equal(isStaleManagedPath(MAC_VALUE, null), false);
});

// S1 (review of record): the quiet skip is ONLY for (i) this machine's own managed binary gone
// missing, or (ii) a value whose `globalStorage` folder does not exist on this machine. A missing
// path into ANOTHER storage root that does exist here (an Insiders / VSCodium / Cursor profile, a
// mounted share) is something the user can act on — it must still warn.
test("S1 (i): this machine's own managed path, gone missing, is stale even though its globalStorage exists", () => {
  assert.ok(fs.existsSync(path.dirname(path.dirname(managedDir))), "precondition: our globalStorage folder exists");
  assert.equal(isStaleManagedPath(path.join(managedDir, "pi"), managedDir), true);
});

test("S1 (ii): a managed-shaped value whose globalStorage folder does not exist here is stale", () => {
  // Fabricated roots that cannot exist on the test host (the MAC_VALUE assertion above relies on
  // the same branch; these do not depend on whose machine runs the suite).
  assert.equal(isStaleManagedPath("/no-such-root-s1/Library/Application Support/Code/User/globalStorage/nimbletron.pi-code-gui/rust-pi/pi", managedDir), true);
  assert.equal(isStaleManagedPath("Q:\\no-such\\User\\globalStorage\\nimbletron.pi-code-gui\\rust-pi\\pi.exe", managedDir), true);
});

for (const [label, root] of [
  ["another VS Code variant's storage (Insiders / VSCodium / Cursor shape)", ["OtherVariant", "User"]],
  ["a mounted network share", ["mnt", "share", "profile"]],
] as const) {
  test(`S1 counter-case: a missing user path under ${label} whose globalStorage EXISTS still warns`, () => {
    plant(managedBin);
    const gs = path.join(tmp, ...root, "globalStorage");
    fs.mkdirSync(gs, { recursive: true });
    const typed = path.join(gs, "nimbletron.pi-code-gui", "rust-pi", "pi");
    assert.equal(isStaleManagedPath(typed, managedDir), false);
    mock.config[KEY] = typed;
    const s = detectRustBinary();
    assert.equal(s.installed, true, "detection still falls through to a working binary");
    assert.match(s.configuredPathError ?? "", /does not exist/);
  });
}

function hostStub(): RustHost {
  return {
    emit: () => {}, handleAgentEvent: () => {}, reportStatus: () => {}, sendInitialMessages: async () => {},
    emitPostInitState: () => {}, showDialog: () => undefined, rememberReasoning: () => {}, setSessionId: () => {},
    getCycleModels: () => [], setCycleModels: () => {}, setAutoCompactionEnabled: () => {}, setAutoRetryEnabled: () => {},
  };
}

test("a foreign managed rustBinaryPath is skipped quietly and the session spawns the managed binary", async () => {
  const want = plant(managedBin);
  plant(path.join(homeDir, ".local", "bin", "rust-pi"));
  mock.config[KEY] = MAC_VALUE;
  const s = detectRustBinary();
  assert.equal(s.binaryPath, want);
  assert.equal(s.configuredPathError, undefined, "no 'could not be used' for a value our install wrote elsewhere");

  const warned: string[] = [];
  let spawnedWith = "";
  const deps = {
    detectBinary: () => detectRustBinary(),
    warnConfiguredBinaryUnusable: (why: string) => { warned.push(why); },
    shouldDisableExtensions: () => false, workspaceIsTrusted: () => true, extensionsMode: () => "auto",
    setupModels: async () => ({ piEnv: {}, warnings: [] }), sessionDir: () => tmp, workspaceCwd: () => tmp,
    config: () => ({ defaultThinkingLevel: "off", rustExtensionPolicy: "balanced", contextBudget: 0, readyBudgetMs: 200 }),
    showError: () => {}, offerReopen: () => {}, exportHtml: async (_s: unknown, out: string) => out,
    detectMissingTools: async () => null,
    createProcess: (opts: RustProcessOpts) => {
      spawnedWith = opts.binaryPath;
      return {
        spawn: async () => { throw new Error("stop after spawn (test)"); },
        dispose: () => {}, isAlive: () => false,
        request: async () => ({ type: "response", success: false }), send: () => {},
      } as unknown as RustProcess;
    },
  } as unknown as RustDeps;
  const svc = new RustService(hostStub(), deps);
  try { await svc.initialize({ fresh: true }); } finally { svc.dispose(); }
  assert.equal(spawnedWith, want, "the session runs the managed binary");
  assert.deepEqual(warned, [], "no configured-binary warning");
});

test("a foreign managed value with no managed binary falls through quietly to ~/.local/bin", () => {
  const want = plant(path.join(homeDir, ".local", "bin", "rust-pi"));
  mock.config[KEY] = MAC_VALUE;
  const s = detectRustBinary();
  assert.equal(s.binaryPath, want);
  assert.equal(s.configuredPathError, undefined);
});

test("a user-typed nonexistent rustBinaryPath still reports configuredPathError", () => {
  plant(managedBin);
  mock.config[KEY] = "/opt/mine/pi";
  const s = detectRustBinary();
  assert.equal(s.installed, true);
  assert.match(s.configuredPathError ?? "", /does not exist/);
});

test("another extension's managed-shaped missing path still warns", () => {
  plant(managedBin);
  mock.config[KEY] = "/Users/x/globalStorage/other.ext/rust-pi/pi";
  assert.match(detectRustBinary().configuredPathError ?? "", /does not exist/);
});

test("finishManagedInstall does not write rustBinaryPath", async () => {
  plant(managedBin);
  const ok = await finishManagedInstall(managedBin, "v0.0.0");
  assert.equal(ok, true);
  assert.equal(mock.calls.filter((c) => c.kind === "configUpdate").length, 0, "no settings write");
  assert.equal(Object.prototype.hasOwnProperty.call(mock.config, KEY), false);
  assert.ok(mock.calls.some((c) => c.kind === "info" && /installed/.test(String(c.message))));
  // Design review 7: the users in option c's gap (a later hand-run install) see how to switch.
  assert.ok(mock.calls.some((c) => c.kind === "info" && /installed/.test(String(c.message)) && /Detect an existing binary/.test(String(c.message))));
});

test("finishManagedInstall: a user setting that outranks the managed binary is OFFERED, never silently cleared", async () => {
  plant(managedBin);
  const typed = plant(path.join(tmp, "typed2", "pi"));
  mock.config[KEY] = typed;
  mock.messageChoice.push("Keep Setting");
  await finishManagedInstall(managedBin, "v0.0.0");
  assert.equal(mock.config[KEY], typed, "Keep → untouched");
  assert.ok(mock.calls.some((c) => /outranks|takes precedence/.test(String(c.message))), "the user is told");
  assert.equal(mock.calls.filter((c) => c.kind === "configUpdate").length, 0);

  mock.calls.length = 0;
  mock.messageChoice.push("Use Managed Install");
  await finishManagedInstall(managedBin, "v0.0.0");
  const upd = mock.calls.filter((c) => c.kind === "configUpdate");
  assert.equal(upd.length, 1, "cleared only on the explicit click");
  assert.equal(upd[0].value, undefined);
  assert.equal(mock.config[KEY], undefined);
  assert.ok(mock.calls.some((c) => c.kind === "info" && /installed/.test(String(c.message))), "re-detection switched to the managed binary");
});

test("finishManagedInstall: PI_BINARY_PATH outranking the managed binary is named, nothing is written", async () => {
  plant(managedBin);
  process.env.PI_BINARY_PATH = plant(path.join(tmp, "envbin2", "pi"));
  assert.equal(await finishManagedInstall(managedBin, "v0.0.0"), true);
  assert.ok(mock.calls.some((c) => c.kind === "warn" && /PI_BINARY_PATH/.test(String(c.message))));
  assert.equal(mock.calls.filter((c) => c.kind === "configUpdate").length, 0);
  assert.equal(mock.calls.some((c) => c.kind === "info" && /installed/.test(String(c.message))), false, "no false 'installed'");
});

test("finishManagedInstall: detection choosing another binary for any other reason is named", async () => {
  // dest that detection will not choose: a copy OUTSIDE the managed dir, while ~/.local/bin has one.
  const dest = plant(path.join(tmp, "not-managed", "pi"));
  plant(path.join(homeDir, ".local", "bin", "rust-pi"));
  assert.equal(await finishManagedInstall(dest, "v0.0.0"), true);
  assert.ok(mock.calls.some((c) => c.kind === "warn" && /detection chose/.test(String(c.message))));
  assert.equal(mock.calls.some((c) => c.kind === "info" && /installed/.test(String(c.message))), false);
});

// ── Option "c" (founder's choice): switching to a self-installed Rust Pi from inside the
// extension removes the extension's OWN managed binary — only when the managed binary is the one
// winning, only after the new binary answered `--version`, and never any other path.

const msgs = (kind: string): string[] => mock.calls.filter((c) => c.kind === kind).map((c) => String(c.message));
const removalNotice = (): string | undefined => msgs("info").find((m) => /was removed/.test(m));

test("option c T1: Detect switches to ~/.local/bin and removes the winning managed binary, with a notice", async () => {
  const m = plant(managedBin);
  const x = plant(path.join(homeDir, ".local", "bin", "rust-pi"));
  await detectRuntimes(true);
  assert.equal(cachedRuntimes()?.rustStatus?.binaryPath, m, "runtime cache primed with the managed binary");
  assert.equal(await detectAndRefresh(), true);
  assert.equal(fs.existsSync(managedBin), false, "managed binary removed");
  assert.equal(detectRustBinary().binaryPath, x);
  assert.equal(cachedRuntimes()?.rustStatus?.binaryPath, x, "runtime context refreshed (force)");
  const n = removalNotice() ?? "";
  assert.ok(n.includes(managedBin), "notice names what was removed");
  assert.match(n, /Install Rust Pi/, "notice says how to get it back");
  assert.match(n, /Managed download/);
  assert.match(n, /Detect an existing binary/, "notice covers the hand-run terminal install");
});

test("option c T2/T5: Detect keeps the managed binary when nothing else runs", async () => {
  const want = plant(managedBin);
  plant(path.join(homeDir, ".local", "bin", "rust-pi"), BROKEN); // present but fails --version
  assert.equal(await detectAndRefresh(), true);
  assert.equal(fs.existsSync(managedBin), true, "kept");
  assert.equal(detectRustBinary().binaryPath, want);
  assert.equal(removalNotice(), undefined);
  assert.ok(msgs("info").some((m) => /extension-managed install/.test(m)), "reported as the managed install");
});

test("option c T3: a failed Detect (nothing runnable) leaves a managed file untouched", async () => {
  plant(managedBin, BROKEN);
  assert.equal(await detectAndRefresh(), false);
  assert.equal(fs.existsSync(managedBin), true);
  assert.ok(msgs("warn").some((m) => /No Rust Pi binary found/.test(m)));
});

test("option c T10: when the setting already outranks the managed binary, Detect removes nothing", async () => {
  plant(managedBin);
  const typed = plant(path.join(tmp, "typed10", "pi"));
  mock.config[KEY] = typed;
  assert.equal(await detectAndRefresh(), true);
  assert.equal(fs.existsSync(managedBin), true, "the user's fallback survives a status check");
  assert.equal(removalNotice(), undefined);
});

for (const via of ["setting", "PI_BINARY_PATH"] as const) {
  test(`option c T11: a legacy ${via} pointing INTO the managed dir — Detect switches, then no warning`, async () => {
    plant(managedBin);
    const x = plant(path.join(homeDir, ".local", "bin", "rust-pi"));
    if (via === "setting") { mock.config[KEY] = managedBin; } else { process.env.PI_BINARY_PATH = managedBin; }
    assert.equal(await detectAndRefresh(), true);
    assert.equal(fs.existsSync(managedBin), false);
    const s = detectRustBinary();
    assert.equal(s.binaryPath, x);
    assert.equal(s.configuredPathError, undefined, "S1 (i): this machine's own managed path, gone, is quiet");
  });
}

test("option c T11c: a setting that is a SYMLINK into the managed dir is excluded by realpath", async () => {
  plant(managedBin);
  const x = plant(path.join(homeDir, ".local", "bin", "rust-pi"));
  const link = path.join(tmp, "link11c", "pi");
  fs.mkdirSync(path.dirname(link), { recursive: true });
  fs.rmSync(link, { force: true });
  fs.symlinkSync(managedBin, link);
  mock.config[KEY] = link;
  assert.equal(await detectAndRefresh(), true);
  assert.equal(fs.existsSync(managedBin), false, "managed removed; the link now dangles");
  assert.equal(fs.lstatSync(link, { throwIfNoEntry: false })?.isSymbolicLink(), true, "the user's link itself is untouched");
  assert.equal(detectRustBinary().binaryPath, x);
  assert.match(removalNotice() ?? "", /pointed at it; clear it/, "the now-dangling setting is named");
});

test("option c T13: a NON-pi file in the managed dir winning via the setting — managed pi is not removed", async () => {
  plant(managedBin);
  const custom = plant(path.join(managedDir, "pi-custom"));
  plant(path.join(homeDir, ".local", "bin", "rust-pi"));
  mock.config[KEY] = custom;
  assert.equal(await detectAndRefresh(), true);
  assert.equal(fs.existsSync(managedBin), true);
  assert.equal(removalNotice(), undefined);
});

test("option c T4: scope — nothing but <managedDir>/pi is ever removed", async () => {
  // Every other binary survives a switch, and so does a sibling file in the managed dir.
  plant(managedBin);
  const sibling = path.join(managedDir, "keep.txt");
  fs.writeFileSync(sibling, "x");
  const onPath = plant(path.join(pathDir, "rust-pi"));
  const x = plant(path.join(homeDir, ".local", "bin", "rust-pi"));
  await detectAndRefresh();
  assert.equal(fs.existsSync(managedBin), false);
  for (const f of [sibling, onPath, x]) { assert.equal(fs.existsSync(f), true, `${f} survives`); }

  // A managed `pi` that is a SYMLINK to an outside file: the link goes, its target stays.
  const outside = plant(path.join(tmp, "outside", "pi"));
  fs.mkdirSync(managedDir, { recursive: true });
  fs.symlinkSync(outside, managedBin);
  const r = removeManagedRustBinary();
  assert.deepEqual(r, { removed: managedBin });
  assert.equal(fs.existsSync(outside), true, "symlink target untouched");
  assert.equal(fs.lstatSync(managedBin, { throwIfNoEntry: false }), undefined);

  // Before activation (no managed dir) it removes nothing at all.
  plant(managedBin);
  setManagedRustDir(null);
  assert.equal(removeManagedRustBinary(), null);
  assert.equal(fs.existsSync(managedBin), true);
  // No path parameter: the target can never come from a setting or a candidate.
  assert.equal(removeManagedRustBinary.length, 0);
});

test("option c T6b: removing the managed binary drops the detection memo", () => {
  plant(managedBin);
  const x = plant(path.join(homeDir, ".local", "bin", "rust-pi"));
  assert.equal(detectRustBinary().binaryPath, fs.realpathSync(managedBin), "memo primed with managed");
  assert.deepEqual(removeManagedRustBinary(), { removed: managedBin });
  assert.equal(detectRustBinary().binaryPath, x, "no manual invalidate — within DETECT_TTL");
});

test("option c T8: a directory at <managedDir>/pi is refused, never removed recursively", async () => {
  fs.mkdirSync(managedBin, { recursive: true });
  fs.writeFileSync(path.join(managedBin, "inner"), "x");
  const r = removeManagedRustBinary();
  assert.ok(r && "error" in r);
  assert.equal(fs.existsSync(path.join(managedBin, "inner")), true);
});

test("option c T8b: removal that fails (locked / no permission) warns honestly and keeps the managed binary", { skip: process.getuid?.() === 0 }, async () => {
  const want = plant(managedBin);
  plant(path.join(homeDir, ".local", "bin", "rust-pi"));
  fs.chmodSync(managedDir, 0o555);
  try {
    await detectAndRefresh();
  } finally { fs.chmodSync(managedDir, 0o755); }
  assert.equal(fs.existsSync(managedBin), true);
  const w = msgs("warn").find((m) => m.includes(managedBin)) ?? "";
  assert.match(w, /still takes precedence/);
  assert.match(w, /EACCES|EPERM/);
  assert.equal(removalNotice(), undefined);
  assert.equal(detectRustBinary().binaryPath, want, "reports what is really in effect");
});

test("option c T7: curl — nothing is removed until Detect is clicked", async () => {
  plant(managedBin);
  const x = plant(path.join(homeDir, ".local", "bin", "rust-pi"));
  mock.messageChoice.push(undefined); // dismissed
  await afterCurlInstall();
  assert.equal(fs.existsSync(managedBin), true, "dismiss → untouched");
  mock.messageChoice.push("Detect");
  await afterCurlInstall();
  assert.equal(fs.existsSync(managedBin), false, "Detect → switched");
  assert.equal(detectRustBinary().binaryPath, x);
});

test("option c T12: curl → Detect that finds nothing offers Reload Window", async () => {
  mock.messageChoice.push("Detect", "Reload Window");
  await afterCurlInstall();
  assert.ok(msgs("warn").some((m) => /No Rust Pi binary found/.test(m)));
  assert.ok(mock.calls.some((c) => c.kind === "command" && c.command === "workbench.action.reloadWindow"));
});

// ── Unit 4c: removal can only ever delete the extension's OWN file (review of record SF1/SF2).

const keptNotice = (): string | undefined => msgs("info").find((m) => /no other runnable Rust Pi was found/.test(m));

test("SF1 (i): a SYMLINKED managed folder (→ the user's ~/.local/bin) is refused — the user's pi survives", async () => {
  // The reviewer's P1 layout: <gs>/…/rust-pi is a symlink to ~/.local/bin, which holds `pi`;
  // the user also has ~/.cargo/bin/rust-pi. Before 4c, Detect deleted ~/.local/bin/pi.
  const userBin = path.join(homeDir, ".local", "bin");
  const userPi = plant(path.join(userBin, "pi"));
  plant(path.join(homeDir, ".cargo", "bin", "rust-pi"));
  fs.mkdirSync(path.dirname(managedDir), { recursive: true });
  fs.symlinkSync(userBin, managedDir);
  try {
    await detectAndRefresh();
    assert.equal(fs.existsSync(userPi), true, "the user's ~/.local/bin/pi survives");
    assert.equal(fs.lstatSync(managedDir).isSymbolicLink(), true, "the link itself is left in place");
    assert.equal(removalNotice(), undefined);
    const w = msgs("warn").find((m) => m.includes(managedDir)) ?? "";
    assert.match(w, /is a symlink/, "the user is told why nothing was removed");
    assert.doesNotMatch(w, /Close Rust sessions/, "not the locked-file wording");
    assert.equal(keptNotice(), undefined, "no contradictory 'no other Rust Pi' message");
    assert.deepEqual(removeManagedRustBinary(), { error: `${managedDir} is a symlink, not the extension's own folder — left in place`, refused: true });
    assert.equal(fs.existsSync(userPi), true);
  } finally { fs.rmSync(managedDir, { force: true }); }
});

test("SF1 (ii): containment — a managed folder that is not <globalStorage>/rust-pi is refused", () => {
  // No symlink here, so the lstat guard alone would delete: activate() handing the resolver the
  // wrong folder (a fake ~/.local/bin) must still never cost the user their pi.
  const userBin = path.join(homeDir, ".local", "bin");
  const userPi = plant(path.join(userBin, "pi"));
  setManagedRustDir(userBin);
  const r = removeManagedRustBinary();
  assert.ok(r && "error" in r, "refused");
  assert.match((r as { error: string }).error, /not the extension's own folder/);
  assert.equal(fs.existsSync(userPi), true);
});

test("SF2: an impostor `pi` whose --version names another program does not remove the managed binary", async () => {
  // The review's shape: managed = a copy of echo, PATH `pi` = a copy of ls (`ls (GNU coreutils) …`).
  const want = plant(managedBin);
  const impostor = plant(path.join(pathDir, "pi"), "/bin/ls");
  assert.equal(await detectAndRefresh(), true);
  assert.equal(fs.existsSync(managedBin), true, "managed kept");
  assert.equal(fs.existsSync(impostor), true);
  assert.equal(removalNotice(), undefined);
  const w = msgs("warn").find((m) => m.includes(impostor)) ?? "";
  assert.match(w, /does not identify as Rust Pi/);
  assert.match(w, /extension-managed install was kept/);
  assert.equal(keptNotice(), undefined, "no contradictory 'no other Rust Pi' message");
  assert.equal(detectRustBinary().binaryPath, want);
});

test("SF2: a replacement that is the SAME FILE (hard link, same dev+inode) as the managed binary is refused", async () => {
  const want = plant(managedBin);
  const alias = path.join(homeDir, ".local", "bin", "rust-pi");
  fs.mkdirSync(path.dirname(alias), { recursive: true });
  fs.linkSync(managedBin, alias);
  assert.equal(await detectAndRefresh(), true);
  assert.equal(fs.existsSync(managedBin), true, "managed kept");
  assert.equal(fs.existsSync(alias), true);
  assert.equal(removalNotice(), undefined);
  const w = msgs("warn").find((m) => m.includes(alias)) ?? "";
  assert.match(w, /same file as the extension-managed install/);
  assert.equal(detectRustBinary().binaryPath, want);
});
