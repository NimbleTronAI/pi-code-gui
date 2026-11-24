// Keep one "Release X" pull request open while main carries Dependabot updates that have not shipped.
//
//   node scripts/release-pr.mjs [--dry-run]      ← needs git (full history + tags), gh, and in CI:
//        GH_TOKEN (the bot App), APPROVER_TOKEN (the workflow's GITHUB_TOKEN), UPSTREAM_BOT_SLUG
//
// WHY: Dependabot PRs used to get a version-bump commit on their own branch, so merging each one
// released. Two problems: every open Dependabot PR edits the same version line, so the second one
// conflicted as soon as the first merged; and Dependabot refuses to rebase a branch carrying someone
// else's commit, so it stayed stuck (#113, 2026-11-24). Now Dependabot PRs never touch the version.
// After one merges, this script opens (or refreshes) a single PR on `release/next` that bumps the
// patch version on top of main, and sets it to auto-merge. Merging it releases (release.yml), and
// everything that landed in the meantime rides along — one release per batch, not one per PR.
//
// WHAT COUNTS: a Dependabot merge into main since the current version's tag that changed
// package.json or pnpm-lock.yaml — what the packaged extension is built from. Actions and dev
// container updates ship nothing, so they do not start a release on their own.
//
// NO VERSION IN NAMES: the branch is always `release/next`; the version is read from main's
// package.json each time, so a hand bump to 0.3.0 makes the next automatic release 0.3.1.

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { bumpPatchVersion, publishSigned } from "./upstream-pr.mjs";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const BRANCH = "release/next";
const LABEL = "release";
const SHIPPING_FILES = ["package.json", "pnpm-lock.yaml"];

/** From `git log --first-parent --merges` entries ({ sha, subject, files }), the Dependabot merges
 *  that change what the extension is built from. Merge-queue and button merges both produce
 *  "Merge pull request #N from <owner>/<branch>". */
export function shippingDependabotMerges(entries) {
  return entries
    .map((e) => ({ ...e, m: e.subject.match(/^Merge pull request #(\d+) from [^/\s]+\/(dependabot\/\S+)/) }))
    .filter((e) => e.m && e.files.some((f) => SHIPPING_FILES.includes(f)))
    .map((e) => ({ sha: e.sha, number: Number(e.m[1]), branch: e.m[2] }));
}

export function composeReleaseBody(version, since, merges) {
  return [
    `Releases **${version}**: the dependency updates merged since \`${since}\`, which have not shipped yet.`,
    "",
    ...merges.map((m) => `- #${m.number} (\`${m.branch}\`)`),
    "",
    "**Auto-merge is on:** this merges by itself once CI passes, and merging it releases. To hold the release,",
    "disable auto-merge on this PR.",
    "",
    "---",
    "<sub>Opened and maintained by `.github/workflows/release-pr.yml` (`scripts/release-pr.mjs`). It is rebuilt on",
    "top of main after every push there, so later merges ride along, and closed if a release ships them first.</sub>",
  ].join("\n");
}

// ── side effects ─────────────────────────────────────────────────────

const DRY = process.argv.includes("--dry-run");
function run(cmd, args, { allowFail = false, mutates = false, env } = {}) {
  if (DRY && mutates) { console.log(`[dry-run] ${cmd} ${args.join(" ")}`); return ""; }
  try {
    return execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...(env ? { env: { ...process.env, ...env } } : {}) });
  } catch (e) {
    if (allowFail) { return null; }
    throw new Error(`${cmd} ${args.slice(0, 3).join(" ")} failed: ${e.stderr || e.message}`);
  }
}
const git = (a, o) => run("git", a, o);
const gh = (a, o) => run("gh", a, o);

function main() {
  git(["fetch", "--quiet", "--tags", "origin", "main"]);
  const pkgText = git(["show", "origin/main:package.json"]);
  const { from: current, to: next, text: bumped } = bumpPatchVersion(pkgText);
  const tag = `v${current}`;
  const openPr = () => JSON.parse(gh(["pr", "list", "--state", "open", "--head", BRANCH, "--json", "number,url"]) || "[]")[0] ?? null;

  // The current version is not tagged yet: release.yml is about to ship it, and with it everything
  // on main. Nothing for this script to add.
  if (git(["ls-remote", "--exit-code", "--tags", "origin", `refs/tags/${tag}`], { allowFail: true }) === null) {
    console.log(`${tag} is not released yet; its release ships everything on main.`);
    return;
  }

  const log = git(["log", "--first-parent", "--merges", "--format=%H%x09%s", `${tag}..origin/main`]).trim();
  const entries = log ? log.split("\n").map((l) => {
    const [sha, subject] = l.split("\t");
    const files = git(["diff", "--name-only", `${sha}^1`, sha]).trim().split("\n").filter(Boolean);
    return { sha, subject, files };
  }) : [];
  const merges = shippingDependabotMerges(entries);
  const existing = openPr();

  if (!merges.length) {
    if (existing) {
      gh(["pr", "close", String(existing.number), "--delete-branch", "--comment", `Nothing left to release: no Dependabot update has merged since ${tag}.`], { mutates: true });
      console.log(`Closed #${existing.number}: nothing unreleased since ${tag}.`);
    } else {
      console.log(`No Dependabot update to release since ${tag}.`);
    }
    return;
  }

  // Build main + the bump locally, then publish it as a signed commit by the App.
  const slug = process.env.UPSTREAM_BOT_SLUG;
  if (!slug && !DRY) { throw new Error("UPSTREAM_BOT_SLUG is not set (the bot App's slug)"); }
  git(["config", "user.name", `${slug ?? "release-bot"}[bot]`], { mutates: true });
  git(["config", "user.email", "release-bot@localhost"], { mutates: true });
  git(["checkout", "--quiet", "-B", BRANCH, "origin/main"], { mutates: true });
  if (!DRY) { writeFileSync(join(ROOT, "package.json"), bumped); }
  // Only package.json: the release commit must never pick up anything else in the work tree.
  git(["add", "package.json"], { mutates: true });
  git(["commit", "--quiet", "-m", `Release ${next}\n\nShips ${merges.map((m) => `#${m.number}`).join(", ")}.`], { mutates: true });

  const remoteExists = git(["ls-remote", "--exit-code", "--heads", "origin", BRANCH], { allowFail: true }) !== null;
  if (remoteExists) { git(["fetch", "--quiet", "origin", `+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}`]); }
  const sameContent = remoteExists && !DRY && git(["diff", "--quiet", `origin/${BRANCH}`, "HEAD"], { allowFail: true }) !== null;
  const onMain = remoteExists && git(["merge-base", "--is-ancestor", "origin/main", `origin/${BRANCH}`], { allowFail: true }) !== null;
  let pushed = false;
  if (!(sameContent && onMain)) {
    if (DRY) { console.log(`[dry-run] publish a signed "Release ${next}" commit to ${BRANCH}`); }
    else { console.log(`${BRANCH} → ${publishSigned(BRANCH, remoteExists)} (signed)`); }
    pushed = true;
  }

  const bodyFile = join(process.env.RUNNER_TEMP || tmpdir(), "release-pr.md");
  writeFileSync(bodyFile, composeReleaseBody(next, tag, merges));
  let number;
  if (existing) {
    number = existing.number;
    gh(["pr", "edit", String(number), "--title", `Release ${next}`, "--body-file", bodyFile], { mutates: true });
  } else {
    gh(["label", "create", LABEL, "--color", "5319E7", "--description", "Bumps the version; merging it releases"], { allowFail: true, mutates: true });
    const url = (gh(["pr", "create", "--base", "main", "--head", BRANCH, "--title", `Release ${next}`, "--body-file", bodyFile, "--label", LABEL], { mutates: true }) ?? "").trim().split("\n").pop();
    number = Number(url?.match(/\/pull\/(\d+)/)?.[1]) || null;
  }

  // Same arrangement as the upstream PRs: the workflow's token approves (a PR's author cannot), the
  // App enables auto-merge, so the merge is the App's and triggers release.yml.
  if (number) {
    if (pushed || !existing) {
      if (!process.env.APPROVER_TOKEN && !DRY) { throw new Error("APPROVER_TOKEN is not set, so the release PR cannot be approved"); }
      gh(["pr", "review", String(number), "--approve", "--body", `Approved for auto-merge: releases ${merges.length} dependency update(s).`], { mutates: true, env: { GH_TOKEN: process.env.APPROVER_TOKEN } });
    }
    gh(["pr", "merge", String(number), "--auto", "--merge"], { mutates: true });
  }
  console.log(`Release ${next}: #${number ?? "?"} ships ${merges.map((m) => `#${m.number}`).join(", ")}${pushed ? "" : " (unchanged)"}.`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try { main(); } catch (e) { console.error(e.message); process.exit(1); }
}
