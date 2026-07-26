# Repository Agent Instructions

These instructions apply to the entire repository.

## Required Development Workflow

All development must follow the `git-worktree-parrel-development` workflow.

- Never implement a task in the primary Worktree.
- Never create feature, fix, refactor, test, build, or documentation commits directly on `main`.
- Keep the primary Worktree checked out on `main`; use it only for repository inspection and final integration.
- `main` may receive changes only through an explicit non-fast-forward integration merge after the task branch has been validated and rebased.
- Use one dedicated Worktree and one dedicated branch per task.

## Start a Task

Before creating a Worktree, inspect the primary Worktree without modifying unrelated state:

```bash
git status --short
git branch --show-current
git worktree list
git log -3 --oneline
```

Create a semantic task branch from the current local `main`:

```bash
git worktree add ../<repo>-<task> -b <type>/<task> main
```

Use branch prefixes such as `fix/`, `feat/`, `docs/`, `test/`, or `refactor/`. Perform all task reads, edits, builds, tests, staging, and commits inside the task Worktree.

Do not stash, commit, overwrite, delete, or copy unrelated uncommitted changes from another Worktree. Do not check out the same branch in multiple Worktrees.

## Dependencies

Install dependencies normally when possible. A temporary `node_modules` symlink or Windows junction may be used to share the primary Worktree dependencies, but it must be removed separately before deleting the task Worktree. Never commit dependency directories or temporary links.

## Validation

Run checks appropriate to the changed area. The standard project checks are:

```bash
bun run check-types
bun run lint
bun run compile-tests
```

When relevant, also run targeted tests and bundles:

```bash
bun esbuild.js
bun esbuild.webview.js
```

Always run `git diff --check` and inspect VS Code diagnostics when available.

## Commit Discipline

Stage only explicit task paths. Never use `git add .`.

```bash
git add -- <task-file> <test-file>
git diff --cached --stat
git diff --cached --check
git commit -m "<type>: concise task description"
```

A task commit must contain only the focused implementation and its related tests or documentation.

## Rebase and Integrate

Immediately before integration, rebase the task branch onto the latest local `main`:

```bash
git rebase main
git rev-list --left-right --count main...HEAD
```

Resolve conflicts in the task Worktree, preserving both current `main` behavior and the task behavior. Re-run affected validation after a rebase. Do not use destructive conflict shortcuts.

Integrate from the primary Worktree with an explicit merge commit:

```bash
git merge --no-ff <type>/<task> -m "merge: concise task description"
```

A fast-forward merge is forbidden. Do not create the task commit while checked out on `main`; the required `--no-ff` integration merge is the only permitted task-related commit operation in the primary Worktree.

Re-run relevant validation on `main`, then remove the temporary dependency link, Worktree, and task branch:

```bash
git worktree remove ../<repo>-<task>
git branch -d <type>/<task>
git worktree prune
```

## Safety Rules

Never use `git reset --hard`, `git clean -fd`, forced branch switching, or forced Worktree removal to bypass unrelated changes. If the primary Worktree contains conflicting uncommitted work, do not alter it; report the blocker and request guidance.
