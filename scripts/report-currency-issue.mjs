// Turn `check-currency.mjs --json` into a GitHub ISSUE, and keep exactly one of them open.
//
//   node scripts/report-currency-issue.mjs currency.json     ← needs gh + GH_TOKEN
//   node scripts/report-currency-issue.mjs currency.json --dry-run
//
// WHY AN ISSUE AND NOT A PR: the two things we track cannot be bumped mechanically.
//
//   - pi_agent_rust is an out-of-process binary we speak a JSON-RPC contract to. 0.3.0 taught us
//     that a version bump is a protocol investigation, not an edit: commands appear, event
//     shapes move, and the extension gates UI on capability flags. A PR that changed `tag` in
//     src/rust-pi-version.json would LOOK mergeable and would not be, which is worse than no PR.
//   - pi-ai carries model PRICING. A bare bump leaves the generated registry stamped at the old
//     version and fails the build; the regenerated prices want a human look (0.86.1 moved 67 of
//     them). That is exactly why .github/dependabot.yml ignores it by name.
//
// So the deliverable is a short issue that says what moved and what to do about it. Dependabot
// cannot do this job at all: it reads manifests, and neither a GitHub release pinned in a JSON
// file nor a globally-installed npm package is a manifest dependency.
//
// NOTIFICATION DISCIPLINE: editing an issue body is silent on GitHub, while a comment notifies.
// So the body is rewritten on every run (always current, never spam) and a comment is posted
// only when something NEWLY goes stale. The previous state rides along in an HTML comment in the
// body, which is how "newly" is known without any external store.

import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

const [, , jsonPath, ...flags] = process.argv;
const DRY = flags.includes("--dry-run");
if (!jsonPath) {
  console.error("usage: report-currency-issue.mjs <currency.json> [--dry-run]");
  process.exit(2);
}

const LABEL = "upstream-currency";
const TITLE = "Upstream: a project we target has released";
const MARKER = "currency-state:";

const report = JSON.parse(readFileSync(jsonPath, "utf8"));

/** Anything worth an open issue: a stale target, or a CRITICAL supply-chain finding. */
const stale = report.items.filter((i) => i.state === "stale");
const critical = report.supplyChain?.critical ?? [];
const actionable = stale.length > 0 || critical.length > 0;

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
    const mark = i.state === "stale" ? "**behind**" : i.state === "unreachable" ? "unreachable" : "current";
    lines.push(`| ${i.name} | \`${i.ours}\` | ${i.latest ? `\`${i.latest}\`` : "—"} | ${mark} |`);
  }
  if (stale.length) {
    lines.push("");
    lines.push("### What to do");
    for (const i of stale) {
      lines.push(`- **${i.name}** → \`${i.latest}\``);
      if (i.action) { for (const l of i.action.split("\n")) { lines.push(`  ${l.trim()}`); } }
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
  lines.push(`<!-- ${MARKER} ${JSON.stringify({ stale: stale.map((i) => i.name) })} -->`);
  return lines.join("\n");
}

const existing = findOpenIssue();

if (!actionable) {
  if (existing) {
    gh(["issue", "comment", String(existing.number), "--body",
        "Everything we target is current again — closing. The workflow will reopen this if that changes."]);
    gh(["issue", "close", String(existing.number)]);
    console.log(`Closed #${existing.number}: current with upstream.`);
  } else {
    console.log("Current with upstream; no issue to open.");
  }
  process.exit(0);
}

const body = buildBody();

if (!existing) {
  ensureLabel();
  const out = gh(["issue", "create", "--title", TITLE, "--label", LABEL, "--body", body]);
  console.log(`Opened an issue for: ${stale.map((i) => i.name).join(", ") || "supply-chain findings"}`);
  if (out.trim()) { console.log(out.trim()); }
  process.exit(0);
}

// Update in place (silent), then notify only about what is new since last run.
gh(["issue", "edit", String(existing.number), "--body", body]);
const was = previousStale(existing.body);
const newly = stale.filter((i) => !was.has(i.name));
if (newly.length) {
  gh(["issue", "comment", String(existing.number), "--body",
      `New since the last check:\n\n${newly.map((i) => `- **${i.name}** is now behind at \`${i.latest}\``).join("\n")}`]);
  console.log(`Updated #${existing.number} and commented about: ${newly.map((i) => i.name).join(", ")}`);
} else {
  console.log(`Updated #${existing.number} in place; nothing newly stale, so no comment.`);
}
