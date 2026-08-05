# Error Surfacing

> **Status:** stable

The extension can't control which Pi extensions a user installs or how their
provider configs are written, so it must **recognize the common failure shapes
and communicate them clearly** — instead of leaking a raw stderr flood (Rust
runtime) or a cryptic SDK throw (TypeScript runtime).

All classification lives in one pure, vscode-free module —
[`src/extension-errors.ts`](https://github.com/NimbleTronAI/pi-code-gui/blob/main/src/extension-errors.ts) —
so it is unit-tested headlessly; the surfaces that *show* the result live in the
runtime services.

## Classifiers

| Function | Recognizes | Produces |
|----------|-----------|----------|
| `classifyProviderConfigError(msg)` | the SDK's `Failed to resolve API key for provider X from environment variable: Y` | `{ provider, envVars, title, detail, remediation }` |
| `classifyRustLoadError(line)` | a Rust-stderr extension/skill load line | `{ kind, packageName?, detail, remediation? }` where `kind` is `digest-mismatch` \| `unsupported-module` \| `load-failed` |

Two `humanize*` / `format*` helpers compose these into a single user-facing
string (`humanizeProviderError`, `humanizeRustLoadError`, `formatRustLoadError`),
so a caller upgrades a message in place with `humanizeX(raw) ?? raw`.

A tell-tale handled specially: when the missing env var is literally `ENV`, the
provider config is using the obsolete `$ENV:NAME` reference syntax (the current
SDK parser reads `$ENV` as a variable named `ENV`); the remediation points at
the `${NAME}` form.

## Where it surfaces

**TypeScript runtime — provider-key failures.** A failed turn reaches the UI as
the `message_update` → `error` event in
[`src/agent-events.ts`](https://github.com/NimbleTronAI/pi-code-gui/blob/main/src/agent-events.ts)
(the per-turn choke point both runtimes drive). That message is upgraded in
place via `humanizeProviderError`; non-provider errors pass through unchanged.
The steer/follow-up reject path in `pi-service.ts` gets the same treatment.

**Rust runtime — extension-load failures.** `RustProcess` (`src/rust-process.ts`)
classifies each stderr line. The **first** occurrence of a unique
`(kind, package)` failure is reported once — a clean `piWarn` plus an
`onLoadError` callback — while repeats and pi's own multi-line `Remediation:`
hint drop to `debug`. `RustService` wires `onLoadError` to a single in-chat
`custom-message` card (`⚠ Pi extension "…" failed to load (…)`). This replaces
the prior raw `[rust-stderr]` flood on every session open.

## Test coverage

[`src/test/unit/extension-errors.test.ts`](https://github.com/NimbleTronAI/pi-code-gui/blob/main/src/test/unit/extension-errors.test.ts)
drives the classifiers and formatters with the **exact strings observed in the
log** (regression fixtures); `agent-events.test.ts` covers the in-place
humanization of a provider-key error event.

## Related

- [Logging](logging.md) — the channel these also write to; `[rust-stderr]` source
- [Event Translation](../architecture/event-translation.md) — the `agent-events.ts` choke point
- [Runtime Selection](../architecture/runtime-selection.md) — the Rust subprocess + stderr plumbing

> **Last updated:** 2026-06-25 — initial page: pure `extension-errors.ts`
> classifiers; TS provider-key failures humanized at the agent-event choke
> point; Rust load failures deduped in `RustProcess` and surfaced once as an
> in-chat card via `RustService`.
