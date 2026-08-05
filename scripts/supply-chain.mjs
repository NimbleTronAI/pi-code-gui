// Supply-chain checks over the INSTALLED dependency tree, run as part of check-currency.
//
// WHY: on 2026-08-04 the "ChainDrop"/Shai-Hulud campaign published malicious versions of
// ~400 npm packages, including keyv, flat-cache and file-entry-cache — all three of which sit
// under eslint and are therefore in this tree. We were unaffected only because the malicious
// releases were major bumps outside our semver ranges, and we found that out by reading a news
// article. That is not a control. These checks make the same question answerable on demand.
//
// Three independent checks, because each catches what the others miss:
//   1. KNOWN_BAD  — exact package@version matches. Precise, but only for advisories we know of.
//   2. IOC        — malicious filenames/strings/hashes anywhere in the tree. Catches a
//                   compromised package we have NOT heard about.
//   3. HOOKS      — install hooks outside a known-good allowlist. Catches the DELIVERY
//                   mechanism itself: these campaigns run via preinstall/postinstall.
//
// Deliberately NOT a network call: it must work offline and in CI, and an advisory feed that
// fails open would be worse than no check. Extend KNOWN_BAD by hand when an advisory lands.

import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";

/** Exact `name@version` strings known to be malicious. */
export const KNOWN_BAD = new Set([
  // ChainDrop / "Shai-Hulud: Here We Go Again", published 2026-08-04.
  "keyv@6.0.0", "flat-cache@6.1.24", "file-entry-cache@11.1.6",
  "cacheable-request@13.0.20", "cacheable@2.5.1", "@cacheable/memory@2.2.1",
  "cache-manager@7.2.10", "@cacheable/node-cache@3.1.2", "@cacheable/utils@2.5.1",
  "@cacheable/net@2.1.1", "ecto@5.0.1",
]);

/** Files whose mere presence indicates compromise. */
const IOC_FILENAMES = new Set(["setup.mjs", "Math_Symbol.js", "math_init.js"]);

/** Strings that should never appear in a dependency. */
const IOC_STRINGS = ["npm-cache.com", "Shai-Hulud"];

/** SHA-256 of known malicious payloads. */
const IOC_HASHES = new Set([
  "54dc7ea54a1317cca0e890a2770630cf7fa6c97813e0cb9d2caa93012b350668",
  "9fc2570b7cef51c1b8df116d144d11ff4096357be7d2c4c6367cfc2509cf1bcc",
]);

/** Packages legitimately allowed to run install scripts, with why. Anything else is reported:
 *  an install hook is how this class of attack executes, so a NEW one is worth a human look
 *  even when innocent. */
const HOOK_ALLOWLIST = new Map([
  ["esbuild", "fetches its platform binary"],
  ["keytar", "prebuild-install native module"],
  ["@vscode/vsce-sign", "signature tooling postinstall"],
  ["protobufjs", "generates its dist postinstall"],
  ["@google/genai", "no-op echo"],
]);

/** Every installed package, across BOTH layouts.
 *
 *  pnpm's store (`node_modules/.pnpm/<pkg@ver>/node_modules/<pkg>`) is the normal case here,
 *  but scanning only that missed anything installed flat — including, when this check was first
 *  tested with a planted canary, the canary itself. A supply-chain check that silently skips a
 *  layout is worse than none, because it reports "clean". */
function installedPackages() {
  const out = [];
  for (const root of ["node_modules/.pnpm", "node_modules"]) {
    if (!existsSync(root)) { continue; }
    collect(root, out, root === "node_modules");
  }
  return out;
}

function collect(root, out, flat) {
  for (const entry of readdirSync(root)) {
    // Flat layout: node_modules/<pkg>. Store layout: node_modules/.pnpm/<id>/node_modules/<pkg>.
    const nm = flat ? root : join(root, entry, "node_modules");
    if (flat) {
      const dirs = entry.startsWith("@")
        ? (existsSync(join(nm, entry)) ? readdirSync(join(nm, entry)).map((n) => join(entry, n)) : [])
        : [entry];
      for (const d of dirs) {
        const pj = join(nm, d, "package.json");
        if (existsSync(pj)) { out.push({ dir: join(nm, d), pkgJson: pj }); }
      }
      continue;
    }
    if (!existsSync(nm)) { continue; }
    for (const scope of readdirSync(nm)) {
      const dirs = scope.startsWith("@")
        ? readdirSync(join(nm, scope)).map((n) => join(scope, n))
        : [scope];
      for (const d of dirs) {
        const pj = join(nm, d, "package.json");
        if (existsSync(pj)) { out.push({ dir: join(nm, d), pkgJson: pj }); }
      }
    }
  }
}

function walk(dir, hit, depth = 0) {
  if (depth > 6) { return; }
  let entries;
  try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const p = join(dir, e.name);
    if (e.isDirectory()) { walk(p, hit, depth + 1); }
    else { hit(p, e.name); }
  }
}

/** Run all three checks. Returns findings; empty means clean. */
export function runSupplyChainChecks() {
  const findings = [];
  const pkgs = installedPackages();

  for (const { dir, pkgJson } of pkgs) {
    let meta;
    try { meta = JSON.parse(readFileSync(pkgJson, "utf8")); } catch { continue; }
    const id = `${meta.name}@${meta.version}`;

    if (KNOWN_BAD.has(id)) {
      findings.push({ severity: "CRITICAL", what: `known-compromised package installed: ${id}`, where: dir });
    }

    const scripts = meta.scripts || {};
    for (const hook of ["preinstall", "install", "postinstall"]) {
      if (!(hook in scripts)) { continue; }
      if (HOOK_ALLOWLIST.has(meta.name)) { continue; }
      findings.push({
        severity: "REVIEW",
        what: `unrecognised ${hook} hook in ${id}: ${String(scripts[hook]).slice(0, 60)}`,
        where: pkgJson,
      });
    }
  }

  // IOC sweep over the whole tree — filename, content, and hash.
  walk("node_modules", (path, name) => {
    if (IOC_FILENAMES.has(name)) {
      findings.push({ severity: "CRITICAL", what: `indicator-of-compromise filename: ${name}`, where: path });
    }
    if (!/\.(js|mjs|cjs|json|ts)$/.test(name)) { return; }
    let st;
    try { st = statSync(path); } catch { return; }
    if (st.size > 2_000_000) { return; }
    let body;
    try { body = readFileSync(path); } catch { return; }
    const text = body.toString("utf8");
    for (const s of IOC_STRINGS) {
      if (text.includes(s)) {
        findings.push({ severity: "CRITICAL", what: `indicator-of-compromise string "${s}"`, where: path });
      }
    }
    if (IOC_HASHES.has(createHash("sha256").update(body).digest("hex"))) {
      findings.push({ severity: "CRITICAL", what: "file matches a known malicious payload hash", where: path });
    }
  });

  return { findings, scanned: pkgs.length };
}
