# PiService

> **Status:** stable

PiService (`src/pi-service.ts`) is the **orchestrator** behind every `SessionWindow`. It holds
one `PiBackend`, which is `SdkService` (the in-process Pi SDK), and sequences its primitives into
user-facing operations, presenting a single `PiServiceEvent` stream to the webview.

PiService does not implement the SDK plumbing. It orchestrates: sending a prompt, picking a
model, formatting status and cost, routing slash commands. The SDK-shaped primitives live behind
[PiBackend](pi-backend.md), which is also the test seam that lets PiService be driven headlessly
with a fake.

## Why it exists

The conversation (send a prompt, stream a reply, show cost, pick a model, compact, resume) is the
same shape whatever the SDK does underneath. PiService owns that conversation so the webview,
commands and tree views talk to one object.

The Pi SDK is loaded dynamically from the user's global npm install rather than bundled (see
[SDK Resolution](../operations/sdk-resolution.md)), and that whole resolve, load, create sequence
lives in `SdkService`, not here.

## What PiService owns

- **Session lifecycle.** `initialize()` constructs an `SdkService`, runs its init, applies the
  shared state it returns (model, cycle list, thinking level, resume flag), then wires the
  session to the UI: event subscription, extension binding, history replay, and the first
  `reportStatus`/`emitSettings`/`emitSlashCommands`.
- **The model catalog seam.** `catalogProviders` is the bundled registry
  (`model-registry.generated.json`, generated from pi-ai). It feeds prices, thinking capability,
  the `/model` fallback list and the SDK's reconcile. See [Model Catalog](model-catalog.md).
- **Event fan-out** (`onEvent`/`emit`): observer pattern over `PiServiceEvent`, validated
  against the shared Zod schema in `src/shared/protocol.ts`.
- **User actions**: `sendPrompt`, `abort`, `newSession`, `resumeSession`, `compact`,
  `cycleModel`, `setThinkingLevel`, `login`, `logout`, `toggleAutoCompaction`,
  `toggleAutoRetry`.
- **Interactive pickers**: `pickModel()`, `pickThinkingLevel()`, `pickActiveTools()`. Each is a
  thin vscode shell over a **pure, tested core**: the row and label building lives in
  `src/model-picker.ts`, `src/thinking-dial.ts` and `src/active-tools.ts`.
- **Slash routing**: `tryHandleCommand()` handles the GUI's own commands and intercepts the
  builtins before `session.prompt`, as the CLI does. See [Slash Commands](#related).
- **Status and cost formatting**: `getUsageStats()` combines the backend's raw usage with
  catalog rates through the pure `computeUsageStats` in `src/usage-stats.ts`.

## What PiService does NOT own (moved out)

This class was a god class; most of it was extracted into pure, headlessly-tested
modules. Look here, not in `pi-service.ts`:

| Concern | Lives in |
| --- | --- |
| Cost/`$??` policy | `src/usage-stats.ts` (`computeUsageStats`) |
| Model picker rows, pricing detail | `src/model-picker.ts` (`formatModelDetail`, `buildModelPickerItems`) |
| Thinking level rows, on/off toggle target | `src/thinking-dial.ts` |
| Tool picker grouping | `src/active-tools.ts` |
| History replay into webview events | `src/session-replay.ts` |
| Tab-title summarisation | `src/tab-summary.ts` |
| Event listener registry | `src/event-bus.ts` |
| Duplicate-prompt guard | `src/prompt-guard.ts` |
| Login/logout flow | `src/auth-flow.ts` |
| Thinking capability, clamping, pricing lookup | `src/model-catalog.ts` |
| SDK resolve/load/create | `src/sdk-service.ts` |

PiService keeps thin getters (`session`, `SDK`, `AI`, `sessionManager`,
`settingsManager`, `resourceLoader`) over `_sdk` so existing read sites still compile; they
return `null` before init or after a failed init. `extension.ts` still reaches past the seam
through `sessionManagerInstance` for clone/fork/export, which is SDK-shaped work not modelled
on `PiBackend`.

## Details worth knowing

- **`dispose()`** force-flushes the session file before teardown. The SDK defers all disk
  writes until the first assistant message, so a tab closed early would otherwise lose its
  entries, including the tab name. It also aborts any running bash process, so closing a
  session leaves no zombies.
- **`_agentRunActive` and `isStreaming` are owned by the backend**, not PiService. They are read
  and written through `getAgentRunActive()`/`setAgentRunActive()` on `PiBackend`.
- **`getUsageStats()`** takes raw token counts and context from the backend and applies the cost
  policy in the pure `computeUsageStats`; a model whose catalog rates cannot be right is priced
  as unknown (`$??`) instead of with wrong rates. A cost the provider billed
  (`costFromProvider: "all"`) is shown regardless, and `costSource` says billed, estimated or
  mixed.
- **`reloadContext()`** returns a `ReloadOutcome` (`reloaded`, `unsupported`, `busy-response`,
  `busy-compaction`); anything but `reloaded` means nothing reloaded, and `reloadNotDoneText`
  says why.

## Related

- [PiBackend](pi-backend.md): the seam and where SDK-shaped work belongs
- [Session Window](session-window.md): the SessionWindow that owns PiService
- [Event Translation](event-translation.md): how SDK events become `PiServiceEvent`
- [SDK Resolution & Init](../operations/sdk-resolution.md): the SDK load sequence

> **Last updated:** 2026-11-12 — Second runtime removed (0.2.8): one backend (`SdkService`), no
> capability or runtime branching, catalog is the bundled registry only.
> **Earlier:** 2026-08-05 — rewritten after the god-class extraction.
