# PiBackend — the runtime seam

> **Status:** stable

`src/pi-backend.ts` (175 lines) defines the contract for the ~15% of a session that
genuinely differs between the two runtimes, plus `BackendCapabilities` — the data flags
that replaced scattered `_backendKind === "rust"` conditionals.

Two implementations: `SdkService` (in-process TypeScript SDK) and `RustService`
(out-of-process `pi --mode rpc`). [PiService](pi-service.md) holds exactly one and
delegates primitives to it.

## The split

**Primitives** live behind the interface — send a prompt, abort, set the model on the
wire, read usage. **Orchestration** stays in PiService — cycleModel, the pickers, slash
routing, status formatting — because sequencing primitives plus UI is runtime-agnostic.

The test for where something belongs: if the two runtimes would implement it
*differently*, it is a primitive. If one implementation calls primitives in an order
that works for both, it is orchestration.

## Capabilities, not identity

```ts
export interface BackendCapabilities {
  readonly kind: Runtime;
  readonly bridgeTools: boolean;          // in-process vscode_* editor tools
  readonly customCards: boolean;          // interactive cards vs markdown fallback
  readonly toolsPicker: boolean;          // per-session /tools
  readonly fork: boolean;
  readonly reloadContext: boolean;
  readonly exportHtml: boolean;
  readonly rename: boolean;
  readonly interceptSlashCommands: boolean;
  thinkingLevelLive(): boolean;           // depends on the active model's transport
}
```

`backendCapabilityDefaults(runtime)` is the single source of truth. Every gated feature
is TypeScript-only (out-of-process RPC has no host-tool injection and no
fork/reload/rename RPCs) — so the flags are `!rust`, **except `exportHtml`, which both
support**.

Two things are deliberately NOT static flags, because they are not static facts:

- **`thinkingLevelLive()`** is a method. Under Rust it depends on the active model's
  transport (`thinkingLevelIsLive(model.api)`) — a provider that serialises no reasoning
  field makes the level a no-op, so the UI shows a read-only badge instead of a graded
  picker.
- **`max` thinking-level support** is a *version* function, `rustHonorsMaxThinkingLevel`
  in `src/model-catalog.ts`, gated on the DETECTED binary (≥ 0.1.23), not the pinned one.
  A per-model catalog mapping says the MODEL has the tier and says nothing about whether
  the backend accepts it. Measured: a pre-#139 binary rejects
  `set_thinking_level("max")` exactly as it rejects garbage, and rejects
  `--thinking max` at argv parse — exiting before any RPC exists.

`flipsStateEagerly(runtime)` is the one genuine *state* divergence, expressed as an
exhaustive predicate so a third runtime is a compile error rather than a silent
inheritance of "eager".

## Where the seam still leaks

Read `pi-backend.ts`'s own header: it reduced the branching, it did not eliminate it.
Honest inventory:

- **Backend selection, init and dispose routing** branch on identity — unavoidable.
- **`extension.ts`** reaches past the seam via `PiService.sessionManagerInstance` for
  clone/fork/export session-file work. SDK-shaped, not yet modelled.
- **`getUsageStats()`** keys its cost policy on `runtime === "rust"` rather than a
  capability like `backendComputesCost`. Known and deliberate — see
  [PiService](pi-service.md).
- **The webview** keeps its own hardcoded local-slash list (`src/webview/state.ts`)
  rather than deriving it from `interceptSlashCommands`, because capabilities are not
  transmitted to the webview. The two can drift.

These are recorded rather than hidden. A reviewer who finds one has found something
real; what they should NOT conclude is that the pattern is unintended.

## Adding a capability

1. Add the flag to `BackendCapabilities`.
2. Add its default to `backendCapabilityDefaults` — this is compile-checked everywhere.
3. Override it in the backend that differs (as `RustService` does for
   `thinkingLevelLive`).
4. Gate the feature on the flag, never on `capabilities.kind`.

`src/test/unit/pi-backend.test.ts` asserts every flag's default per runtime.

## Related

- [PiService](pi-service.md) — the orchestrator that holds one of these
- [Runtime Selection](runtime-selection.md) — how a session picks its runtime
- [Event Translation](event-translation.md) — the two event streams behind the seam

> **Last updated:** 2026-08-05 — new page. The seam and capability model had no page of
> its own despite being the central abstraction; it was mentioned in passing on one
> other page.
