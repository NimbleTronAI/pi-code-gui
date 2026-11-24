// Tests for the pure helpers in scripts/release-pr.mjs (the "Release X" PR after Dependabot merges).
import { test } from "node:test";
import assert from "node:assert/strict";
import { shippingDependabotMerges, composeReleaseBody, BRANCH } from "../release-pr.mjs";

const merge = (n, branch, files) => ({ sha: `sha${n}`, subject: `Merge pull request #${n} from NimbleTronAI/${branch}`, files });

test("only Dependabot merges that change what the extension is built from start a release", () => {
  const out = shippingDependabotMerges([
    merge(113, "dependabot/npm_and_yarn/npm-minor-patch-78928", ["package.json", "pnpm-lock.yaml"]),
    merge(110, "dependabot/github_actions/actions/upload-artifact-7", [".github/workflows/ci.yml"]),
    merge(120, "dependabot/docker/devcontainer/node-25", [".devcontainer/Dockerfile"]),
    merge(115, "ci/dependabot-bump-concurrency", ["package.json"]),
    { sha: "x", subject: "Release 0.2.11", files: ["package.json"] },
    merge(114, "dependabot/npm_and_yarn/jsdom-31.0.1", ["pnpm-lock.yaml"]),
  ]);
  assert.deepEqual(out, [
    { sha: "sha113", number: 113, branch: "dependabot/npm_and_yarn/npm-minor-patch-78928" },
    { sha: "sha114", number: 114, branch: "dependabot/npm_and_yarn/jsdom-31.0.1" },
  ]);
  assert.deepEqual(shippingDependabotMerges([]), []);
});

test("the release PR names no version in its branch, and lists what it ships", () => {
  assert.equal(BRANCH, "release/next");
  const body = composeReleaseBody("0.3.1", "v0.3.0", [{ number: 113, branch: "dependabot/npm_and_yarn/x" }]);
  assert.match(body, /Releases \*\*0\.3\.1\*\*: the dependency updates merged since `v0\.3\.0`/);
  assert.match(body, /- #113 \(`dependabot\/npm_and_yarn\/x`\)/);
  assert.match(body, /\*\*Auto-merge is on:\*\*/);
});
