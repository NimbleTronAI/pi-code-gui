// Turn a prepared upstream bump into a pull request — the Dependabot-shaped half of
// .github/workflows/upstream-currency.yml.
//
//   node scripts/upstream-pr.mjs open --target pi-ai --version 1.6.0 --dir <prepared> [--out prs.json] [--dry-run]
//        [--sdk-version 1.6.0 --sdk-dir <prepared SDK>]   pi-ai only: what its release note may claim was tested
//   node scripts/upstream-pr.mjs set-sdk-version 1.6.0 --summary "22/22 checks"
//
// WHY A PR, WHEN THIS USED TO BE AN ISSUE: the issue said what moved and what to run, then sat
// until someone ran it. Both bumps it described are now done on the runner — pi-ai is regenerated
// and its price changes tabled (scripts/registry-diff.mjs); the Pi SDK is exercised for real
// (scripts/live-sdk-check.mjs). What is left for a human is the review, and a PR is where reviews
// happen. The issue is kept only for what no PR can carry: a bump whose preparation failed, and
// supply-chain findings. See agent-wiki/operations/upstream-bump-prs.md.
//
// TRUST SPLIT: the jobs that run upstream code (pnpm add, the generator, the live check) have a
// READ-ONLY token and hand over a patch. This script runs in the job that can push, and it never
// installs or imports upstream code: it checks the patch touches only the files its target owns,
// applies it, and talks to git and gh.
//
// SIGNED COMMITS: main requires signed commits, and a `git commit` on a runner is unsigned, so a
// bot PR built that way could never merge. The commit is therefore built locally (to get its
// exact tree) and then created through GitHub's git-data API, which GitHub signs for a bot token
// as long as the request names NO custom author or committer. The author is therefore the org's
// bot App (`<slug>[bot]`), which must be on the bypass list of the org ruleset
// `nimbletron-author-email`, or the branch update is refused and the issue says so. The workflow
// passes the App's token as GH_TOKEN and its slug as UPSTREAM_BOT_SLUG.
//
// "Prepared" directory, written by the workflow's prepare jobs:
//   change.patch   git diff of the bump (absent or empty: nothing to propose)
//   status.json    { "ready": bool, "reason": "…" }   ready=false → a DRAFT PR, or no PR without a patch
//   report.md      the review material (catalog diff / live-check table)
//   checks.md      optional: build/test results from the prepare job

import { readFileSync, writeFileSync, existsSync, appendFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
export const LABEL = "upstream-currency";
/** Whether a commit author is the bot App: `<user id>+<slug>[bot]@users.noreply.github.com`.
 *  Anyone else on a bot branch makes it hands-off. */
export function isBotAuthor(email, slug) {
  if (!slug) { return false; }
  const s = slug.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\d+\\+${s}\\[bot\\]@users\\.noreply\\.github\\.com$`).test(email);
}
const WORKFLOW = "`.github/workflows/upstream-currency.yml`";

export const TARGETS = {
  "pi-ai": {
    title: (v) => `Refresh the model catalog to pi-ai ${v}`,
    paths: ["package.json", "pnpm-lock.yaml", "src/model-registry.generated.json"],
    // The catalog ships inside the extension, so this is a release: bump the version (release.yml
    // tags it on merge) and say so in the changelog, which is user-visible by our own rule.
    releases: true,
    // `sdk`: the pi-coding-agent release this one was tested against (see sdkTestedFor), so the
    // release note says it, as 0.2.8's did.
    changelogLine: (v, sdk) => `- **Model catalog refreshed to pi-ai ${v}**, with its current models and prices${sdk ? `, and tested against pi-coding-agent ${sdk}` : ""}.`,
    intro: (v) => [
      `Moves the bundled model catalog to **pi-ai ${v}**: the \`@earendil-works/pi-ai\` devDependency, a regenerated`,
      "`src/model-registry.generated.json` (`pnpm run gen:model-registry`), a patch version bump and a CHANGELOG line,",
      "so merging this releases it.",
      "",
      "The price changes are tabled below for the record. :warning: marks a move of 2x or more, or to or from free.",
    ],
  },
  "pi-coding-agent": {
    title: (v) => `Record pi-coding-agent ${v} as tested`,
    paths: ["src/pi-sdk-version.json"],
    // Pins nothing at runtime (the extension loads whatever Pi the user installed), so no release.
    releases: false,
    intro: (v) => [
      `Moves \`testedAgainst\` in \`src/pi-sdk-version.json\` to **pi-coding-agent ${v}**. This changes nothing that ships;`,
      `it records that the extension ran on ${v}, and the live check below is that run: the real \`PiService\` and`,
      "`SdkService` against the released SDK on the runner, with pi-ai's scripted (faux) provider standing in for a vendor model.",
      "",
      `Upstream's changelog: https://github.com/earendil-works/pi/releases/tag/v${v}`,
    ],
  },
};

const target = (id) => { const t = TARGETS[id]; if (!t) { throw new Error(`unknown target: ${id}`); } return t; };

// ── pure helpers (unit-tested in scripts/test/upstream-pr.test.mjs) ─────────

export function branchName(id, version) { target(id); return `upstream/${id}-${version}`; }

/** Bump the LAST numeric part of the top-level "version", touching nothing else in the file. */
export function bumpPatchVersion(text) {
  const m = text.match(/"version"\s*:\s*"([^"]+)"/);
  if (!m) { throw new Error("package.json has no version"); }
  const parts = m[1].split(".");
  parts[parts.length - 1] = String(Number(parts[parts.length - 1]) + 1);
  const to = parts.join(".");
  return { from: m[1], to, text: text.replace(/("version"\s*:\s*")[^"]+(")/, `$1${to}$2`) };
}

/** Add `line` under `## [version]` → `### Changed`, creating either as needed. Idempotent. */
export function addChangelogEntry(text, version, line) {
  if (text.includes(line)) { return text; }
  const heading = `## [${version}]`;
  const firstSection = text.search(/^## \[/m);
  if (!text.includes(heading)) {
    const block = `${heading}\n\n### Changed\n${line}\n\n`;
    return firstSection < 0 ? `${text.trimEnd()}\n\n${block}` : text.slice(0, firstSection) + block + text.slice(firstSection);
  }
  const start = text.indexOf(heading);
  const nextRel = text.slice(start + heading.length).search(/^## \[/m);
  const end = nextRel < 0 ? text.length : start + heading.length + nextRel;
  let section = text.slice(start, end);
  const lines = section.split("\n");
  const changed = lines.indexOf("### Changed");
  if (changed >= 0) {
    // Append after the last bullet of the existing Changed list (bullets and their indented
    // continuation lines), leaving whatever follows — blank line, next heading — untouched.
    let at = changed + 1;
    while (at < lines.length && (lines[at].startsWith("- ") || /^\s+\S/.test(lines[at]))) { at++; }
    lines.splice(at, 0, line);
    section = lines.join("\n");
  } else {
    section = `${heading}\n\n### Changed\n${line}\n\n` + section.slice(heading.length).replace(/^\n+/, "");
  }
  return text.slice(0, start) + section + text.slice(end);
}

/** Paths in a prepared patch that its target does not own. Non-empty → refuse the patch. */
export function disallowedPaths(id, paths) {
  const allowed = new Set(target(id).paths);
  return paths.filter((p) => !allowed.has(p));
}

/** Open bot PRs for the same target at another version: a newer release replaces them. */
export function supersededPrs(openPrs, id, branch) {
  const prefix = `upstream/${id}-`;
  return openPrs.filter((p) => p.headRefName.startsWith(prefix) && p.headRefName !== branch);
}

export function setTestedAgainst(jsonText, version, date, summary) {
  const o = JSON.parse(jsonText);
  o.testedAgainst = version;
  o.verifiedBy = `scripts/live-sdk-check.mjs on ${date} (${summary}), run by upstream-currency.yml`;
  return JSON.stringify(o, null, 2) + "\n";
}

/** Which pi-coding-agent release a pi-ai PR can say it was tested against: the latest SDK, if
 *  its live check passed in THIS run (its own PR may still be open; merge order does not change
 *  what is true), otherwise what main records. Null when neither is known. */
export function sdkTestedFor({ sdkVersion, sdkReady, mainTested }) {
  if (sdkVersion && sdkReady) { return { version: sdkVersion, source: "run" }; }
  return mainTested ? { version: mainTested, source: "main" } : null;
}

/** Whether a bot PR merges itself once CI passes: always, except a draft (a failed check opens
 *  one, and GitHub cannot merge a draft). Founder's call, 2026-11-24: no hold for price moves. */
export function autoMergeDecision(id, { ready } = {}) {
  if (!ready) { return { auto: false, why: "not every check passed, so it is a draft" }; }
  return { auto: true, why: id === "pi-ai" ? "every check passed" : "the live check passed" };
}

export function composeBody(id, version, { ready, reason, report, checks, handsOff, sdkTested, autoMerge } = {}) {
  const t = target(id);
  const L = [...t.intro(version), ""];
  if (autoMerge) {
    L.push(autoMerge.auto
      ? `**Auto-merge is on** (${autoMerge.why}): this merges by itself once CI passes${target(id).releases ? ", and merging it releases" : ""}. To stop it, disable auto-merge on this PR.`
      : `**Waiting for your review:** ${autoMerge.why}.`, "");
  }
  if (id === "pi-ai" && sdkTested) {
    L.push(sdkTested.source === "run"
      ? `The release note says *tested against pi-coding-agent ${sdkTested.version}*: its live check passed in this run, and its own PR records that. **Merge the two in either order**; the note is true either way.`
      : `The release note says *tested against pi-coding-agent ${sdkTested.version}*, the release main records as tested.`, "");
  }
  if (!ready) {
    L.push(`> [!WARNING]`, `> **Opened as a draft:** ${reason ?? "the prepare job did not pass"}. Fix it on this branch, then mark it ready.`, "");
  }
  if (handsOff) {
    L.push(`> [!NOTE]`, "> This branch has commits from someone other than the bot, so the bot has stopped rebuilding it. Only this description is still updated.", "");
  }
  if (checks?.trim()) { L.push("### Checks on the runner", "", checks.trim(), ""); }
  if (report?.trim()) { L.push(`### ${id === "pi-ai" ? "Catalog changes" : "Live check"}`, "", report.trim(), ""); }
  L.push("---",
    `<sub>Opened and maintained by ${WORKFLOW}, like a Dependabot PR. Each weekly run rebuilds this branch on the latest`,
    `main and rewrites this description; a newer upstream release closes it in favour of a new PR. Once you push your`,
    `own commit here the bot leaves the branch alone.</sub>`);
  return L.join("\n");
}

/** `git diff --raw --no-abbrev base head` → tree entries for GitHub's create-a-tree API. A deleted
 *  file is an entry with sha null; anything that is not a regular file is refused, since no target
 *  of this script owns one and a mode change there would be surprising. */
export function treeEntriesFromRaw(raw) {
  const entries = [];
  for (const line of raw.split("\n").filter(Boolean)) {
    const m = line.match(/^:(\d{6}) (\d{6}) ([0-9a-f]{40}) ([0-9a-f]{40}) ([AMD])\t(.+)$/);
    if (!m) { throw new Error(`unexpected change in the bot commit: ${line}`); }
    const [, oldMode, newMode, , newSha, kind, path] = m;
    const mode = kind === "D" ? oldMode : newMode;
    if (mode !== "100644" && mode !== "100755") { throw new Error(`refusing a non-file change to ${path} (mode ${mode})`); }
    entries.push(kind === "D" ? { path, mode, type: "blob", sha: null } : { path, mode, type: "blob", sha: newSha });
  }
  return entries;
}

// ── side effects ─────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : undefined; };
const DRY = argv.includes("--dry-run");

function run(cmd, args, { allowFail = false, mutates = false, env } = {}) {
  if (DRY && mutates) { console.log(`[dry-run] ${cmd} ${args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a)).join(" ")}`); return ""; }
  try {
    return execFileSync(cmd, args, { cwd: ROOT, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], ...(env ? { env: { ...process.env, ...env } } : {}) });
  } catch (e) {
    if (allowFail) { return null; }
    throw new Error(`${cmd} ${args.slice(0, 3).join(" ")} failed: ${e.stderr || e.message}`);
  }
}
const git = (args, o) => run("git", args, o);
const gh = (args, o) => run("gh", args, o);
const readMaybe = (p) => (existsSync(p) ? readFileSync(p, "utf8") : "");
const REPO = process.env.GITHUB_REPOSITORY || "{owner}/{repo}";
/** A JSON POST/PATCH through `gh api`. The body goes in a file: the catalog is ~350KB, past what a
 *  single command-line argument may hold. */
function api(method, path, body) {
  const f = join(process.env.RUNNER_TEMP || tmpdir(), `upstream-pr-api-${process.pid}.json`);
  writeFileSync(f, JSON.stringify(body));
  return JSON.parse(gh(["api", "-X", method, `repos/${REPO}/${path}`, "--input", f]));
}

/** Recreate the local HEAD commit on GitHub as a SIGNED commit, and point `branch` at it. */
export function publishSigned(branch, remoteExists) {
  const parent = git(["rev-parse", "origin/main"]).trim();
  const localTree = git(["rev-parse", "HEAD^{tree}"]).trim();
  const message = git(["log", "-1", "--format=%B"]).trim();
  const entries = treeEntriesFromRaw(git(["diff", "--raw", "--no-abbrev", "--no-renames", "origin/main", "HEAD"]));
  for (const e of entries.filter((x) => x.sha)) {
    const content = execFileSync("git", ["cat-file", "blob", e.sha], { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 }).toString("base64");
    const blob = api("POST", "git/blobs", { content, encoding: "base64" });
    if (blob.sha !== e.sha) { throw new Error(`GitHub stored ${e.path} as ${blob.sha}, expected ${e.sha}`); }
  }
  const baseTree = git(["rev-parse", "origin/main^{tree}"]).trim();
  const tree = api("POST", "git/trees", { base_tree: baseTree, tree: entries });
  // Same content ⇒ same tree hash. A mismatch means the API commit would not be what was checked.
  if (tree.sha !== localTree) { throw new Error(`the tree built on GitHub (${tree.sha}) differs from the local one (${localTree})`); }
  // No author/committer fields: naming either makes GitHub skip the signature.
  const commit = api("POST", "git/commits", { message, tree: tree.sha, parents: [parent] });
  if (!commit.verification?.verified) {
    throw new Error(`GitHub did not sign the bot commit (${commit.verification?.reason ?? "no verification info"}), and main requires signed commits`);
  }
  if (remoteExists) { api("PATCH", `git/refs/heads/${branch}`, { sha: commit.sha, force: true }); }
  else { api("POST", "git/refs", { ref: `refs/heads/${branch}`, sha: commit.sha }); }
  return commit.sha;
}

function openPr() {
  const id = flag("--target"), version = flag("--version"), dir = flag("--dir"), out = flag("--out");
  if (!id || !version || !dir) { throw new Error("open needs --target, --version and --dir"); }
  const t = target(id);
  // For the pi-ai release note: the SDK this run prepared (--sdk-version, --sdk-dir), else main's.
  const sdkDir = flag("--sdk-dir");
  const sdkStatus = sdkDir && existsSync(join(sdkDir, "status.json")) ? JSON.parse(readFileSync(join(sdkDir, "status.json"), "utf8")) : null;
  const sdkTested = id === "pi-ai" ? sdkTestedFor({
    sdkVersion: flag("--sdk-version"), sdkReady: !!sdkStatus?.ready,
    mainTested: JSON.parse(readFileSync(join(ROOT, "src", "pi-sdk-version.json"), "utf8")).testedAgainst,
  }) : null;
  const branch = branchName(id, version);
  const status = existsSync(join(dir, "status.json")) ? JSON.parse(readFileSync(join(dir, "status.json"), "utf8")) : { ready: false, reason: "the prepare job wrote no status" };
  const patchPath = join(dir, "change.patch");
  const patch = readMaybe(patchPath);
  const record = (r) => {
    const row = { target: id, version, branch, ...r };
    console.log(JSON.stringify(row));
    if (out) { appendFileSync(out, JSON.stringify(row) + "\n"); }
  };

  if (!patch.trim()) {
    // Nothing to propose (e.g. the live check failed, so testedAgainst must not move). The issue
    // reporter turns this row into an issue entry with the reason.
    record({ state: "skipped", reason: status.reason ?? "no change was prepared", report: readMaybe(join(dir, "report.md")).slice(0, 6000) });
    return;
  }

  const touched = git(["apply", "--numstat", patchPath]).trim().split("\n").filter(Boolean).map((l) => l.split("\t")[2]);
  const bad = disallowedPaths(id, touched);
  if (bad.length) { throw new Error(`refusing a ${id} patch that touches ${bad.join(", ")} (allowed: ${t.paths.join(", ")})`); }

  const slug = process.env.UPSTREAM_BOT_SLUG;
  if (!slug && !DRY) { throw new Error("UPSTREAM_BOT_SLUG is not set (the bot App's slug, from actions/create-github-app-token)"); }
  // Identity for the LOCAL commit only, which is never pushed: GitHub recreates it, signed, as the App.
  git(["config", "user.name", `${slug ?? "upstream-bot"}[bot]`], { mutates: true });
  git(["config", "user.email", "upstream-bot@localhost"], { mutates: true });
  git(["fetch", "--quiet", "origin", "main"]);
  const remoteExists = git(["ls-remote", "--exit-code", "--heads", "origin", branch], { allowFail: true }) !== null;
  if (remoteExists) { git(["fetch", "--quiet", "origin", `+refs/heads/${branch}:refs/remotes/origin/${branch}`]); }

  // A human pushed to this branch → stop rebuilding it; only the description is refreshed.
  const foreign = remoteExists
    ? git(["log", "--format=%ae", `origin/main..origin/${branch}`]).trim().split("\n").filter((e) => e && !isBotAuthor(e, slug))
    : [];
  const handsOff = foreign.length > 0;

  let pushed = false;
  if (!handsOff) {
    git(["checkout", "--quiet", "-B", branch, "origin/main"], { mutates: true });
    git(["apply", "--index", patchPath], { mutates: true });
    let msg = t.title(version);
    if (t.releases && !DRY) {
      const pkg = bumpPatchVersion(readFileSync(join(ROOT, "package.json"), "utf8"));
      writeFileSync(join(ROOT, "package.json"), pkg.text);
      const cl = join(ROOT, "CHANGELOG.md");
      writeFileSync(cl, addChangelogEntry(readFileSync(cl, "utf8"), pkg.to, t.changelogLine(version, sdkTested?.version)));
      git(["add", "package.json", "CHANGELOG.md"]);
      msg += `\n\nVersion ${pkg.from} -> ${pkg.to}.`;
    }
    git(["commit", "--quiet", "-m", `${msg}\n\nOpened by .github/workflows/upstream-currency.yml.`], { mutates: true });

    // Unchanged since last week (same content, already on top of main) → don't force-push: that
    // would re-run CI and dismiss reviews for nothing.
    const sameContent = remoteExists && !DRY && git(["diff", "--quiet", `origin/${branch}`, "HEAD"], { allowFail: true }) !== null;
    const onMain = remoteExists && git(["merge-base", "--is-ancestor", "origin/main", `origin/${branch}`], { allowFail: true }) !== null;
    if (!(sameContent && onMain)) {
      if (DRY) { console.log(`[dry-run] publish a signed commit to ${branch}`); }
      else { console.log(`${branch} → ${publishSigned(branch, remoteExists)} (signed)`); }
      pushed = true;
    }
  }

  const autoMerge = autoMergeDecision(id, { ready: status.ready });
  const body = composeBody(id, version, { ...status, report: readMaybe(join(dir, "report.md")), checks: readMaybe(join(dir, "checks.md")), handsOff, sdkTested, autoMerge });
  const bodyFile = join(process.env.RUNNER_TEMP || tmpdir(), `upstream-pr-${id}.md`);
  writeFileSync(bodyFile, body);

  gh(["label", "create", LABEL, "--color", "0E8A16", "--description", "A project this extension targets has released a newer version"], { allowFail: true, mutates: true });
  const open = JSON.parse(gh(["pr", "list", "--state", "open", "--label", LABEL, "--limit", "50", "--json", "number,headRefName,url,isDraft"]) || "[]");
  const mine = open.find((p) => p.headRefName === branch);
  let number, url, state;
  if (mine) {
    ({ number, url } = mine);
    gh(["pr", "edit", String(number), "--title", t.title(version), "--body-file", bodyFile], { mutates: true });
    if (status.ready && mine.isDraft) { gh(["pr", "ready", String(number)], { mutates: true }); }
    if (!status.ready && !mine.isDraft && !handsOff) { gh(["pr", "ready", String(number), "--undo"], { mutates: true }); }
    state = pushed ? "updated" : "unchanged";
  } else {
    const created = gh(["pr", "create", "--base", "main", "--head", branch, "--title", t.title(version), "--body-file", bodyFile,
      "--label", LABEL, ...(status.ready ? [] : ["--draft"])], { mutates: true }) ?? "";
    url = created.trim().split("\n").pop() || null;
    number = Number(url?.match(/\/pull\/(\d+)/)?.[1]) || null;
    state = "opened";
  }

  for (const old of supersededPrs(open, id, branch)) {
    gh(["pr", "close", String(old.number), "--delete-branch", "--comment", `Superseded by ${url ?? `the ${version} PR`}: upstream released ${version}.`], { mutates: true });
  }

  // No CI kick needed: the App's branch update and PR events trigger ci.yml like anyone else's.

  // Auto-merge. main needs one approval and a PR's author cannot approve it, so the workflow's own
  // token (APPROVER_TOKEN) approves — new content only; main keeps approvals across pushes — and
  // the App enables auto-merge, so the merge itself is the App's and triggers release.yml.
  if (number) {
    if (autoMerge.auto) {
      if (state === "opened" || pushed) {
        if (!process.env.APPROVER_TOKEN && !DRY) { throw new Error("APPROVER_TOKEN is not set, so the PR cannot be approved for auto-merge"); }
        gh(["pr", "review", String(number), "--approve", "--body", `Approved for auto-merge: ${autoMerge.why}.`], { mutates: true, env: { GH_TOKEN: process.env.APPROVER_TOKEN } });
      }
      gh(["pr", "merge", String(number), "--auto", "--merge"], { mutates: true });
    } else if (mine) {
      gh(["pr", "merge", String(number), "--disable-auto"], { mutates: true, allowFail: true });   // fails when it was never on
    }
  }

  record({ state, number, url, draft: !status.ready, handsOff, autoMerge: autoMerge.auto, autoMergeWhy: autoMerge.why });
}

function setSdkVersion() {
  const version = argv[1];
  const summary = flag("--summary") ?? "live check passed";
  if (!version) { throw new Error("set-sdk-version needs a version"); }
  const p = join(ROOT, "src", "pi-sdk-version.json");
  writeFileSync(p, setTestedAgainst(readFileSync(p, "utf8"), version, new Date().toISOString().slice(0, 10), summary));
  console.log(`src/pi-sdk-version.json: testedAgainst → ${version}`);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  try {
    if (argv[0] === "open") { openPr(); }
    else if (argv[0] === "set-sdk-version") { setSdkVersion(); }
    else { console.error("usage: upstream-pr.mjs open --target <id> --version <v> --dir <prepared> [--out f] [--dry-run]\n       upstream-pr.mjs set-sdk-version <v> [--summary s]"); process.exit(2); }
  } catch (e) {
    console.error(e.message);
    // A failed `open` still leaves a row, so the issue reporter can say WHY there is no PR
    // (most often: the org ruleset refused the branch, or the bot App lacks a permission).
    const out = flag("--out");
    if (argv[0] === "open" && out) {
      appendFileSync(out, JSON.stringify({ target: flag("--target"), version: flag("--version"), state: "skipped", reason: `opening the PR failed: ${e.message.slice(0, 500)}` }) + "\n");
    }
    process.exit(1);
  }
}
