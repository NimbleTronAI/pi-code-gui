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
| `package` | check-types → lint → esbuild --production | Production build |
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

> **Last updated:** 2026-08-31 — documented the release/publish chain, the tag-ref
> requirement, the absent approval gate, and the publish-time supply-chain scan.
