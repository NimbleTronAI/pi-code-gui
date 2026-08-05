# Contributing

Pi Code Gui is an opinionated project — it has strong conventions, enforced by
tooling and by the Pi coding agent itself. This guide covers what you need to
know before opening a PR.

- [Quick links](#quick-links)
- [Development environment](#development-environment)
- [Project conventions](#project-conventions)
- [Testing](#testing)
- [Reporting bugs](#reporting-bugs)
- [Pull request process](#pull-request-process)
- [Commit style](#commit-style)
- [License](#license)

## Quick links

| Need | Go here |
|------|---------|
| How the code is organized | `AGENTS.md` and `agent-wiki/index.md` |
| How the build works | `agent-wiki/operations/build-pipeline.md` |
| How the SDK is found and loaded | `agent-wiki/operations/sdk-resolution.md` |
| Testing conventions | `agent-wiki/discipline/tdd.md` |
| How the wiki is maintained | `agent-wiki/discipline/wiki-maintenance.md` |
| Change log | `CHANGELOG.md` |

## Development environment

**Prerequisite: [ripgrep](https://github.com/BurntSushi/ripgrep) (`rg`)** —
`apt install ripgrep` / `brew install ripgrep`. The clean-room check scans with it and
refuses to pass without it, so `pnpm test` and `pnpm run package` both fail if it is
missing. (It hard-fails on purpose: a missing `rg` once exited 127 and fell through to a
silent PASS, so the licence wall reported OK while scanning nothing.)

```bash
pnpm install          # Install dev dependencies
pnpm run compile      # Type-check (tsc --noEmit), lint (eslint), build (esbuild)
pnpm run watch        # Watch mode — esbuild + tsc in parallel
pnpm run package      # Production build (type-check + lint + minified esbuild)
pnpm run check-types  # Type-check only
pnpm run lint         # ESLint only
pnpm test             # Run tests via vscode-test
```

Press `F5` in VS Code to launch the Extension Development Host with live rebuilds.

> **Using Pi to contribute?** The `AGENTS.md` file at the repo root is loaded by
> the Pi coding agent and contains the project's full operating conventions. If
> you're using Pi to work on this project, it already knows the rules.

## Project conventions

This project has strong opinions. Before writing code, read these (they're short):

- **`AGENTS.md`** — project overview, tool discipline, storage rules, wiki conventions
- **`.pi/APPEND_SYSTEM.md`** — the 5 golden rules (system-level, non-negotiable)

Key conventions you'll hit immediately:

- **TypeScript only.** Strict typing, no `any`, ES module imports, `const` over `let`,
  `async/await` over raw promises.
- **Edits go through VS Code.** Use `vscode_apply_workspace_edit` to keep editor buffers
  in sync with disk. Direct file writes bypass VS Code's buffer tracking.
- **No raw HTML strings.** All DOM construction uses the `html` tagged template
  (`src/webview/render/html.ts`) which auto-escapes interpolated values. Trusted HTML
  (from `renderMarkdown()`, `highlightCode()`) bypasses escaping via `safe()`.
- **Components own their DOM.** The micro component system (`src/webview/components/`)
  uses mount/update/destroy lifecycle. New interactive blocks should be components.
- **Wiki is not optional.** When you change a concept that's documented in `agent-wiki/`,
  update the wiki page before committing. See `agent-wiki/discipline/wiki-maintenance.md`
  for the full Karpathy pattern.

## Testing

- Tests live in `src/test/`, run via `@vscode/test-electron`.
- Run `pnpm test` before opening a PR.
- TDD is the default — see `agent-wiki/discipline/tdd.md` for the red-green-refactor
  conventions used here.

## Reporting bugs

Open an issue with:

1. VS Code version and Pi Code Gui version (from the Extensions panel)
2. Pi SDK version (`pi --version` in a terminal)
3. Steps to reproduce, expected vs. actual behavior
4. If possible, run `/debug` in the chat and include the output

Feature requests are welcome but may be politely declined if they don't align with
the project's design philosophy. This extension aims to be a thin, faithful bridge
between VS Code and the Pi agent — not a kitchen-sink chat UI.

## Pull request process

First: thank you for contributing. Every PR — whether it's a one-line typo fix or a
new component — makes this project better for everyone who uses it.

### Workflow

```bash
# 1. Fork the repo (GitHub UI) and clone your fork
git clone https://github.com/YOUR_USERNAME/pi-code-gui.git
cd pi-code-gui

# 2. Add the upstream remote
git remote add upstream https://github.com/NimbleTronAI/pi-code-gui.git

# 3. Create a branch for your change
git checkout -b fix/double-scrollbar

# 4. Make your changes, following project conventions
pnpm install
pnpm run compile   # type-check + lint + build

# 5. Commit (see commit style below)
git add .
git commit -m "webview: fix double scrollbar in write block"

# 6. Keep your branch in sync with upstream
git fetch upstream
git rebase upstream/main

# 7. Push and open a PR
git push origin fix/double-scrollbar
# Then open a pull request on GitHub from your branch to NimbleTronAI/main
```

### Guidelines

1. **Discuss first.** Open an issue for anything beyond a trivial fix. This project
   has strong opinions about scope and architecture.
2. **Keep it focused.** One concern per PR. Refactors mixed with features will be
   asked to split.
3. **Follow conventions.** TypeScript strict mode, no `any`, html tagged template
   for all DOM strings, component lifecycle for new UI blocks.
4. **Update the wiki.** If your change affects a documented concept, update the
   relevant `agent-wiki/` page and append to `agent-wiki/log.md`.
5. **Add a changelog entry.** Add it to `CHANGELOG.md` under the version currently
   in flight — the topmost `## [x.y.z]` heading — since that release has not shipped
   yet. Only start a new `## [Unreleased]` section if the topmost version has already
   been published. Match the existing style: `### Added`, `### Changed`, `### Fixed`,
   one line per bullet, written for someone upgrading from the last release.
6. **Pass CI.** `pnpm run package` must succeed. Tests must pass.
7. **Be patient.** This is maintained by a small team. We'll review as soon as we
   can — feel free to give a gentle nudge after a week.

## Commit style

No strict format enforced, but prefer:

```
area: short description

Longer explanation if needed. Keep it under 72 chars per line.
```

Examples: `webview: fix double scrollbar in write block`, `docs: add contributing guide`.

## License

By contributing, you agree that your contributions will be licensed under the
project's MIT license.
