# Model Catalog & the Shared Agent Home

> **Status:** evolving

`src/model-registry.generated.json` is the extension's bundled model catalog, and
`src/model-catalog.ts` holds the pure helpers that read it. The Pi SDK the extension loads keeps
its own live catalog; the bundled one is the extension's authoritative copy of what each model
owner publishes (prices, thinking tiers).

## One agent home, shared with the CLI

Sessions run in-process on the user's installed Pi SDK, which uses Pi's agent home (`getAgentDir()`,
by default `~/.pi/agent`, or `PI_CODING_AGENT_DIR`): the same directory the `pi` CLI uses. The
SDK's `ModelRuntime` (created in `SdkService`) reads the user's `models.json` and `auth.json`
there, so models, credentials and OAuth refreshes are shared with the CLI. The extension keeps
no copy of either and writes neither.

## What the bundled catalog is used for

`PiService.catalogProviders` returns the bundled registry's `providers`. It is generated from
pi-ai by `pnpm run gen:model-registry` (`scripts/gen-model-registry.mjs`), and
`pnpm run check:model-registry` verifies it is current. Its consumers:

- **Thinking capability.** `reconcileThinkingCapability` upgrades a model the SDK reports as
  non-reasoning when the catalog knows it reasons (a custom `models.json` entry that omits
  `reasoning` makes the SDK default it to `false`, which would clamp the level to "off" and
  collapse the picker). It never downgrades a model the SDK already reports as reasoning.
- **Cost rates.** `findCatalogModelCost` fills the rates of a resumed model whose `models.json`
  entry omits `cost`, since the SDK would then default them to zero and show no cost.
  `activeCostRates` feeds the status-bar cost. A model whose published price the four flat rates
  cannot express (native `deepseek`, billed by time of day) is withheld and shows `$??`
  (`catalogRatesAreUnexpressible`, `costWithheldReason`).
- **`/model` fallback.** When the SDK's auth-filtered list is empty, the fallback list is built
  from the catalog.
- **Currency nudge.** `TARGET_PI_AI_VERSION` is the pi-ai version the bundled catalog was
  generated from. A user whose installed SDK carries an older pi-ai is told so once per window
  (`piAiVersionNotice`).

`pi-code-gui.contextBudget` (when above 0) replaces the active model's `contextWindow` with the
chosen budget, so compaction happens at that size.

## Cleaning up after earlier versions

Pi Code Gui 0.2.0 through 0.2.8 pre-releases wrote entries into the user's `models.json`. Those
entries outlive the feature, and Pi reads that file, so `src/managed-models-cleanup.ts` removes
them at every startup (`cleanupManagedModelsAtStartup`, run from `activate()`; it never throws and
logs its outcome). The rule:

- An entry stamped `_managedBy: "pi-code-gui@<version>"` is ours and goes, unless the user added a
  key we never write, which makes it theirs (kept whole).
- A provider's `api` plus `baseUrl` that 0.2.x filled in unstamped goes only when it is a pair we
  shipped for that provider and every entry in its `models` list is ours and unedited; the
  provider's other keys stay.
- Providers and containers our removal empties go too. Everything else is kept value for value.
- A file that is not strict JSON in the shape of a models file, or is read-only, is never written;
  the log says why. Nothing to remove means nothing is written.

## Cross-reference

- [PiService](pi-service.md): `catalogProviders`, `activeCostRates`
- [Runtime Debugging](../operations/runtime-debugging.md): what to check when a model is missing
- [SDK Resolution](../operations/sdk-resolution.md): where the SDK comes from
- [Open items](../operations/open-items.md): known gaps in the generated catalog

> **Last updated:** 2026-11-12 — Second runtime removed (0.2.8): page rewritten for the single
> in-process runtime; the `models.json` override writer, the catalog-source and the background
> refresh are gone; the startup cleanup is documented.
> **Earlier:** 2026-10-18 — Design S (0.2.8): per-model overrides written at a start of the second runtime (removed).
> **Earlier:** 2026-08-31 — new page: shared agent home rule.
