# PiService

> **Status:** evolving

PiService (`src/pi-service.ts`) is the runtime-agnostic **orchestrator** behind every
`SessionWindow`. It holds one `PiBackend` — either `SdkService` (in-process TypeScript
SDK) or `RustService` (out-of-process `pi --mode rpc`) — and sequences primitives from
it into user-facing operations, presenting the same `PiServiceEvent` stream to the
webview regardless of runtime.

The distinction that matters: PiService does **not** implement the runtime differences.
It orchestrates. Anything genuinely divergent lives behind
[PiBackend](pi-backend.md) — as a primitive on the interface, or as a data flag in
`BackendCapabilities`. When you find a `kind === "rust"` branch in this file, treat it
as something not yet modelled, not as the intended pattern.

See [PiBackend](pi-backend.md) for the seam and the capability model, and
[Runtime Selection](runtime-selection.md) for how a session picks its runtime.

## Why it exists

Both runtimes need the same conversation: send a prompt, stream a reply, show cost,
pick a model, compact, resume. Only the mechanics differ. PiService owns that shared
conversation so the webview, commands, and tree views never learn which backend is
live.

The TypeScript SDK is also loaded dynamically from the user's global npm install
rather than bundled — see [SDK Resolution](../operations/sdk-resolution.md) — and that
whole resolve→load→create sequence lives in `SdkService`, not here.

## What PiService owns

- **Session lifecycle** — `initialize()` picks the backend, applies the shared state it
  returns (model, cycle list, thinking level, resume flag), then wires the session to
  the UI: event subscription, extension binding, history replay, and the first
  `reportStatus`/`emitSettings`/`emitSlashCommands`.
- **Event fan-out** (`onEvent`/`emit`) — observer pattern over `PiServiceEvent`,
  validated against the shared Zod schema in `src/shared/protocol.ts`.
- **User actions** — `sendPrompt`, `abort`, `newSession`, `resumeSession`, `compact`,
  `cycleModel`, `setThinkingLevel`, `login`, `logout`, `toggleAutoCompaction`,
  `toggleAutoRetry`.
- **Interactive pickers** — `pickModel()`, `pickThinkingLevel()`, `pickActiveTools()`.
  Each is a thin vscode shell over a **pure, tested core**: the row/label building lives
  in `src/model-picker.ts`, `src/thinking-dial.ts`, and `src/active-tools.ts`.
- **Slash routing** — `tryHandleCommand()`, gated on
  `capabilities.interceptSlashCommands`. TypeScript intercepts builtins before
  `session.prompt` (as the CLI does); Rust forwards raw because the binary owns its own
  slash handling. See [Slash Commands](#related).
- **Status and cost formatting** — `getUsageStats()` combines the backend's raw usage
  with catalog rates through the pure `computeUsageStats` in `src/usage-stats.ts`.

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
| Rust process, RPC, event ingress | `src/rust-service.ts`, `src/rust-process.ts` |

PiService keeps thin getters (`session`, `SDK`, `AI`, `sessionManager`,
`settingsManager`, `resourceLoader`) over `_sdk` so existing read sites still compile.
They return `null` under Rust. `extension.ts` still reaches past the seam through
`sessionManagerInstance` for clone/fork/export — genuinely SDK-shaped work that is not
yet modelled on `PiBackend`.

## Runtime divergence, honestly

`capabilities` (data) is the intended axis of difference; `capabilities.kind` is the
escape hatch for the few places that genuinely need identity. Both exist today.

- **Backend selection and init/dispose routing** legitimately branch on identity — you
  cannot pick a backend through the backend.
- **`dispose()`** has two branches by design: Rust captures its session file before
  teardown and appends the session name after the binary exits; the SDK force-flushes
  its deferred writes. Different persistence ownership, not a leak.
- **`flipsStateEagerly(runtime)`** models the one real state divergence: the SDK applies
  a setting in-process so the UI can flip immediately, while the Rust RPC may reject or
  clamp, so its state flips only on the backend's echo.
- **`getUsageStats()`** still keys its cost policy on `runtime === "rust"` rather than a
  capability. Known, deliberate, low severity: the Rust binary reports `cost: 0` and we
  derive cost from catalog rates, whereas the SDK computes its own. Every attempted
  rewrite moved the displayed number on TypeScript, which is not a trade worth making
  for tidiness.

## Rust-path details worth knowing

- **`_agentRunActive` and `isStreaming` are owned by the BACKEND**, not PiService — read
  and written through `getAgentRunActive()`/`setAgentRunActive()` on `PiBackend`.
  `RustService` reads its own copy directly so its event loop need not round-trip
  through a host callback.
- **Duplicate `agent_end`** — rust-pi emits `agent_end` twice on the abort path. The
  dedupe reads the run flag *before* the mutation is applied (`routeRustEvent`'s
  `isRealAgentEnd`), with a secondary guard in `translateAgentEvent`.
- **Synthetic steer/follow-up queue** — the binary still emits no `queue_update`
  (re-confirmed against 0.1.23), so `RustService` mirrors the queue locally.
- **`RustHost`** is the explicit coupling: every piece of shared state RustService
  reads/writes and every core call it makes passes through a `makeRustHost()` closure.
- **Session naming** has no RPC, so the extension writes the name to extension state
  keyed by session id. It must NOT be written into the session JSONL — doing so made
  rust-pi reject the whole file and resume as an empty session.

## Related

- [PiBackend](pi-backend.md) — the seam, capability model, and where divergence belongs
- [Runtime Selection](runtime-selection.md) — how a session picks its runtime
- [Session Window](session-window.md) — the SessionWindow that owns PiService
- [Event Translation](event-translation.md) — how both event streams become `PiServiceEvent`
- [SDK Resolution & Init](../operations/sdk-resolution.md) — the TypeScript load sequence

> **Last updated:** 2026-08-05 — rewritten after the god-class extraction. The previous
> version (2026-06-21) described responsibilities that had since moved, and named
> `setEffort` (deleted), `PiService.formatModelDetail()` (now in `model-picker.ts`),
> `authStorage`/`modelRegistry` (replaced by `ModelRuntime`), and `_agentRunActive` as
> "still on PiService" (now owned by the backends).
