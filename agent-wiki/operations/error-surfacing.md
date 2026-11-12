# Error Surfacing

> **Status:** stable

The extension can't control which Pi extensions a user installs or how their
provider configs are written, so it must **recognize the common failure shapes
and communicate them clearly** instead of leaking a cryptic SDK throw into the chat.

All classification lives in one pure, vscode-free module,
[`src/extension-errors.ts`](https://github.com/NimbleTronAI/pi-code-gui/blob/main/src/extension-errors.ts),
so it is unit-tested headlessly; the surfaces that *show* the result live in `SdkService` and
`agent-events.ts`.

## Classifiers

| Function | Recognizes | Produces |
|----------|-----------|----------|
| `classifyProviderConfigError(msg)` | the SDK's `Failed to resolve API key for provider X from environment variable: Y` | `{ provider, envVars, title, detail, remediation }` |
| `explainAgentStop(stopReason, errorMessage)` | an assistant turn that ended with `stopReason: "error"`, `"aborted"` or any reason carrying an error message | a note for the chat, or `null` for an ordinary completion |

`humanizeProviderError` composes the classifier into a single user-facing string, so a caller
upgrades a message in place with `humanizeProviderError(raw) ?? raw`.

A tell-tale handled specially: when the missing env var is literally `ENV`, the
provider config is using the obsolete `$ENV:NAME` reference syntax (the current
SDK parser reads `$ENV` as a variable named `ENV`); the remediation points at
the `${NAME}` form.

## Where it surfaces

**Provider-key failures.** A failed turn reaches the UI as
the `message_update` → `error` event in
[`src/agent-events.ts`](https://github.com/NimbleTronAI/pi-code-gui/blob/main/src/agent-events.ts),
the per-turn choke point. That message is upgraded in place via `humanizeProviderError`;
non-provider errors pass through unchanged. The steer/follow-up reject path in `sdk-service.ts` (`sendPrompt`)
gets the same treatment.

**Turns that stop early.** The same file calls `explainAgentStop` on a finished assistant
message. This used to be silence: the webview only handled `"aborted"`, so any other failure
left a reply that trailed off. It is deliberately not an allowlist of benign reasons, because a
novel failure reason would go silent again.

## Test coverage

[`src/test/unit/extension-errors.test.ts`](https://github.com/NimbleTronAI/pi-code-gui/blob/main/src/test/unit/extension-errors.test.ts)
drives the classifiers and formatters with the **exact strings observed in the
log** (regression fixtures); `agent-events.test.ts` covers the in-place
humanization of a provider-key error event.

## Related

- [Logging](logging.md): the channel these also write to
- [Event Translation](../architecture/event-translation.md): the `agent-events.ts` choke point

## Lesson: match severity to intent

A failure notice for something the user deliberately turned off reports a fault where there
was none. When a message describes an outcome the user chose, it should read as a note saying
the outcome was expected; the same failure with the setting on is still an error.

> **Last updated:** 2026-11-12 — Second runtime removed (0.2.8): the stderr load-error
> classifier, its in-chat card and the provenance-naming lesson are gone; `explainAgentStop` documented.
> **Earlier:** 2026-08-31 — added the provenance-naming fix and the
> intent-matched severity rule (both shipped 0.2.0).
