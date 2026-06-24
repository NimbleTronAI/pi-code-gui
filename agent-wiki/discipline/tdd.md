# TDD (Test-Driven Development)

> **Status:** stable

> Companion to `.pi/APPEND_SYSTEM.md` §"TDD"

After the founder approves your implementation plan, follow TDD.

## Red-Green-Refactor

1. **Red** — write tests for the behavior you're about to add or change.
   The test should fail because the behavior doesn't exist yet.

2. **Green** — implement the change. Run the project's test suite and
   fix failures. The new test + all existing tests must pass.

3. **Refactor** — clean up while tests stay green. Improve naming, extract
   helpers, reduce duplication. Tests protect against regressions.

Before presenting work as done, the project's test suite must pass.

## Project test conventions

The project runs two tiers of tests:

- **Headless unit tests (primary, default).** `pnpm run test:unit` →
  `compile-tests` (tsc → `out/`) then `node --test out/test/unit/*.test.js`.
  These use the Node built-in test runner (`node:test`), need no VS Code or DOM,
  and run in seconds. As of 2026-06, there are **123 tests across 7 files** in
  `src/test/unit/` (rust-events, rust-ingress, rust-process, rust-catalog,
  session-format, rust-deps, agent-events). This is the suite to run before
  presenting work.
- **Integration tests.** `pnpm test` → `@vscode/test-cli` +
  `@vscode/test-electron` launches the Extension Development Host against real
  VS Code APIs (`out/test/**/*.test.js`, config in `.vscode-test.mjs`).
  `@vscode/test-electron` downloads a portable VS Code for CI.
- **Preflight:** `pnpm run pretest` → compile-tests + compile + lint, before
  `pnpm test` and in CI (`publish.yml`).

### The extract-then-test pattern (how coverage actually grows here)

`pi-service.ts`, `extension.ts`, and the webview frontend **cannot load
headlessly** — they import `vscode` or touch the DOM, so a `node:test` file that
imports them fails at import. The proven recipe, used for every one of the 82
tests, is: **extract the decision logic into a pure, vscode-free module, then
unit-test that module.** Precedents: `routeRustEvent`/`normalizeRustEvent`
(`src/rust-events.ts`), the `parseRust*` parsers, and `summarizeSessionFile`
(session formatting). When adding behavior to an untestable file, pull the new
logic into a pure helper first — that is what creates the test net.

## Untested code

If the code you're changing has no existing test coverage, stop and present
the founder with two options:

- **BUILD inline** — add tests for the changed behavior as part of this change.
  Scope tests to the changed behavior only.
- **TRACK it later** — proceed without tests now; create a follow-up task
  for test coverage.

Wait for the founder to choose. Do not silently skip tests, and do not
silently add full module coverage beyond the scope of the change.

## When to stop and ask

- **No existing test file** — the module has zero test coverage
- **Fixture complexity** — the test needs complex setup that's non-trivial
- **Flaky test investigation** — a pre-existing test fails intermittently
  and you're not sure if your change caused it

## Related

- [Think Before Acting](think-before-acting.md) — the plan phase before TDD
- [Verify, Don't Assume](verify-dont-assume.md) — what "tests pass" actually means

> **Last updated:** 2026-06-24 — corrected stale "single skeleton test" claim: 82 headless `node:test` unit tests via `pnpm run test:unit`; documented the extract-then-test pattern
