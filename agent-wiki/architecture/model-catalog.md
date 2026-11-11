# Model Catalog & the Shared Agent Home

> **Status:** evolving

`src/rust-models.ts` decides what the Rust binary knows about models, and where its
agent home lives. Both answers changed substantially in 0.2.0, and the previous
answers are still described in older material — treat this page as authoritative.

## One agent home, shared with the CLI

Rust sessions run with `PI_CODING_AGENT_DIR` pointing at the user's own
`~/.pi/agent` — the same directory the `pi` CLI uses. Earlier versions relocated it
to an extension-owned folder so that writing the bundled catalog could not clobber a
user's `models.json`. That relocation created a second problem it could not solve:
the binary reads `auth.json` from *its* agent home, so the credential had to be
carried across.

Every mechanism for carrying it was wrong. A symlink is refused outright by rust-pi
0.3.0 (`auth.json must be a regular non-link file`, exit code 1). A copy diverges,
because OAuth refresh tokens **rotate** — whichever copy refreshes first invalidates
the other, and the user meets `invalid_grant` on a credential they never touched. A
hard link is one file and therefore correct, but breaks whenever a writer saves
atomically (rename gives a new inode, `nlink` drops to 1) and is impossible when
`~/.pi` is a different filesystem, making behaviour depend on disk layout.

Sharing the directory removes the problem rather than managing it: one home, one
`auth.json`, nothing to synchronise, identical on every platform.

## The rule (Design S, 0.2.8)

On Rust the extension only **adjusts** models rust-pi already supports, using exactly the
values Pi itself uses. It never adds providers, never moves endpoints, and never shrinks
context windows. Concretely, `setupRustModels` (`src/rust-models.ts`) writes ONE kind of
thing into the shared `models.json`: `providers.<p>.modelOverrides.<id>` = Pi's per-model
values (name, window, output limit, prices, input, reasoning, thinking map, two compat
flags) plus a `_managedBy: "pi-code-gui@<version>"` stamp. No `models` array, no
provider-level key, no connection, no context-budget clamp.

- **Where the values come from** (`src/catalog-source.ts`): the INSTALLED TypeScript Pi's
  catalog, read through a catalog-only `ModelRuntime` (its own `models.json` path never
  exists, so what we wrote is never read back) — whatever its age; the bundled floor
  (`model-registry.generated.json`) only when no TypeScript Pi is installed; otherwise
  "none", and nothing is written that start. "Not installed" means its `package.json` is
  not found at that moment — so a start caught mid-upgrade (`npm i -g`) writes the floor's
  values; the next start with Pi present rewrites them.
- **When.** Only at a Rust session start. It first waits up to 2.5 s for the source
  (`CATALOG_START_BUDGET_MS`, `pi-service.ts` `makeRustDeps().setupModels`) and logs
  `Model catalog for this Rust session: <source>`. A TypeScript session start and a
  catalog refresh never write `models.json` (C28(2), pinned by test). rust-pi reads the
  file only at spawn.
- **Created models.** An override for an id rust-pi does not list makes it create that
  model on its default connection for the provider; that is allowed only where the
  connection equals Pi's for that model (C29), checked against
  `src/rust-pi-catalog.generated.json`, measured from the pinned binary by
  `scripts/gen-rust-pi-catalog.mjs`. Re-run that generator when the rust-pi pin moves AND
  after a pi-ai bump (a new Pi provider gets nothing until it is listed there). Nothing is
  created in a provider object holding the user's own `models` list or connection.
- **Yours is never touched.** Anything without the stamp is the user's: their models,
  overrides, provider objects and any key they add inside one of ours (that whole value
  becomes theirs). Files from 0.2.7 (stamped `models[]`, clamped windows, provider
  connections) migrate once, at the first Rust start.
- **Files we will not write.** A comment, trailing comma, byte-order mark, syntax error or
  wrong shape: never written, and the user is told once that rust-pi ignores the whole
  file. A read-only file or folder: never written, with its own notice.
- **Writing reformats.** When anything changes, the whole file is re-emitted as 2-space
  JSON: every value, key and entry is preserved, but hand layout (spacing, `1.0`, escapes,
  duplicate keys) is not. Nothing changed → nothing is written.

The `/model` fallback list, prices (`activeCostRates`), thinking capability and the
TypeScript session's reconcile read the same source (`PiService.catalogProviders`); a
TypeScript start also waits up to 2.5 s for it.

## The catalog refresh — what it contacts

After any session starts, `catalogSource().refreshInBackground()` runs **Pi's own** catalog
refresh (`ModelRuntime.refresh`), the only network-capable catalog call (C24): at most once
per 4 h per host (the time is kept in `globalState`), deduped, `PI_OFFLINE` and Pi's TTL and
ETags honoured, errors logged and never shown. Like the CLI's own refresh it can contact:

- **pi.dev** — Pi's model-catalog service;
- **openrouter.ai**, with the user's own OpenRouter key or login — their personalised list;
- the **radius gateway** (`/v1/config`), when a radius login exists.

The extension never calls any of these itself. Credentials are read-only: an expiring
login is skipped, never refreshed; a `!command` or `$VAR` key is not resolved; `auth.json`
is never written. Pi stores the result in the shared `<agentDir>/models-store.json`, which
it creates (with the agent dir) on first use, as the CLI does. The next Rust start writes
those values into `models.json`.

**After upgrading Pi**, the catalog this window loaded stays in use until a window reload;
the Pi CLI sees the previous values in `models.json` until the next Rust start.

## Accepted give-ups and residuals

- Providers rust-pi does not support are not offered on Rust.
- `pi-code-gui.contextBudget` is TypeScript-only; Rust compacts at, and shows %, of the
  model's real window.
- Moved endpoints (kimi-coding, opencode, opencode-go) use rust-pi's own endpoint.
- Models Pi has withdrawn but rust-pi still lists stay visible on Rust with rust-pi's values.

## Why the catalog is needed at all

rust-pi's built-in catalog is fixed at its build: it lacks current models and carries
stale prices, windows and thinking maps. The overrides give Rust the same values a
TypeScript tab shows, while every endpoint stays rust-pi's own.

## Cross-reference

- [Runtime Selection](runtime-selection.md) — how a session picks its runtime
- [Session Modes](session-modes.md) — approval mode also lives in this shared home
- [Runtime Debugging](../operations/runtime-debugging.md) — what to check when a model is missing

> **Last updated:** 2026-10-18 — the floor is written when Pi's package.json is missing at that start (e.g. mid-upgrade) (review D N4).
> **Earlier:** 2026-10-18 — Design S (0.2.8): per-model overrides from the installed Pi's
> catalog, written only at a Rust start; the catalog refresh and the hosts it contacts; the
> reformat, read-only and give-up disclosures. Replaces the earlier version's provider
> stamp, credential scoping and context-budget clamp.
> **Earlier:** 2026-10-16 — provider-level stamp, refresh and legacy migration;
> duplicate-identity dedupe (0.2.8, rust-pi v0.8.0).
> **Earlier:** 2026-08-31 — new page. The catalog and agent-home rules were
> undocumented, and the one place that mentioned them (runtime-selection.md)
> described the relocated home and linked auth.json that 0.2.0 removed.
