// Report drift between what this extension targets and what upstream has actually shipped.
//
//   node scripts/check-currency.mjs            ← advisory; always exits 0
//   node scripts/check-currency.mjs --strict   ← exits 1 on any drift (use at release time)
//   node scripts/check-currency.mjs --json     ← machine-readable; same exit codes
//
// --json exists for .github/workflows/upstream-currency.yml, which turns drift into a GitHub
// ISSUE. That workflow is the point: this script has correctly reported rust-pi v0.3.0 against
// v0.5.1 since 12 September, into CI logs nobody reads. Detection was never the gap.
//
// WHY THIS EXISTS: three upstream projects move independently and nothing told us when they
// did. We found out by breakage — pi-ai removed getProviders()/getModels() at 0.81.0 and the
// catalog generator simply stopped working, silently blocking `max` for a week. Model PRICING
// rides on the same package, so drift there means we quote stale rates in the status bar with
// full confidence.
//
//   pi_agent_rust        the Rust backend. Pinned by src/rust-pi-version.json.
//   @earendil-works/pi-ai            the model catalog + PRICING. devDependency; regenerates
//                                    src/model-registry.generated.json.
//   @earendil-works/pi-coding-agent  the TypeScript backend (in-process SDK). Installed
//                                    globally rather than as a package dependency, so nothing
//                                    in this repo records which version we work against.
//
// Advisory by default on purpose: an upstream release should not break local builds or CI for
// people who are not doing a release. --strict is the release gate.

import { readFileSync, existsSync } from "node:fs";
import { runSupplyChainChecks } from "./supply-chain.mjs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const STRICT = process.argv.includes("--strict");
const JSON_OUT = process.argv.includes("--json");
const NET_TIMEOUT_MS = 10_000;

const read = (p) => JSON.parse(readFileSync(join(root, p), "utf8"));

async function getJson(url) {
  const ac = new AbortController();
  const t = setTimeout(() => ac.abort(), NET_TIMEOUT_MS);
  try {
    const res = await fetch(url, { signal: ac.signal, headers: { "user-agent": "pi-code-gui-currency-check" } });
    if (!res.ok) { throw new Error(`HTTP ${res.status}`); }
    return await res.json();
  } finally { clearTimeout(t); }
}

/** Numeric-triple compare; returns true when `a` is strictly older than `b`. */
function older(a, b) {
  const pa = String(a).match(/(\d+)\.(\d+)\.(\d+)/), pb = String(b).match(/(\d+)\.(\d+)\.(\d+)/);
  if (!pa || !pb) { return false; }
  for (let i = 1; i <= 3; i++) {
    const x = Number(pa[i]), y = Number(pb[i]);
    if (x !== y) { return x < y; }
  }
  return false;
}

const rows = [];
const notes = [];
let drift = 0, unreachable = 0;

/** Structured mirror of `rows`, for --json. Same data, without the column padding. */
const items = [];

function record(name, ours, latest, extra) {
  if (latest === null) {
    unreachable++;
    rows.push([name, ours, "(unreachable)", "?"]);
    items.push({ name, ours: String(ours), latest: null, state: "unreachable" });
    return;
  }
  const stale = older(ours, latest);
  if (stale) { drift++; }
  rows.push([name, ours, latest, stale ? "STALE" : "current"]);
  items.push({ name, ours: String(ours), latest: String(latest), state: stale ? "stale" : "current",
               action: stale && extra ? extra.replace(/^\s*->\s*/m, "").trim() : undefined });
  if (stale && extra) { notes.push(extra); }
}

// ── 1. pi_agent_rust (the Rust backend) ─────────────────────────────
const pinnedTag = read("src/rust-pi-version.json").tag;
let rustLatest = null;
try {
  const rel = await getJson("https://api.github.com/repos/Dicklesworthstone/pi_agent_rust/releases/latest");
  rustLatest = rel.tag_name;
  // A release can be published with an incomplete asset matrix — v0.1.23 shipped 3 of 5
  // binaries and backfilled linux-arm64 a week later. Bumping the pin to a release that has
  // no asset for a user's platform breaks their managed install, so surface the matrix.
  const assets = (rel.assets ?? []).map((a) => a.name);
  const bins = assets.filter((n) => n.startsWith("pi-") && !n.endsWith(".json"));
  const EXPECTED = ["pi-linux-amd64", "pi-linux-arm64", "pi-darwin-amd64", "pi-darwin-arm64", "pi-windows-amd64"];
  const missing = EXPECTED.filter((e) => !bins.some((b) => b.startsWith(e)));
  if (missing.length) {
    notes.push(`  ! ${rustLatest} is missing platform assets: ${missing.join(", ")}\n` +
               `    Managed install fails outright for those platforms — verify before bumping the pin.`);
  }
} catch (e) { notes.push(`  ! could not reach the GitHub releases API: ${e.message}`); }
record("pi_agent_rust (Rust backend)", pinnedTag, rustLatest,
  `  -> bump "tag" in src/rust-pi-version.json, then re-verify the managed install.`);

// ── 2. pi-ai (model catalog + pricing) ──────────────────────────────
const registry = read("src/model-registry.generated.json");
const bundledPiAi = registry.piAiVersion;
let piAiLatest = null;
try { piAiLatest = (await getJson("https://registry.npmjs.org/@earendil-works/pi-ai/latest")).version; }
catch (e) { notes.push(`  ! could not reach npm for pi-ai: ${e.message}`); }
record("pi-ai (catalog + PRICING)", bundledPiAi, piAiLatest,
  `  -> pnpm add -D @earendil-works/pi-ai@latest && pnpm run gen:model-registry\n` +
  `     Model PRICING lives in this file: while it is stale the status bar quotes old rates.`);

if (registry.modelDataGeneratedAt) {
  const days = Math.floor((Date.now() - Date.parse(registry.modelDataGeneratedAt)) / 86_400_000);
  rows.push(["  ↳ pricing data generated", registry.modelDataGeneratedAt.slice(0, 10), `${days}d ago`,
    days > 45 ? "AGING" : "ok"]);
}

// ── 3. pi-coding-agent (the TypeScript backend) ─────────────────────
// Not a package dependency — it is installed globally and the devcontainer takes @latest — so
// the only local evidence of what we work against is whatever is installed right now.
// On a CI runner there is no global install, so "ours" used to read "(not installed)" — which
// carries no version triple, so the comparison silently could not flag anything. Drift in the
// TypeScript backend was therefore invisible in exactly the place we now want it reported. Fall
// back to the version we record as tested against, so the check means something off-machine.
const sdkTested = read("src/pi-sdk-version.json").testedAgainst;
let sdkInstalled = null;
for (const p of [
  join(process.env.HOME ?? "", ".npm-global/lib/node_modules/@earendil-works/pi-coding-agent/package.json"),
  "/usr/lib/node_modules/@earendil-works/pi-coding-agent/package.json",
  "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/package.json",
]) {
  if (existsSync(p)) { sdkInstalled = JSON.parse(readFileSync(p, "utf8")).version; break; }
}
// Prefer the recorded value: it is what this repo claims to work against, and it is the same
// number on every machine. A local install that has drifted from it is its own note below.
const sdkOurs = sdkTested ?? sdkInstalled ?? "(not installed)";
if (sdkInstalled && sdkTested && sdkInstalled !== sdkTested) {
  notes.push(`  ! the globally installed pi-coding-agent is ${sdkInstalled}, but src/pi-sdk-version.json\n` +
             `    records ${sdkTested} as tested. Bump that file once you have run the TS side against it.`);
}
let sdkLatest = null;
try { sdkLatest = (await getJson("https://registry.npmjs.org/@earendil-works/pi-coding-agent/latest")).version; }
catch (e) { notes.push(`  ! could not reach npm for pi-coding-agent: ${e.message}`); }
record("pi-coding-agent (TS backend)", sdkOurs, sdkLatest,
  `  -> npm install -g @earendil-works/pi-coding-agent@latest, run the TS side of the\n` +
  `     side-by-side, then bump "testedAgainst" in src/pi-sdk-version.json.`);

// ── 4. supply chain ─────────────────────────────────────────────────
// Currency alone does not protect you: the ChainDrop campaign shipped MALICIOUS versions of
// packages we were otherwise current with. See scripts/supply-chain.mjs.
const sc = runSupplyChainChecks();
const critical = sc.findings.filter((f) => f.severity === "CRITICAL");
const review = sc.findings.filter((f) => f.severity === "REVIEW");

// ── report ──────────────────────────────────────────────────────────
// --json short-circuits the pretty report: one object on stdout, so a workflow can build an
// issue body from it without parsing columns. Exit codes are identical either way.
if (JSON_OUT) {
  console.log(JSON.stringify({
    checkedAt: new Date().toISOString(),
    drift, unreachable,
    items,
    notes: notes.map((n) => n.replace(/^\s+/gm, "").trim()),
    supplyChain: { scanned: sc.scanned, critical: critical.map((f) => f.what), review: review.map((f) => f.what) },
  }, null, 2));
  if (critical.length) { process.exit(1); }
  if (unreachable && STRICT) { process.exit(1); }
  process.exit(drift && STRICT ? 1 : 0);
}

const w = rows.reduce((m, r) => Math.max(m, r[0].length), 0);
console.log("\nUpstream currency\n");
for (const [name, ours, latest, state] of rows) {
  const mark = state === "STALE" || state === "AGING" ? "!" : state === "?" ? "?" : " ";
  console.log(` ${mark} ${name.padEnd(w)}  ours: ${String(ours).padEnd(12)} latest: ${String(latest).padEnd(12)} ${state}`);
}
if (notes.length) { console.log("\n" + notes.join("\n")); }

console.log(`\nSupply chain (${sc.scanned} installed packages scanned)`);
if (critical.length === 0 && review.length === 0) {
  console.log("   no known-compromised versions, no indicators of compromise, no unrecognised install hooks");
} else {
  for (const f of critical) { console.log(`  !! ${f.what}\n     ${f.where}`); }
  for (const f of review) { console.log(`  ?  ${f.what}\n     ${f.where}`); }
}

if (critical.length) {
  console.log(`\ncheck-currency: FAILED — ${critical.length} supply-chain finding(s). This is not advisory.`);
  process.exit(1);
}
if (unreachable && STRICT) {
  console.log(`\ncheck-currency: FAILED — ${unreachable} source(s) unreachable and --strict was set.`);
  process.exit(1);
}
if (drift === 0) {
  console.log(`\ncheck-currency: current with upstream.${unreachable ? ` (${unreachable} source(s) unreachable)` : ""}`);
  process.exit(0);
}
console.log(`\ncheck-currency: ${drift} dependency/dependencies behind upstream.`);
process.exit(STRICT ? 1 : 0);
