// Tests for the pure helpers in scripts/upstream-pr.mjs (the automated upstream-bump PRs).
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TARGETS, branchName, bumpPatchVersion, addChangelogEntry, disallowedPaths, supersededPrs, setTestedAgainst, composeBody, treeEntriesFromRaw, isBotAuthor,
} from "../upstream-pr.mjs";

test("one branch per target and version, so a new upstream release gets a new PR", () => {
  assert.equal(branchName("pi-ai", "1.6.0"), "upstream/pi-ai-1.6.0");
  assert.equal(branchName("pi-coding-agent", "1.6.1"), "upstream/pi-coding-agent-1.6.1");
  assert.throws(() => branchName("left-pad", "1.0.0"), /unknown target/);
});

test("bumpPatchVersion edits only the top-level version and keeps the rest of the file byte-identical", () => {
  const before = '{\n  "name": "x",\n  "version": "0.2.8",\n  "deps": { "y": { "version": "9.9.9" } }\n}\n';
  const r = bumpPatchVersion(before);
  assert.equal(r.from, "0.2.8");
  assert.equal(r.to, "0.2.9");
  assert.equal(r.text, before.replace('"0.2.8"', '"0.2.9"'));
});

test("addChangelogEntry opens a section for the new version above the released one", () => {
  const log = "# Change Log\n\n## [0.2.8]\n\n### Changed\n- old\n";
  const out = addChangelogEntry(log, "0.2.9", "- **new**");
  assert.equal(out, "# Change Log\n\n## [0.2.9]\n\n### Changed\n- **new**\n\n## [0.2.8]\n\n### Changed\n- old\n");
});

test("addChangelogEntry joins an existing section for that version instead of duplicating the heading", () => {
  const log = "# Change Log\n\n## [0.2.9]\n\n### Fixed\n- a fix\n\n## [0.2.8]\n";
  const out = addChangelogEntry(log, "0.2.9", "- **new**");
  assert.equal((out.match(/## \[0\.2\.9\]/g) ?? []).length, 1);
  assert.match(out, /## \[0\.2\.9\]\n\n### Changed\n- \*\*new\*\*\n\n### Fixed\n- a fix/);
});

test("addChangelogEntry appends to an existing Changed list in that section", () => {
  const log = "# Change Log\n\n## [0.2.9]\n\n### Changed\n- earlier\n\n## [0.2.8]\n";
  assert.match(addChangelogEntry(log, "0.2.9", "- **new**"), /### Changed\n- earlier\n- \*\*new\*\*\n\n## \[0\.2\.8\]/);
});

test("addChangelogEntry is idempotent: re-running a week later does not add the line twice", () => {
  const once = addChangelogEntry("# Change Log\n\n## [0.2.8]\n", "0.2.9", "- **new**");
  assert.equal(addChangelogEntry(once, "0.2.9", "- **new**"), once);
});

test("a prepared patch may only touch the files its target owns", () => {
  assert.deepEqual(disallowedPaths("pi-ai", ["package.json", "pnpm-lock.yaml", "src/model-registry.generated.json"]), []);
  assert.deepEqual(disallowedPaths("pi-ai", ["package.json", ".github/workflows/ci.yml"]), [".github/workflows/ci.yml"]);
  assert.deepEqual(disallowedPaths("pi-coding-agent", ["src/pi-sdk-version.json"]), []);
  assert.deepEqual(disallowedPaths("pi-coding-agent", ["package.json"]), ["package.json"]);
});

test("supersededPrs picks older bot PRs for the SAME target only", () => {
  const open = [
    { number: 1, headRefName: "upstream/pi-ai-1.5.3" },
    { number: 2, headRefName: "upstream/pi-ai-1.6.0" },
    { number: 3, headRefName: "upstream/pi-coding-agent-1.5.3" },
    { number: 4, headRefName: "feature/pi-ai-1.0.0" },
  ];
  assert.deepEqual(supersededPrs(open, "pi-ai", "upstream/pi-ai-1.6.0").map((p) => p.number), [1]);
});

test("setTestedAgainst moves the version and records how it was verified, keeping other fields", () => {
  const before = JSON.stringify({ _comment: "c", datasource: "npm", package: "@earendil-works/pi-coding-agent", testedAgainst: "1.5.2" }, null, 2) + "\n";
  const out = JSON.parse(setTestedAgainst(before, "1.6.0", "2026-11-24", "22/22 checks"));
  assert.equal(out.testedAgainst, "1.6.0");
  assert.equal(out.datasource, "npm");
  assert.equal(out._comment, "c");
  assert.match(out.verifiedBy, /live-sdk-check\.mjs.*2026-11-24.*22\/22/);
});

test("every target has a title, a branch prefix and an allowlist", () => {
  for (const [id, t] of Object.entries(TARGETS)) {
    assert.ok(t.title("1.0.0").includes("1.0.0"), id);
    assert.ok(t.paths.length > 0, id);
  }
});

test("the PR body says what to review, includes the prepared report, and marks itself as bot-maintained", () => {
  const body = composeBody("pi-ai", "1.6.0", { ready: true, report: "REPORT-TEXT", checks: "CHECKS-TEXT" });
  assert.match(body, /REPORT-TEXT/);
  assert.match(body, /CHECKS-TEXT/);
  assert.match(body, /upstream-currency\.yml/);
  const draft = composeBody("pi-coding-agent", "1.6.0", { ready: false, reason: "live check failed", report: "R" });
  assert.match(draft, /draft/i);
  assert.match(draft, /live check failed/);
});

test("the signed commit's tree entries come straight from git diff --raw", () => {
  const a = "a".repeat(40), b = "b".repeat(40), z = "0".repeat(40);
  const raw = [
    `:100644 100644 ${a} ${b} M\tpackage.json`,
    `:000000 100644 ${z} ${b} A\tsrc/new file.json`,
    `:100755 000000 ${a} ${z} D\tscripts/old.sh`,
    "",
  ].join("\n");
  assert.deepEqual(treeEntriesFromRaw(raw), [
    { path: "package.json", mode: "100644", type: "blob", sha: b },
    { path: "src/new file.json", mode: "100644", type: "blob", sha: b },
    { path: "scripts/old.sh", mode: "100755", type: "blob", sha: null },
  ]);
  assert.deepEqual(treeEntriesFromRaw(""), []);
});

test("anything but a plain file change is refused rather than half-published", () => {
  const a = "a".repeat(40), b = "b".repeat(40);
  assert.throws(() => treeEntriesFromRaw(`:120000 120000 ${a} ${b} M\tlink`), /non-file change to link/);
  assert.throws(() => treeEntriesFromRaw(`:160000 160000 ${a} ${b} M\tsub`), /non-file change to sub/);
  assert.throws(() => treeEntriesFromRaw(`:100644 100644 ${a} ${b} R100\told\tnew`), /unexpected change/);
});

test("only the bot App's own commits keep a bot branch under the bot's control", () => {
  const slug = "nimbletron-upstream-bot";
  assert.equal(isBotAuthor(`123456+${slug}[bot]@users.noreply.github.com`, slug), true);
  assert.equal(isBotAuthor("jack@nimbletron.ai", slug), false);
  assert.equal(isBotAuthor("41898282+github-actions[bot]@users.noreply.github.com", slug), false);
  assert.equal(isBotAuthor(`123456+${slug}-evil[bot]@users.noreply.github.com`, slug), false);
  assert.equal(isBotAuthor(`123456+${slug}[bot]@users.noreply.github.com`, undefined), false);
  assert.equal(isBotAuthor("1+a.b[bot]@users.noreply.github.com", "a.b"), true);
  assert.equal(isBotAuthor("1+axb[bot]@users.noreply.github.com", "a.b"), false);
});
