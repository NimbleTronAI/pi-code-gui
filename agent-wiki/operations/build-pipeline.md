# Build Pipeline

> **Status:** stable

The Build Pipeline (`esbuild.js`, `tsconfig.json`, `eslint.config.mjs`,
`.vscode-test.mjs`, and npm scripts in `package.json`) compiles, type-checks,
lints, tests, and packages the Pi Code Gui VS Code extension. The pipeline
produces a single `dist/extension.js` bundle plus static media assets.

## Why it exists

VS Code extensions are distributed as `.vsix` packages containing JavaScript
that runs in the extension host. The build pipeline must: bundle TypeScript
source into a single file (VS Code extensions can't use native ESM with
multiple files), exclude the `vscode` module (provided by the host), strip
source files from the package (they're not needed at runtime), and produce
both development and production builds.

## Build tools

**esbuild** (`esbuild.js`):
- Entry point: `src/extension.ts`
- Output: `dist/extension.js` (single ESM bundle)
- External: `vscode` (provided by extension host)
- Dev mode: unbundled with sourcemaps
- Production mode (`--production`): minified, no sourcemaps
- Watch mode (`--watch`): rebuilds on file changes
- Custom plugin logs build start/end and formats errors with file locations

**TypeScript** (`tsconfig.json`):
- Module: Node16, Target: ES2022
- Strict mode enabled, skipLibCheck for SDK types
- `tsc --noEmit` only — type checking, no transpilation (esbuild handles that)
- Source root: `src/`

**ESLint** (`eslint.config.mjs`):
- typescript-eslint parser and plugin
- Rules: naming convention (import), curly, eqeqeq, no-throw-literal, semi
- Targets: `**/*.ts`

**Tests** (`.vscode-test.mjs`):
- `@vscode/test-cli` configuration
- Test files: `out/test/**/*.test.js` (compiled from `src/test/`)
- Uses `@vscode/test-electron` for CI (portable VS Code download)

## npm scripts

| Script | Steps | Use |
|--------|-------|-----|
| `compile` | check-types → lint → esbuild | Dev build |
| `watch` | esbuild (watch) + tsc (watch) in parallel | Dev loop |
| `package` | check-diagram → check-model-registry → check-types → lint → test:unit → esbuild --production (extension + webview) | Production build; the full gate |
| `pretest` | compile-tests → compile → lint | Before tests |
| `test` | vscode-test | Run tests |
| `vsix` | package → vsce package --no-dependencies | Create .vsix |
| `publish` | vsce publish | Manual marketplace publish |

## CI/CD

GitHub Actions (`.github/workflows/publish.yml`):
- Triggered on GitHub Release (`published`)
- Gated behind `marketplace` environment with required reviewers
- Two parallel jobs: `publish-vsce` (VS Code Marketplace via Azure credential)
  and `publish-ovsx` (Open VSX via PAT)
- Both run: checkout → setup Node 22 → pnpm install → pretest → publish

## VSIX contents

Controlled by `.vscodeignore`: excludes source, configs, lockfiles, dev
container files, and `.pi/`. Ships only `dist/`, `media/`, `package.json`,
`README.md`, `CHANGELOG.md`, `LICENSE`, and icon files.

## Related

- [SDK Resolution & Init](sdk-resolution.md) — how the extension finds and loads Pi SDK at runtime

## Release chain (0.1.7-0.1.8)

Two failures here were silent, and both are worth knowing before editing the
workflows.

**Releases were never published.** `release.yml` creates the GitHub Release with
`GITHUB_TOKEN`, and GitHub deliberately does not start workflow runs from events
raised by that token — so `publish.yml`'s `release: published` trigger never fired for
an automated release. v0.1.4 was tagged, released, and absent from both marketplaces
with nothing queued and no failure anywhere. `release.yml` now dispatches `publish.yml`
explicitly, **on the tag**: the `marketplace` environment admits only tag refs matching
`v0.*`, so a dispatch with `--ref main` is rejected before any step runs (~2s, no
runner, no steps) — which reads as a build failure and is not one.

**Starting the publish is retried.** v0.2.9 was tagged and released, then the dispatch of
`publish.yml` got an HTTP 500 from GitHub and nothing shipped, with no later retry (the tag
existed). The dispatch now tries three times, 15s and 45s apart, and on a final failure leaves an
error annotation naming the manual publish. Do not "Re-run" a run that got that far: it stops at
`git tag`, because the tag exists. Run **Publish the VS Code Extension** from the tag instead.

**There is no approval gate.** The `marketplace` environment has no required reviewers
and no wait timer, only that branch policy. Comments in both workflows once claimed a
release would "queue that publish for your approval"; it does not. A merge to `main`
that changes the version ships, unattended.

**The supply-chain scan runs at publish time too.** `check-currency.mjs` exits non-zero
on CRITICAL findings (known-compromised versions, IOC hashes, unrecognised install
hooks). It ran only in `ci.yml`, which cannot gate a release — CI and the release
workflow trigger on the same push and run concurrently, so the publish can finish
before CI reports. Both publish jobs now run it themselves, making publish a superset
of CI rather than a race.

**"Has this version been released?" is asked of the remote.** `release.yml` releases when the
version's tag does not exist yet, so a refused release is retried by the next push touching
`package.json`. It checked with a local `git rev-parse`, but `actions/checkout` with a
`fetch-depth` fetches no tags, so it never found one: every push touching `package.json`
without a version bump re-attempted the already-released version. #100 did that for v0.2.8 and
was stopped by the stale-catalog gate. It now uses `git ls-remote --tags origin`.

**Bot PRs that release.** Two kinds of automated PR bump the version, so merging one ships
it through the chain above: Dependabot PRs (`dependabot-version-bump.yml` adds the bump, as a
signed commit by the org's bot App) and
the pi-ai catalog PR from `upstream-currency.yml`, which bumps the version and adds a
CHANGELOG line itself. The upstream PRs are pushed by an org GitHub App, whose pushes and PRs
start CI like anyone's. **Some of them merge themselves**, and so ship unattended: Dependabot
minor/patch PRs, and every pi-ai PR whose checks passed, once CI passes. See
[Upstream bump PRs](upstream-bump-prs.md).

> **Last updated:** 2026-11-24 — publish dispatch retried; release.yml checks the tag on the remote (shallow checkouts
> have no tags); bot PRs that release: the upstream-currency PRs, pushed by an org GitHub App.
> **Earlier:** 2026-08-31 — documented the release/publish chain, the tag-ref
> requirement, the absent approval gate, and the publish-time supply-chain scan.
