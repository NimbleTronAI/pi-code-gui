# Rust removal plan — release 0.2.8

> **Status:** evolving — plan written 2026-11-11; D1–D6 accepted by the founder 2026-11-11; U1 + U3 in progress

The plan for 0.2.8, the release that drops Rust Pi. Briefs quote it verbatim (the coordination
protocol, rule 1). Inputs: [rust-removal-inputs](../archive/batch-0.2.8/rust-removal-inputs.md),
the [batch status page](batch-0.2.8-status.md). The founder's go-ahead came on 2026-11-11, with one
amendment: **target the newest TypeScript Pi, not 1.4.0** — that is **1.5.2** (pi-ai and
pi-coding-agent, released 2026-11-10; the container's global install is already 1.5.2).

## 1. Starting point (measured 2026-11-11)

- Branch `release/0.2.8` @ `69c2e74`; unit tests **819/819 green**.
- 130 tracked files mention Rust outside README.md, CHANGELOG.md and agent-wiki/log.md: 12
  `src/rust-*` modules (~4,700 lines), 18 `rust-*` test files, 5 settings + 5 commands in
  package.json, the clean-room machinery, the devcontainer, 3 workflow comments, 26 wiki pages,
  `media/architecture.svg`, `media/style.css`, `sample-workspace/`, and the tracked `tmp/cleanroom-kit/`.
- The Rust code reaches TypeScript code at these points: `pi-service.ts` (171 mentions:
  `_backendKind`, `_rust`, `initializeRust`, `makeRustHost/Deps`, Rust branches in
  thinking/model/catalog code), `extension.ts` (115: runtime commands, the history scope, the
  managed install, detection), `pi-backend.ts` (`Runtime`, `flipsStateEagerly`, capability flags
  that are `!rust`), `runtime-detection.ts` / `runtime-pick.ts` / `runtime-identity.ts`,
  `usage-stats.ts` (the `uncosted*` / `costUnknown` / `$??` rules), `session-format.ts`,
  `agent-events.ts`, `extension-errors.ts`, `pi-package-service.ts`, and the webview (runtime pill,
  mode strip, handlers).
- **Phase A is not Rust-only:** phase D wired `catalogSource()` into TypeScript init
  (`pi-service.ts` `prepare`) and into thinking-capability reconciliation (`catalogProviders`).
  See D3.

## 2. Decisions for the founder (each has a recommendation)

| # | Question | Recommendation |
|---|---|---|
| D1 | The `PiBackend` seam once there is one backend | **Keep the interface** (it is the test seam for `SdkService`) but delete `Runtime`, `capabilities.kind`, `flipsStateEagerly` and every capability flag that becomes a constant, along with the gates on them. Do not merge `SdkService` into `PiService` in this release. |
| D2 | Features that existed only for Rust: the mode strip (plan mode + approval, the `defaultMode` setting), the `$??` cost rules, the `rpc-behavior` harness, the runtime pill | **Remove them all.** |
| D3 | Phase A (catalog source: catalog-only ModelRuntime, background refresh, 4 h throttle, read-only credentials) | **Remove it.** Reconcile thinking capability against the bundled registry again, as `main` did. The live `ModelRuntime` is already the installed Pi's catalog on TypeScript, and phase A's network and credential machinery was justified only by Rust. |
| D4 | The runtime-identity block in the TypeScript system prompt | **Remove it.** It was written because two runtimes looked identical from the inside, and that is no longer true. |
| D5 | The acceptance grep vs. `agent-wiki/archive/` (the batch-0.2.8 archive and `multi-backend.md` are about Rust) | **Delete those archive pages.** Git keeps them (`69c2e74`), and the log entry names that commit. Move the non-Rust open items (contracts C17: F2, N1, N2, N3) to the status page first. |
| D6 | The uncommitted `.devcontainer/devcontainer.json` change (`initializeCommand` creating the external volumes) | **Ship it in U3** with the rest of the devcontainer changes. |

## 3. Units

Each unit gets its own worktree. Units run in this order: U1 and U3 can run in parallel, U2 starts
when U1 lands, and U4 and U5 come last.

### U1 — Managed-entry cleanup (build first; it salvages code that U2 deletes)

1. New vscode-free module `src/managed-models-cleanup.ts`, extracted from phase B's migration in
   `rust-models.ts` (`MANAGED_KEY = "_managedBy"`). It reads `~/.pi/agent/models.json` (respect
   `PI_CODING_AGENT_DIR` the way Pi does) and removes **only** entries whose `_managedBy` starts with
   `pi-code-gui@`, plus providers that this removal leaves empty.
2. **Byte-identical guarantee:** with nothing to remove, the file is not written (bytes and mtime
   unchanged). After a removal, user entries keep their values, keys and order. If the file cannot
   be parsed as strict JSON (comments, trailing comma, BOM, non-object shapes), it is **never
   written**, and one warning goes to the output channel. Phase B's guard tests are the model.
3. Writes are atomic (temp file + rename) and fail closed.
4. Runs on every activation, not once behind a flag. It is idempotent and cheap, and it also cleans
   up after a user who went back to 0.2.3 and returned.
5. Production call site: `activate()` in `extension.ts`, fire-and-forget, logging what it removed.
6. Red-first tests: marked entries removed; a provider emptied by the removal is removed; an
   unmarked sibling is unchanged; a foreign `_managedBy` is untouched; no-op leaves mtime unchanged;
   each unparseable case leaves the file untouched; a missing file is a no-op.

### U2 — Remove the Rust runtime from source (top tier: subtle merge across pi-service/extension)

1. Delete `src/rust-*.ts`, `rust-pi-version.json`, `rust-pi-catalog.generated.json`,
   `runtime-detection.ts`, `runtime-pick.ts`, `rpc-behavior.ts`, and their tests.
   Also delete `runtime-identity.ts` (D4) and `catalog-source.ts` (D3).
2. `pi-service.ts`: remove `_backendKind`, `_rust`, `initializeRust`, `makeRustHost/Deps`, the Rust
   effects (`rustClearQueue`, `captureContext` routing) and every Rust branch and comment.
   `catalogProviders` reads the bundled registry.
3. `pi-backend.ts` per D1. `usage-stats.ts`: drop `uncosted*` / `costUnknown` and their notes. The
   cost becomes the SDK's figure as before. (`Usage.cost.totalFromProvider`, new in 1.5.0, is noted
   as an opportunity only.)
4. `extension.ts`: remove the runtime commands (`addSessionWithRuntime`, `addSessionRust`,
   `setDefaultRuntime`, `switchRuntime`, `installRust`), the context keys (`rustAvailable`,
   `bothAvailable`; `anyAvailable` becomes `tsAvailable`), `sessionHistoryScope` /
   `sessions-rust` listing, and catalog-source configure/dispose. New-session flow is TS-only.
5. `package.json`: remove settings `defaultRuntime`, `sessionHistoryScope`, `rustBinaryPath`,
   `rustInstallMethod`, `rustExtensionPolicy`, `rustExtensions`, `rustAgentDir`, `defaultMode`
   (D2); the five commands and their menu/`when` entries; scripts `test:rust-smoke`,
   `test:rpc-behavior`. Users' leftover settings are ignored by VS Code, so no migration is needed.
6. Webview: the runtime pill (`media/style.css` `.pi-sb-runtime--rust`), the mode strip, and the
   Rust branches in `src/webview/**` and `shared/protocol.ts`.
7. The remaining modules on the list in §1 lose their Rust branches and comments.
7a. **The TypeScript half of every runtime-choice affordance goes too.** With one runtime there is
   nothing to choose or label:
   - `pi-code-gui.addSessionTypescript` ("Add TypeScript Pi Session") folds into the plain Add Pi
     Session command. Its `1_runtime@*` menu group goes.
   - The TS/Rust badges on past sessions (`extension.ts` runtime label) go.
   - The packages tree drops its runtime label ("TS · n/m active", "shared across runtimes", "not
     loaded by TS").
   - The webview's `switchRuntime` message and the `runtime` enum fields in `shared/protocol.ts` go,
     along with the `runtime` kept in the webview's saved state.
   - User-facing text that says "TypeScript sessions/runtime" says "Pi sessions" / "Pi" instead
     (`version-compare.ts` too-old message; the `contextBudget` setting description).
   - Model switching (`/model`, cycle, picker) is unaffected and stays.
8. Gate: `pnpm run compile` + `pnpm run test:unit` green. The test count drops, and the hand-back
   lists every deleted test file so the count can be checked.

### U3 — Remove the clean-room machinery and Rust tooling (mid tier, mechanical)

1. `AGENTS.md` §"pi clean-room" and its quick-reference row; `agent-wiki/bootstrap/AGENTS.md` and
   `APPEND_SYSTEM.md` mentions; `CONTRIBUTING.md` mention.
2. `.claude/settings.json`: the `permissions.deny` Read/WebFetch rules and the Bash PreToolUse hook.
   Delete `scripts/hook-cleanroom-bash.sh`, `check-cleanroom.sh`, `check-cleanroom-smoke.sh`, and
   `tmp/cleanroom-kit/`. `.githooks/pre-commit` loses the clean-room stage (if it has no other
   stage, delete it and keep the `core.hooksPath` setup consistent). `package.json`: drop
   `check:cleanroom` from `pretest` and `package`. **All of this lands in one commit:** the gate
   fails a commit that removes the deny rules while the gate still exists.
3. Scripts: delete `gen-rust-pi-catalog.mjs`, `rust-smoke.mjs`, `rpc-behavior.mjs`. Remove the Rust
   parts of `check-currency.mjs`, `report-currency-issue.mjs`, `gen-model-registry.mjs`,
   `check-model-registry.mjs` and `vscode-stub.mjs`.
4. Workflows: rewrite the rust-pi comments in `upstream-currency.yml`. The `dependabot` and `publish`
   hits are the word "trust" (see §5).
5. Devcontainer: the Rust block in `post-start.sh`, `build-rust-pi.sh`, the Rust lines in the
   `Dockerfile`, the rust-pi-build cache volume and comment in `docker-compose.yml`, and D6.
   `sample-workspace/.vscode/settings.json` comment.
6. **The clean-room law stays in force until U3 lands.** No unit reads rust-pi source in the
   meantime.

### U4 — Pi 1.5.2 (catalog + live verification)

1. `pnpm add -D @earendil-works/pi-ai@1.5.2` and `pnpm run gen:model-registry`, committed together
   (Unit 1's pattern). `check:model-registry` and `check:currency:strict` green.
2. Re-derive the findings for 1.4.0 → 1.5.2. Initial scan (2026-11-11, installed CHANGELOG):
   - The breaking changes don't hit us. There is no `GrepOperations` and no TypeBox-only features
     (`Type.Refine`/`BigInt`/`Undefined`, `Format.Set`) in `src/`.
   - The loader's `node_modules/typebox/build/index.mjs` still exists in 1.5.2.
   - The behaviour to verify is that SDK/RPC `reload` now asks the caller to wait while a response
     or compaction runs (#9222), which touches our `/reload`.

   Record the findings as a short page; that work is delegated to a subagent.
3. Live-verify the TypeScript runtime on 1.5.2: one trivial prompt with a tool call, a manual
   compaction, persist, replay. Also run the **resumed session's bridge tools** live, which no one
   has done yet. Only then move `src/pi-sdk-version.json` `testedAgainst` to 1.5.2.

### U5 — Documentation and acceptance (mid tier; diagram top-tier review)

1. Wiki: rewrite `runtime-selection.md` into a short "SDK loading" note or fold it into
   `sdk-resolution.md`; delete `runtime-switching-ux.md` and `session-modes.md` (D2); strip the
   Rust content from every other page in §1; apply D5; update `index.md`, the status page and
   `log.md`.
2. Redraw `media/architecture.svg` → `.png` (`gen:diagram` / `check:diagram`).
3. Rewrite CHANGELOG `[0.2.8]` for what ships (Rust removed, models.json cleanup, pi 1.5.2 catalog,
   Unit 2/6 fixes) per [Documentation Discipline](../discipline/documentation-discipline.md).
4. Update the `AGENTS.md` overview: remove the runtime-selection bullet and the bridge-tool and
   architecture lines that mention Rust.
4a. README's cleanup bullet (line ~303) promises the cleanup "deletes every entry carrying that marker,
   and nothing else". U1 (landed) behaves slightly differently: a stamped entry the user edited is kept
   whole, and a provider connection (`api` + `baseUrl`) that 0.2.x wrote unstamped is removed when
   it is a pair we shipped and the provider held only our entries. Make the README say this
   accurately, in the founder's approved voice ("we").
5. Last step: delete this plan page and rewrite the status page without Rust wording, because both
   would fail §5. Git keeps the plan, and the log entry names the commit.

## 4. Contracts (numbered; briefs cite them, members never re-derive them)

- **C1** Base commit for every member: `69c2e74` (`release/0.2.8`). Members deliver a diff against it
  in their own worktree; the coordinator lands it on the moving tip.
- **C2** D1–D6 are accepted as recommended (founder, 2026-11-11).
- **C3** The clean-room law stays in force until U3 lands. No member reads rust-pi,
  asupersync or franken-* source by any channel. Reading the Pi ancestor
  (`@earendil-works/pi-*`, including the installed package's `dist/`) is allowed.
- **C4** U1 does not import from any `src/rust-*` module or from `catalog-source.ts`, because U2
  deletes them. U1 copies the logic it needs, and the copy must not mention Rust.
- **C5** U1's public API: `src/managed-models-cleanup.ts` exports
  `cleanupManagedModels(file: string): CleanupResult`, which is pure apart from fs, plus
  `managedModelsFile(env = process.env): string`, which resolves Pi's `models.json` exactly as Pi
  does. The result reports what was removed or why nothing was written; the caller logs it.
- **C6** `package.json` ownership: `scripts` belongs to U3; `contributes`, `activationEvents` and
  `dependencies` belong to U2; `devDependencies` (the pi-ai bump) belongs to U4.
- **C7** `AGENTS.md` ownership: U3 removes the "pi clean-room" section, its quick-reference row,
  and the overview's clean-room references. U5 owns the rest of `AGENTS.md`.
- **C8** `.githooks/pre-commit` runs only the clean-room gates, so U3 deletes it and the
  `.githooks/` folder. The coordinator unsets `core.hooksPath`. U3 updates the commit-ceremony
  sentence in `discipline/agent-coordination.md` to say that the full gate is `pnpm run package`.
- **C9** `.claude/settings.json` keeps its `attribution` block. U3 removes `$comment`,
  `permissions.deny` and `hooks`.
- **C10** `.devcontainer/devcontainer.json` belongs to the coordinator (D6, uncommitted in the
  main tree). U3 does not touch it.
- **C11** Unit-test baseline: 819/819 at `69c2e74`; 844/844 after U1.
- **C12** (from U1) `cleanupManagedModelsAtStartup` runs from `activate()` via `setImmediate`,
  before the first await. U2 must keep that call when it rewrites `activate()`. Deferred: a
  models.json under a custom `rustAgentDir` is not cleaned (that setting's home was the Rust
  runtime's alone).

## 5. Acceptance

- `git grep -inP '(?<![tT])rust' -- . ':!README.md' ':!CHANGELOG.md' ':!agent-wiki/log.md'`
  returns nothing. The negative lookbehind keeps *trust*/*untrusted*/`isTrusted` from tripping it.
  A literal `git grep -i rust` cannot pass in this codebase.
- **Dual-runtime language**, a second grep. A Rust-word grep misses it, because it flags only lines
  with the word, and 6 files carry the wording with no "rust" at all (e.g. `extension-ui-bridge.ts`
  "dual-runtime audits", `.vscodeignore`, `version-compare.ts`). Run
  `git grep -inE 'dual[- ]?(runtime|backend)|both runtimes|two runtimes|either runtime|each runtime|per-?runtime|runtime-(agnostic|aware)|other runtime|multi[- ]?(runtime|backend)|switch(ing)? runtime|choose runtime|default ?runtime|TypeScript (runtime|Pi|side|path|backend|session)|out-of-process|--mode rpc|\bbackends\b|which backend|runtime (pill|badge|label)|pi-sb-runtime'`
  with the same exclusions. Every remaining hit is either rewritten or listed in the hand-back with
  a reason. Example: "TypeScript" as a highlight.js language alias is legitimate.
- `pnpm run package` green; unit tests green.
- Live check (U4.3) done on 1.5.2. U1's cleanup proven on a real `models.json` that 0.2.3 wrote
  into a scratch `PI_CODING_AGENT_DIR`, with user entries byte-compared.
- Proven vs. deferred is recorded on the status page.

> **Last updated:** 2026-11-11 — plan written after the founder's go-ahead; target moved to pi 1.5.2
