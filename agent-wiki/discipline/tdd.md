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
  `compile-tests` (tsc → `out/`), then `compile-tests:webview` (compiles
  `src/webview` + `src/shared` to `out/` via `tsconfig.test-webview.json` for the
  jsdom seam), then `node --import ./scripts/vscode-register.mjs --test out/test/unit/*.test.js` (`vscode` is stubbed). The Node built-in test
  runner (`node:test`), no VS Code; almost all are pure and DOM-free, the lone
  exception being the jsdom dispatch seam (see below). As of 2026-11, there are
  **about 455 tests across 40 files** in `src/test/unit/` (agent-events, sdk-service,
  pi-service-integration, model-catalog, managed-models-cleanup, panel-restore,
  pi-package-path, pi-package-filter, bridge-limits, webview-format, version-compare,
  dispatch, logger, extension-errors, and more). This is the suite to run
  before presenting work.

  **The SDK init is headlessly tested.** `sdk-service.test.ts` drives the REAL
  `SdkService.initialize()` (resolve, load, pi-ai-version adapt, auth, model, resources,
  tools, session) against fake SDK/AI modules and stubbed `SdkDeps` (config, cwd, module
  import, fs, bridge-tool assembly, catalog providers, UI nudge all injected, so SdkService
  is vscode-free AND json-import-free). It also covers SdkService's `PiBackend` primitives
  (sendPrompt / setModel / setThinkingLevel / abort / getUsage / promoteToSteer) against a
  fake session, the half of the seam that PiService delegates to. Coverage matrix:
  headlessly tested are the pure decision modules and the `SdkService` init path. Not
  unit-tested (vscode-coupled UI shells): PiService orchestration and pickers beyond what
  `pi-service-integration.test.ts` drives, and `extension.ts` registration beyond
  `command-registration.test.ts`.
- **Integration tests.** `pnpm test` runs `test:unit`; `pnpm run test:vscode` runs `@vscode/test-cli` +
  `@vscode/test-electron`, which launches the Extension Development Host against real
  VS Code APIs (`out/test/**/*.test.js`, config in `.vscode-test.mjs`).
  `@vscode/test-electron` downloads a portable VS Code for CI.
- **Preflight:** `pnpm run pretest` → compile-tests + compile + lint, before
  `pnpm test` (runs the node:test suite; `pnpm run test:vscode` is the separate VS Code harness) and in CI (`publish.yml`).

### The extract-then-test pattern (how coverage actually grows here)

`extension.ts` and the webview frontend **cannot load
headlessly** (`pi-service.ts` loads only through the vscode stub, see `pi-service-integration.test.ts`) — they import `vscode` or touch the DOM, so a `node:test` file that
imports them fails at import. The proven recipe, used for nearly all of the unit
tests, is: **extract the decision logic into a pure, vscode-free module, then
unit-test that module.** Precedents: `translateAgentEvent` (`src/agent-events.ts`),
`planPanelRestore` (`src/panel-restore.ts`), `cleanupManagedModels`
(`src/managed-models-cleanup.ts`), and the DOM-free webview helpers in
`src/shared/webview-format.ts`. When adding behavior to an untestable file, pull
the new logic into a pure helper first — that is what creates the test net.

**The jsdom seam (for genuinely DOM-coupled paths).** Some logic can't be pulled
out of the DOM — e.g. the webview's streaming dispatch (`handleStreamDelta` /
`handleToolStart` / `handleToolEnd`). For those, `src/test/unit/dispatch.test.ts`
stands up a jsdom DOM, stubs the `<script>` globals (`marked`/`morphdom`/`hljs`),
and dynamically imports the real handlers (compiled to `out/` by
`tsconfig.test-webview.json`) with a **variable specifier** so the main `tsc`
doesn't type-check excluded webview code. Reach for this only when extraction
genuinely can't isolate the logic from the DOM.

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

> **Last updated:** 2026-11-12 — count corrected to about 455 tests across 40 files (0.2.8, after the /reload, cost, retry-card and session-name fixes).
> **Earlier:** 2026-11-12 — Second runtime removed (0.2.8): the second runtime's init and transport tests and precedents are gone.
> **Earlier:** 2026-07-21 — count at 461 tests across 47 files (adversarial-review remediation: security, activation, lifecycle, perf)
> **Earlier:** 2026-06-25 — count to 199 tests across 18 files (added `extension-errors` — runtime-error classifiers)
> **Earlier:** 2026-06-25 — count to 190 tests across 17 files (added `logger` + `normalizeToolArgs` cases)
> **Earlier:** 2026-06-25 — refreshed the count to 182 tests across 16 files; documented the jsdom dispatch seam (`tsconfig.test-webview.json` + variable-specifier import)
> **Earlier:** 2026-06-24 — corrected stale "single skeleton test" claim: 82 headless `node:test` unit tests via `pnpm run test:unit`; documented the extract-then-test pattern
