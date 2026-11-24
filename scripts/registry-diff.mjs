// Compare two generated model registries (src/model-registry.generated.json) and say what moved.
//
//   node scripts/registry-diff.mjs <old.json> <new.json>            ← markdown, for a PR body
//   node scripts/registry-diff.mjs <old.json> <new.json> --json     ← the structured diff
//
// WHY THIS EXISTS: the bundled catalog carries model PRICING, and the status bar quotes it. A
// pi-ai bump used to be left for a human precisely because "the regenerated prices deserve a
// look" (the 0.86.1 refresh moved 67 of them, one by 5x). This script IS that look, written out:
// the automated pi-ai PR (.github/workflows/upstream-currency.yml) puts its output in the PR
// body, so the review happens where the merge button is instead of in an issue nobody acts on.
//
// Pure functions (diffRegistries, renderRegistryDiff) are unit-tested in
// scripts/test/registry-diff.test.mjs.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** A move of this factor or more, either way, is flagged for a closer look. */
export const FLAG_FACTOR = 2;
const COST_FIELDS = ["input", "output", "cacheRead", "cacheWrite"];

/** provider/id → model, so the same model id under two providers stays two entries. */
function flatten(registry) {
  const out = new Map();
  for (const [provider, entry] of Object.entries(registry.providers ?? {})) {
    for (const m of entry.models ?? []) { out.set(`${provider}/${m.id}`, m); }
  }
  return out;
}

/** The headline rates: what every turn pays. A model quoted free that now costs money (or the
 *  reverse) is always worth a look. */
const HEADLINE_FIELDS = new Set(["input", "output"]);

/** The largest factor any single cost field moved by; 1 when nothing moved by a ratio.
 *  Infinity when an INPUT or OUTPUT price appears from zero or drops to zero: there is no ratio,
 *  and either is worth a human look. A CACHE price appearing or vanishing is not — pi-ai fills
 *  those in routinely (1.3.0 → 1.5.2 added dozens) and flagging each buried the real moves. */
function costFactor(a = {}, b = {}) {
  let factor = 1;
  for (const f of COST_FIELDS) {
    const x = Number(a[f] ?? 0), y = Number(b[f] ?? 0);
    if (x === y) { continue; }
    if (x === 0 || y === 0) {
      if (HEADLINE_FIELDS.has(f)) { return Infinity; }
      continue;
    }
    factor = Math.max(factor, x > y ? x / y : y / x);
  }
  return Math.round(factor * 100) / 100;
}

const sameCost = (a = {}, b = {}) => COST_FIELDS.every((f) => Number(a[f] ?? 0) === Number(b[f] ?? 0));

export function diffRegistries(oldReg, newReg) {
  const pa = Object.keys(oldReg.providers ?? {}), pb = Object.keys(newReg.providers ?? {});
  const connectionChanged = [];
  for (const p of pa) {
    const A = oldReg.providers[p], B = newReg.providers?.[p];
    if (B && (A.baseUrl !== B.baseUrl || A.api !== B.api)) {
      connectionChanged.push({ provider: p, from: `${A.baseUrl} ${A.api}`, to: `${B.baseUrl} ${B.api}` });
    }
  }

  const A = flatten(oldReg), B = flatten(newReg);
  const repriced = [];
  const otherChanges = {};
  for (const [key, x] of A) {
    const y = B.get(key);
    if (!y) { continue; }
    if (!sameCost(x.cost, y.cost)) {
      const factor = costFactor(x.cost, y.cost);
      repriced.push({ key, from: x.cost ?? null, to: y.cost ?? null, factor, flag: factor >= FLAG_FACTOR });
    }
    for (const f of new Set([...Object.keys(x), ...Object.keys(y)])) {
      if (f === "cost") { continue; }
      if (JSON.stringify(x[f]) !== JSON.stringify(y[f])) { otherChanges[f] = (otherChanges[f] ?? 0) + 1; }
    }
  }
  repriced.sort((r, s) => s.factor - r.factor || r.key.localeCompare(s.key));

  return {
    from: { version: oldReg.piAiVersion ?? null, generatedAt: oldReg.modelDataGeneratedAt ?? null },
    to: { version: newReg.piAiVersion ?? null, generatedAt: newReg.modelDataGeneratedAt ?? null },
    providers: {
      before: pa.length, after: pb.length,
      added: pb.filter((p) => !pa.includes(p)),
      removed: pa.filter((p) => !pb.includes(p)),
      connectionChanged,
    },
    models: {
      before: A.size, after: B.size,
      added: [...B.keys()].filter((k) => !A.has(k)),
      removed: [...A.keys()].filter((k) => !B.has(k)),
    },
    repriced,
    otherChanges,
  };
}

const fmtCost = (c) => (c ? COST_FIELDS.map((f) => c[f] ?? 0).join(" / ") : "—");
const fmtFactor = (f) => (f === Infinity ? "to/from free" : f === 1 ? "cache price added/removed" : `${f}x`);
const day = (iso) => (iso ? String(iso).slice(0, 10) : "undated");

function capped(items, limit) {
  const shown = items.slice(0, limit).map((i) => `- \`${i}\``);
  if (items.length > limit) { shown.push(`- …and ${items.length - limit} more`); }
  return shown;
}

/** Markdown for a PR body. GitHub caps a body at 65,536 characters, so every list is capped. */
export function renderRegistryDiff(d, { listLimit = 60, tableLimit = 80 } = {}) {
  const flagged = d.repriced.filter((r) => r.flag);
  const L = [];
  L.push(`**pi-ai ${d.from.version} → ${d.to.version}** (model data ${day(d.from.generatedAt)} → ${day(d.to.generatedAt)})`);
  L.push("");
  L.push(`- Models: ${d.models.before} → ${d.models.after} (${d.models.added.length} added, ${d.models.removed.length} removed)`);
  L.push(`- Providers: ${d.providers.before} → ${d.providers.after}` +
    (d.providers.added.length ? `; added ${d.providers.added.map((p) => `\`${p}\``).join(", ")}` : "") +
    (d.providers.removed.length ? `; removed ${d.providers.removed.map((p) => `\`${p}\``).join(", ")}` : ""));
  L.push(d.repriced.length
    ? `- Prices: ${d.repriced.length} model(s) repriced; **${flagged.length} price move${flagged.length === 1 ? "" : "s"} of ${FLAG_FACTOR}x or more**`
    : "- Prices: No price changed.");
  const other = Object.entries(d.otherChanges);
  if (other.length) { L.push(`- Other fields changed on kept models: ${other.map(([f, n]) => `${f} ${n}`).join(", ")}`); }

  if (d.providers.connectionChanged.length) {
    L.push("", "#### Endpoint changes", "Requests for these providers now go somewhere else:", "");
    for (const c of d.providers.connectionChanged) { L.push(`- \`${c.provider}\`: \`${c.from}\` → \`${c.to}\``); }
  }

  if (d.repriced.length) {
    L.push("", "#### Price changes", "Per million tokens: input / output / cache read / cache write. Largest move first; :warning: marks a move of " +
      `${FLAG_FACTOR}x or more.`, "");
    L.push("| model | before | after | move |", "| --- | --- | --- | --- |");
    for (const r of d.repriced.slice(0, tableLimit)) {
      L.push(`| ${r.key} | ${fmtCost(r.from)} | ${fmtCost(r.to)} | ${r.flag ? ":warning: " : ""}${fmtFactor(r.factor)} |`);
    }
    if (d.repriced.length > tableLimit) { L.push("", `…and ${d.repriced.length - tableLimit} smaller moves (run \`node scripts/registry-diff.mjs\` locally for all).`); }
  }

  for (const [title, items] of [["Added models", d.models.added], ["Removed models", d.models.removed]]) {
    if (!items.length) { continue; }
    L.push("", `<details><summary>${title} (${items.length})</summary>`, "", ...capped(items, listLimit), "", "</details>");
  }
  return L.join("\n");
}

// ── CLI ──────────────────────────────────────────────────────────────
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const [oldPath, newPath] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
  if (!oldPath || !newPath) {
    console.error("usage: registry-diff.mjs <old.json> <new.json> [--json]");
    process.exit(2);
  }
  const read = (p) => JSON.parse(readFileSync(p, "utf8"));
  const d = diffRegistries(read(oldPath), read(newPath));
  console.log(process.argv.includes("--json") ? JSON.stringify(d, null, 2) : renderRegistryDiff(d));
}
