# PiBackend: the SDK seam

> **Status:** stable

`src/pi-backend.ts` defines the `PiBackend` interface: the primitive operations
[PiService](pi-service.md) delegates to `SdkService`, the in-process Pi SDK runtime. There is one
implementation. The interface stays because it is the test seam: PiService can be driven
headlessly with a fake backend, and `SdkService` is driven with injected deps
(`src/test/unit/sdk-service.test.ts`).

## The split

**Primitives** live behind the interface: send a prompt, abort, compact, get and set the model
and thinking level, toggle auto-compaction and auto-retry, export to HTML, read usage, list
entries and slash commands, list available models, promote or clear the steer queue, dispose.
**Orchestration** stays in PiService: `cycleModel`, the pickers, slash routing, status
formatting. It sequences primitives plus UI.

The test for where something belongs: if it needs the SDK's objects directly (the session, the
session manager, the model runtime), it is a primitive. If it calls primitives in an order and
talks to VS Code, it is orchestration.

## State the backend owns

The active model identity, the thinking level, and the in-flight run and streaming flags are
owned by the backend and read through the seam (`getModel()`, `getThinkingLevel()`,
`getAgentRunActive()`, `isStreaming()`). PiService applies event-stream mutations through the
setters (`setAgentRunActive`, `setStreaming`, `applyThinkingLevel`). `applyThinkingLevel` updates
the stored level without a wire call, for the echo of a streamed `thinking_level_changed` event.

## Where the seam still leaks

The interface reduced coupling, it is not a complete boundary:

- **`extension.ts`** reaches past it via `PiService.sessionManagerInstance` for clone, fork and
  export session-file work. That is SDK-shaped and not modelled on `PiBackend`.
- **PiService's legacy getters** (`session`, `SDK`, `AI`, `sessionManager`, `settingsManager`,
  `resourceLoader`) read straight from `SdkService`.

## Adding a primitive

1. Add the method to `PiBackend` with a doc comment saying who owns the state.
2. Implement it in `SdkService`.
3. Call it from PiService through the private `backend` accessor.
4. Cover it in the PiService integration tests with the fake backend.

## Related

- [PiService](pi-service.md): the orchestrator that holds the backend
- [Event Translation](event-translation.md): the SDK event stream behind the seam

> **Last updated:** 2026-11-12 — dropped the line count (it drifted); the interface gained `ReloadOutcome` and `reloadNotDoneText`.
> **Earlier:** 2026-11-12 — Second runtime removed (0.2.8): `BackendCapabilities`,
> `backendCapabilityDefaults` and `flipsStateEagerly` deleted; one implementation remains.
> **Earlier:** 2026-08-31 — noted the extension-owned plan/approval state added in 0.2.0 (since removed).
