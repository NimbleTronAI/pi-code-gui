# Open items

> **Status:** evolving

Known gaps that were recorded and deliberately left unfixed, with the founder's call pending.
They come from the batch-0.2.8 contracts (C17, 2026-10-17; the contracts page itself is in git at
commit `69c2e74`). They were not re-verified when the second runtime was removed. Each one is a
candidate for a later release, not a promise.

- **F2: flattened model protocols.** "multi-api providers flattened to models[0].api by the
  generator (openrouter: 381 openai-completions models written as anthropic-messages; also
  fireworks, opencode, opencode-go)". The generator is `scripts/gen-model-registry.mjs`; the output
  is `src/model-registry.generated.json` (see [Model Catalog](../architecture/model-catalog.md)).
- **N1: per-model headers dropped.** "per-model `headers` dropped by the generator".
- **N2: the currency gate fails open.** "the currency gate fails OPEN when npm is unreachable"
  (`scripts/check-currency.mjs`).
- **W1: watch `@earendil-works/pi-durable`** (founder decision 2026-11-12: watch, don't build).
  Earendil's durable agent harness (1.5.2, first published 2026-09-19, labelled "Experimental. The
  API changes without notice between releases"). It commits every turn, tool call and piece of
  state before showing it, so a process that dies mid-turn resumes on reopen; it also has an inbox
  for steers/follow-ups, background subagents and read-only viewers. It is a library for building
  a host, not a Pi package, and pi-coding-agent 1.5.2 does not depend on it. Using it here would
  mean a second backend beside the SDK: its own storage (SQLite/JSONL directories, not Pi
  `.jsonl` sessions, so nothing in Past Sessions), its own extension format (Pi packages, skills
  and the TUI widget bridge would not run), and the 16 bridge tools re-registered as its tools.
  The win would be a turn surviving a window reload or extension-host crash. Revisit when
  pi-coding-agent builds on it, or when it drops the experimental label.
- **N3: custom-message validation.** "custom-message events whose `details` is not an object fail
  schema validation and add a hidden diagnostic card" (`src/shared/protocol.ts`).

## Related

- [Model Catalog](../architecture/model-catalog.md)
- [Event Translation](../architecture/event-translation.md)

> **Last updated:** 2026-11-12 — added W1 (watch pi-durable).
> **Earlier:** 2026-11-12 — new page: the open items from the retired batch-0.2.8 contracts (second runtime removed, 0.2.8).
