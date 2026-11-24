// Turn `check-currency.mjs --json` into a GitHub ISSUE, and keep exactly one of them open.
//
//   node scripts/report-currency-issue.mjs currency.json [--prs prs.jsonl]     ← needs gh + GH_TOKEN
//   node scripts/report-currency-issue.mjs currency.json [--prs prs.jsonl] --dry-run
//
// THE ISSUE IS NOW THE FALLBACK. A stale target normally becomes a pull request that already does
// the work (scripts/upstream-pr.mjs; agent-wiki/operations/upstream-bump-prs.md), and a PR notifies
// on its own. The issue is for what no PR can carry:
//
//   - a stale target with NO PR: its preparation failed (e.g. the live SDK check failed, so
//     testedAgainst must not move), or PR creation itself failed. The row in --prs says why.
//   - a CRITICAL supply-chain finding.
//
// A target with an open PR is listed with a link and does not by itself keep the issue open.
//
// THE RUN GOES RED when anything here is actionable — a stale target with no PR, or a CRITICAL
// finding — AFTER the issue is written, so the issue is current and the failure shows in the
// Actions list and in GitHub's failed-run email. A green run means every stale target has a PR.
//
// NOTIFICATION DISCIPLINE: editing an issue body is silent on GitHub, while a comment notifies.
// So the body is rewritten on every run (always current, never spam) and a comment is posted
// only when something NEWLY goes stale. The previous state rides along in an HTML comment in the
// body, which is how "newly" is known without any external store.

import { readFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";

const [, , jsonPath, ...flags] = process.argv;
const DRY = flags.includes("--dry-run");
const prsPath = flags.includes("--prs") ? flags[flags.indexOf("--prs") + 1] : null;
if (!jsonPath) {
  console.error("usage: report-currency-issue.mjs <currency.json> [--prs prs.jsonl] [--dry-run]");
  process.exit(2);
}

const LABEL = "upstream-currency";
const TITLE = "Upstream: a project we target has released";
const MARKER = "currency-state:";

const report = JSON.parse(readFileSync(jsonPath, "utf8"));

/** One row per bump the workflow attempted (scripts/upstream-pr.mjs --out). Absent → none attempted. */
const prRows = prsPath && existsSync(prsPath)
  ? readFileSync(prsPath, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l))
  : [];
const prFor = (item) => prRows.find((r) => r.target === item.id && r.version === item.latest && r.url) ?? null;
const attemptFor = (item) => prRows.find((r) => r.target === item.id && r.version === item.latest) ?? null;

/** Anything worth an open issue: a stale target nobody has a PR for, or a CRITICAL finding. */
const stale = report.items.filter((i) => i.state === "stale");
const uncovered = stale.filter((i) => !prFor(i));
const critical = report.supplyChain?.critical ?? [];
const actionable = uncovered.length > 0 || critical.length > 0;

function gh(args, { allowFail = false } = {}) {
  if (DRY && args[0] === "issue" && ["create", "edit", "comment", "close", "reopen"].includes(args[1])) {
    console.log(`[dry-run] gh ${args.join(" ")}`);
    return "";
  }
  try {
    return execFileSync("gh", args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch (e) {
    if (allowFail) { return ""; }
    console.error(`gh ${args.slice(0, 2).join(" ")} failed: ${e.stderr || e.message}`);
    process.exit(1);
  }
}

/** `gh issue create --label` FAILS outright on a label that does not exist, so the very first
 *  run in a fresh repo would die before reporting anything. Create it idempotently. */
function ensureLabel() {
  if (DRY) { console.log(`[dry-run] gh label create ${LABEL}`); return; }
  gh(["label", "create", LABEL, "--color", "0E8A16",
      "--description", "A project this extension targets has released a newer version"],
     { allowFail: true });   // already exists → non-zero, and that is fine
}

/** The single open issue we manage, or null. Matched by LABEL so the title can be reworded. */
function findOpenIssue() {
  const out = gh(["issue", "list", "--label", LABEL, "--state", "open", "--limit", "1",
                  "--json", "number,body"], { allowFail: true });
  const list = out.trim() ? JSON.parse(out) : [];
  return list[0] ?? null;
}

/** The set of names that were already stale last run, read back out of the body marker. */
function previousStale(body) {
  const m = (body ?? "").match(new RegExp(`<!--\\s*${MARKER}\\s*(\\{[\\s\\S]*?\\})\\s*-->`));
  if (!m) { return new Set(); }
  try { return new Set(JSON.parse(m[1]).stale ?? []); } catch { return new Set(); }
}

function buildBody() {
  const lines = [];
  lines.push("Opened and maintained by `.github/workflows/upstream-currency.yml`. The body is");
  lines.push("rewritten on each run, so it always reflects the latest check.");
  lines.push("");
  lines.push("| target | ours | latest | |");
  lines.push("| --- | --- | --- | --- |");
  for (const i of report.items) {
    const pr = i.state === "stale" ? prFor(i) : null;
    const mark = pr ? `behind: PR ${pr.number ? `#${pr.number}` : pr.url}` : i.state === "stale" ? "**behind, no PR**" : i.state === "unreachable" ? "unreachable" : "current";
    lines.push(`| ${i.name} | \`${i.ours}\` | ${i.latest ? `\`${i.latest}\`` : "—"} | ${mark} |`);
  }
  if (uncovered.length) {
    lines.push("");
    lines.push("### What to do");
    for (const i of uncovered) {
      const a = attemptFor(i);
      lines.push(`- **${i.name}** → \`${i.latest}\`: ${a ? `no PR was opened because ${a.reason ?? a.error ?? "its preparation failed"}.` : "no PR was attempted."}`);
      if (i.action) { for (const l of i.action.split("\n")) { lines.push(`  ${l.trim()}`); } }
      if (a?.report) { lines.push("", "<details><summary>Report</summary>", "", a.report.trim(), "", "</details>", ""); }
    }
  }
  if (critical.length) {
    lines.push("");
    lines.push("### :rotating_light: Supply chain");
    for (const c of critical) { lines.push(`- ${c}`); }
  }
  lines.push("");
  lines.push(`<sub>Checked ${report.checkedAt}. Reproduce locally: \`node scripts/check-currency.mjs\`.</sub>`);
  lines.push("");
  lines.push(`<!-- ${MARKER} ${JSON.stringify({ stale: uncovered.map((i) => i.name) })} -->`);
  return lines.join("\n");
}

/** Exit non-zero, with one annotation per reason so the run summary says what is stuck. */
function failRun() {
  const esc = (t) => String(t).replace(/%/g, "%25").replace(/\r/g, "%0D").replace(/\n/g, "%0A");
  for (const i of uncovered) {
    const a = attemptFor(i);
    console.log(`::error title=${esc(`${i.name} is behind at ${i.latest} with no PR`)}::${esc(a ? (a.reason ?? a.error ?? "its preparation failed") : "no PR was attempted")}`);
  }
  for (const c of critical) { console.log(`::error title=Supply-chain finding::${esc(c)}`); }
  process.exit(1);
}

const existing = findOpenIssue();

if (!actionable) {
  if (existing) {
    const prs = stale.map(prFor).filter(Boolean);
    gh(["issue", "comment", String(existing.number), "--body", prs.length
      ? `Every target is either current or has a PR: ${prs.map((p) => p.url).join(", ")}. Closing; the workflow opens a new issue if a bump cannot be prepared.`
      : "Everything we target is current again — closing. The workflow will reopen this if that changes."]);
    gh(["issue", "close", String(existing.number)]);
    console.log(`Closed #${existing.number}: current with upstream.`);
  } else {
    console.log(stale.length ? "Every stale target has a PR; no issue to open." : "Current with upstream; no issue to open.");
  }
  process.exit(0);
}

const body = buildBody();

if (!existing) {
  ensureLabel();
  const out = gh(["issue", "create", "--title", TITLE, "--label", LABEL, "--body", body]);
  console.log(`Opened an issue for: ${uncovered.map((i) => i.name).join(", ") || "supply-chain findings"}`);
  if (out.trim()) { console.log(out.trim()); }
  failRun();
}

// Update in place (silent), then notify only about what is new since last run.
gh(["issue", "edit", String(existing.number), "--body", body]);
const was = previousStale(existing.body);
const newly = uncovered.filter((i) => !was.has(i.name));
if (newly.length) {
  gh(["issue", "comment", String(existing.number), "--body",
      `New since the last check:\n\n${newly.map((i) => `- **${i.name}** is now behind at \`${i.latest}\``).join("\n")}`]);
  console.log(`Updated #${existing.number} and commented about: ${newly.map((i) => i.name).join(", ")}`);
} else {
  console.log(`Updated #${existing.number} in place; nothing newly stale, so no comment.`);
}
failRun();
