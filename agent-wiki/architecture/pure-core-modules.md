# Pure core modules

> **Status:** stable

The dominant idiom in `src/`. Where a feature has a *decision* and an *effect*, the
decision is extracted into a small vscode-free module and unit-tested headlessly; the
effect (QuickPicks, notifications, file writes) stays in the caller.

This page indexes every one of them, because they are easy to miss: they are small,
they are named after the thing they decide, and nothing points at them from the class
they were extracted from.

## Why the pattern

Importing `vscode` makes a module untestable outside the extension host. Almost every
bug worth catching in this codebase lives in a decision — which levels to offer, whether
a cost is knowable, whether an event is a duplicate — not in the call that shows a
dialog. So decisions move to modules that import nothing but types, and the test suite
runs them under plain `node:test` with no VS Code at all.

The 400+ headless tests exist because of this split. Two secondary benefits: the
extracted module is where the *reasoning* gets written down (most carry long header
comments explaining a bug they encode), and a reviewer looking for the rule finds one
file instead of a method buried in a 1800-line class.

**Convention:** the header comment names the module it was extracted from, so the
relationship survives the move.

## The pure cores

Decision logic, no `vscode` import, directly unit-tested:

| Module | Decides | Extracted from |
| --- | --- | --- |
| `usage-stats.ts` | cost + `costKnown` (`$??` vs `$0.00`) + `costSource` (billed/estimated/mixed) | `PiService.getUsageStats` |
| `model-catalog.ts` | thinking capability, clamping, pricing lookup, cost-withheld policy | `PiService` |
| `model-picker.ts` | picker rows, pricing/context detail line | `PiService.pickModel` |
| `thinking-dial.ts` | dial rows, status text, on/off toggle target | `PiService` status + picker |
| `active-tools.ts` | tool picker grouping and picked state | `PiService.pickActiveTools` |
| `slash-commands.ts` | command list assembly + parsing | `PiService` |
| `session-replay.ts` | history entries → `PiServiceEvent` sequence | `PiService.sendInitialMessages` |
| `tab-summary.ts` | summary prompt + reply cleaning | `PiService.generateTabSummary` |
| `prompt-guard.ts` | whether a prompt preempts an in-flight turn | `PiService.sendPrompt` |
| `event-bus.ts` | listener registry for `PiServiceEvent` | `PiService.onEvent` |
| `panel-restore.ts` | reviving a panel from serialized state | `panel serializer` |
| `version-compare.ts` | semver-ish compare; which SDK notice to show | `sdk-service.ts` |
| `agent-events.ts` | agent event → `PiServiceEvent` translation | `PiService.handleAgentEvent` |
| `pi-package-filter.ts` | is this npm package a Pi extension? | package tree |
| `pi-package-path.ts` | resolving the bundled SDK package path | `pi-service.ts` |
| `managed-models-cleanup.ts` | which `models.json` entries earlier versions wrote, and whether the file is safe to rewrite (pure apart from fs; run at startup) | new in 0.2.8 |
| `bridge-limits.ts` | output-size guards for bridge tools | `bridge-tools.ts` |
| `escape-html.ts` (`src/shared/`) | one HTML escaper for five former copies | webview |
| `webview-nav-guard.ts` (`src/shared/`) | safe external URLs / workspace paths | webview |
| `linkify.ts` (`src/shared/`) | turning bare URLs/paths in plain text into links | webview render |
| `scroll.ts` (`src/shared/`) | stick-to-bottom scroll decisions | webview render |

## Effectful modules

These import `vscode` and are therefore *not* headlessly testable. Where they carry a
decision worth testing, it has already been pulled into the table above.

| Module | Role |
| --- | --- |
| `auth-flow.ts` | login/logout orchestration over an injected `AuthUI` (the UI is injected, so the flow IS tested) |
| `secrets.ts` | API keys in `SecretStorage`, with one-way migration off plaintext settings |
| `renderer-consent.ts` | per-type consent before running extension-supplied renderer JS |
| `extension-ui-bridge.ts` | the `UIContext` handed to pi extensions, bridged to the webview |
| `workspace.ts` | one definition of "this workspace" — its own module to avoid a cycle with `bridge-tools.ts` |
| `phase3-commands.ts` / `phase4-commands.ts` | command registration, split by activation phase, each resolving the live `PiService` per invocation so a disposed session can't be captured |

## Not shipped

`test-fixture.ts` is a deliberate fixture for exercising the read-tool renderer on small
vs large files. It is not application code; edit freely.

## Related

- [PiService](pi-service.md) — the orchestrator most of these were extracted from
- [PiBackend](pi-backend.md) — the SDK seam
- [TDD discipline](../discipline/tdd.md) — how these are tested

> **Last updated:** 2026-11-12 — Second runtime removed (0.2.8): dropped the second runtime's modules, runtime-pick, runtime-identity, rpc-behavior and session-format rows.
> **Earlier:** 2026-08-05 — new page. 29 modules had no mention anywhere in the
> wiki; this indexes all of them and records the extraction pattern they follow.
