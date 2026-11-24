# Upstream bump PRs

> **Status:** evolving

How the extension keeps up with the two upstream releases Dependabot cannot handle, by opening a
pull request that already does the bump, the way Dependabot does for ordinary dependencies.

## What is tracked, and why Dependabot can't

| target | what moves | why not Dependabot |
|---|---|---|
| `@earendil-works/pi-ai` | the devDependency **and** `src/model-registry.generated.json` (the bundled catalog, which carries model PRICING) | a bare version bump fails the build until the catalog is regenerated, so `.github/dependabot.yml` ignores it by name |
| `@earendil-works/pi-coding-agent` | `testedAgainst` in `src/pi-sdk-version.json` | installed globally, not a manifest dependency, and moving the number means actually running the extension on that release |

## The flow (`.github/workflows/upstream-currency.yml`, Mondays 07:00 UTC)

1. **check:** `scripts/check-currency.mjs --json` says which targets are behind.
2. **prepare-pi-ai** (read-only token): `pnpm add -D` the new version, `gen:model-registry`, then the
   supply-chain scan, type-check, lint, unit tests, catalog consistency and a production build.
   `scripts/registry-diff.mjs` tables the catalog changes. A move of 2x or more, or a model going
   to or from free, is flagged. A CACHE price appearing is not: pi-ai fills those in routinely,
   and flagging them buried the real moves.
3. **prepare-sdk** (read-only token, no secrets): installs the release globally and
   runs `scripts/live-sdk-check.mjs`, described below. `testedAgainst` moves only on a pass.
4. **open-prs** (the only job that can push, as the org's bot App): `scripts/upstream-pr.mjs`
   refuses a patch that touches files outside its target's allowlist. It then commits to
   `upstream/<target>-<version>` on top of main and opens or updates the PR. A newer release
   closes the older PR. Because the App's pushes and PRs trigger workflows, CI runs on them as on
   anyone's.
5. **report:** `scripts/report-currency-issue.mjs` keeps an issue open only for a stale target
   with no PR (preparation failed, or PR creation failed) or a CRITICAL supply-chain finding.

The pi-ai PR bumps the patch version and adds a CHANGELOG line, so merging it releases the new
catalog. The SDK PR changes nothing that ships, so it does neither. A PR whose checks failed
opens as a draft. A failed live check opens no PR, and the issue carries its report.

**Trust split:** upstream code (the install, the generator, the live check) runs only in the
read-only prepare jobs. The job that can push applies a patch and calls git and gh; it never
installs or imports upstream code.

**Why a GitHub App pushes, not GITHUB_TOKEN.** Three rules meet. `main` requires signed commits,
and a `git commit` on a runner is unsigned, so the bot builds the commit locally (for its exact
tree) and recreates it through GitHub's git-data API (blobs, tree, commit, ref), which GitHub signs
for a bot token only when the request names no custom author. The org ruleset
`nimbletron-author-email` requires an `@nimbletron.ai` author on every branch, so the bot's own
author needs a bypass. And a ruleset bypass list accepts GitHub Apps but not the built-in GitHub
Actions bot. The first real run (2026-11-24, as `github-actions[bot]`) was refused with GH013, and
#99 carried the error, as designed. The script stops if GitHub's tree differs from the local one
or the commit comes back unverified.

**Weekly reruns:** the branch is rebuilt on the latest main and force-pushed, but only when its
content would change, since a needless push re-runs CI and dismisses reviews. Once anyone else
pushes to the branch, the bot stops rebuilding it and only refreshes the description.

## The live SDK check

`pnpm run check:live-sdk` drives the real `PiService` and `SdkService` against the installed SDK
under the vscode stub, in a scratch `PI_CODING_AGENT_DIR`. It covers a tool-call turn, a thinking
turn, manual compaction, HTML export, persistence, reopen and replay, bridge tools in the resumed
session, Pi's reload refusal and its exact wording (SdkService matches it with a regex), a
/tools-narrowed reopen that keeps its history, and no unhandled events. Exit codes: 0 passed,
1 failed, 2 could not run. It is the committed form of the [1.5.2 live run](pi-1.5.2-findings.md).

**No API key.** The model is pi-ai's own faux provider, scripted in the check. It is registered in
the *installed SDK's* copy of pi-ai (the api-registry the SDK dispatches through; a provider
registered in our `node_modules` copy is invisible to it) and declared to the SDK as a custom
provider in the scratch `models.json`. The SDK's agent loop, tools, compaction and persistence all
run for real; only the vendor HTTP call is replaced. The script answers from the context the SDK
sends it, so the checks stay strict: the secret word comes back only if the read tool's real
output reached the model, it thinks only if the SDK passed the thinking level through, and recall
after reopen works only if the history (here the compaction summary) went back into the context.
Two consequences of a scripted model, both handled in the check: the bridge-tool turn holds its
first answer until the reload-mid-response attempt has run (otherwise it finishes first and the
check measures a race), and the double is installed again after `session.reload()`, which resets
pi-ai's registry to the built-ins. Not covered: a vendor's wire format, which is pi-ai's to test.
Verified on 1.5.2 and 1.6.0, and it fails on a deliberately dropped thinking-delta.

## One-time setup

1. Org → Settings → Developer settings → GitHub Apps → **New GitHub App**: any name (the bot
   commits as `<slug>[bot]`), Homepage URL the repo, Webhook **Active** unticked, repository
   permissions **Contents** and **Pull requests** read and write, installable on this account only.
2. **Generate a private key**; **Install App** on `pi-code-gui` only.
3. Repo → Settings → Secrets and variables → Actions: secret **`UPSTREAM_BOT_PRIVATE_KEY`** (the
   `.pem` contents) and variable **`UPSTREAM_BOT_APP_ID`**.
4. Org ruleset **`nimbletron-author-email`** → Bypass list: the App, and **Dependabot** if it is
   offered, both "Always allow". Dependabot's commits break the same rule; the ruleset was last
   edited on 2026-10-16, and Dependabot has opened no PR since 2026-10-13.

Without 1–3 no PR is attempted and the issue says the App is not set up. The live check needs no
secret.

Related: [Build Pipeline](build-pipeline.md), [SDK Resolution](sdk-resolution.md),
[Open items](open-items.md).

> **Last updated:** 2026-11-24 — created: the currency issue became PRs (branch `ci/upstream-bump-prs`); live check moved to the faux provider, so no API key; bot commits signed through the API and pushed by an org GitHub App on the ruleset's bypass list.
