// Headless tests for Pi SDK package-path resolution (pi-package-path.ts). The
// candidate ORDERING is the load-bearing part: project-local wins, then $PATH
// prefixes, then home/AppData fallbacks, then NVM versions newest-first (so a
// stale node's copy isn't preferred over a newer one).

import { test } from "node:test";
import assert from "node:assert/strict";
import * as path from "node:path";
import { buildPiPackageCandidates, pickPiPackagePath } from "../../pi-package-path.js";

const SUFFIX = path.join("node_modules", "@earendil-works", "pi-coding-agent");

test("buildPiPackageCandidates: project-local install is highest priority", () => {
  const c = buildPiPackageCandidates({ platform: "linux", pathEnv: "" });
  assert.equal(c[0], path.resolve(path.join(".pi", "npm", SUFFIX)));
});

test("buildPiPackageCandidates: $PATH bin dirs map to <prefix>/lib, de-duplicated and in order", () => {
  const c = buildPiPackageCandidates({
    platform: "linux",
    pathEnv: ["/usr/local/bin", "/usr/local/bin", "/home/u/.nvm/v20/bin"].join(":"),
  });
  assert.ok(c.includes(path.join("/usr/local", "lib", SUFFIX)));
  // prefix = dirname("/home/u/.nvm/v20/bin") = "/home/u/.nvm/v20"
  assert.ok(c.includes(path.join("/home/u/.nvm/v20", "lib", SUFFIX)));
  // /usr/local/bin appears twice but is collapsed to a single candidate.
  assert.equal(c.filter((p) => p === path.join("/usr/local", "lib", SUFFIX)).length, 1);
});

test("buildPiPackageCandidates: NVM versions are ordered newest-first (numeric)", () => {
  const c = buildPiPackageCandidates({
    platform: "linux", pathEnv: "",
    nvmDir: "/nvm", nvmVersions: ["v18.19.0", "v20.10.0", "v20.9.0", "v6.0.0"],
  });
  const base = path.join("/nvm", "versions", "node");
  const nvm = c.filter((p) => p.startsWith(base + path.sep));
  assert.deepEqual(nvm, [
    path.join(base, "v20.10.0", "lib", SUFFIX),
    path.join(base, "v20.9.0", "lib", SUFFIX),  // 20.9 < 20.10 numerically
    path.join(base, "v18.19.0", "lib", SUFFIX),
    path.join(base, "v6.0.0", "lib", SUFFIX),
  ]);
});

test("buildPiPackageCandidates: home + AppData fallbacks included when provided", () => {
  const c = buildPiPackageCandidates({ platform: "win32", pathEnv: "", appData: "C:\\Users\\u\\AppData\\Roaming", home: "C:\\Users\\u" });
  assert.ok(c.includes(path.join("C:\\Users\\u\\AppData\\Roaming", "npm", SUFFIX)));
  assert.ok(c.includes(path.join("C:\\Users\\u", ".npm-global", "lib", SUFFIX)));
  assert.ok(c.includes(path.join("C:\\Users\\u", ".local", "lib", SUFFIX)));
});

test("buildPiPackageCandidates: win32 uses ';' separator and adds the bare-prefix candidate", () => {
  const c = buildPiPackageCandidates({ platform: "win32", pathEnv: "C:\\nodejs;C:\\other" });
  // <prefix> = dirname("C:\\nodejs") = "C:\\"; win32 adds both <prefix>\\<suffix> and <prefix>\\lib\\<suffix>
  assert.ok(c.some((p) => p === path.join(path.dirname("C:\\nodejs"), SUFFIX)));
  assert.ok(c.some((p) => p === path.join(path.dirname("C:\\nodejs"), "lib", SUFFIX)));
});

test("buildPiPackageCandidates: no NVM versions → no NVM candidates", () => {
  const c = buildPiPackageCandidates({ platform: "linux", pathEnv: "", nvmDir: "/nvm", nvmVersions: [] });
  assert.ok(!c.some((p) => p.includes(path.join("/nvm", "versions", "node"))));
});

// ── pickPiPackagePath ────────────────────────────────────────────────
test("pickPiPackagePath: returns the first candidate whose package.json exists", () => {
  const cands = ["/a", "/b", "/c"];
  const found = pickPiPackagePath(cands, (p) => p === path.join("/b", "package.json"));
  assert.equal(found, "/b");
});

test("pickPiPackagePath: null when none exist", () => {
  assert.equal(pickPiPackagePath(["/a", "/b"], () => false), null);
});

test("pickPiPackagePath: a throwing probe skips that candidate, not the whole scan", () => {
  const found = pickPiPackagePath(["/x", "/y"], (p) => {
    if (p.includes(`${path.sep}x${path.sep}`)) { throw new Error("EACCES"); }
    return p === path.join("/y", "package.json");
  });
  assert.equal(found, "/y");
});
