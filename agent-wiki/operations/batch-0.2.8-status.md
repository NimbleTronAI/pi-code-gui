# Batch 0.2.8 — status

> **Status:** evolving

> The record of release 0.2.8: what the branch ships, what was proven, and what was deferred.
> The batch plan (units U1–U5, decisions D1–D6, contracts C1–C13) was retired when the batch
> finished; it was last present at commit `3d0b264`.

## What ships

- **One runtime.** The extension runs Pi through its in-process SDK only. The second runtime,
  its settings and commands, the runtime choice in the UI, plan/approval modes, and the
  clean-room machinery that came with it are gone. The README explains this to users. 0.2.3 is
  the last release that had the second runtime.
- **models.json cleanup** on every start ([SDK Resolution](sdk-resolution.md) for loading;
  `src/managed-models-cleanup.ts`): the entries earlier versions wrote are removed, and nothing
  else changes.
- **Pi 1.5.2:** the bundled catalog is pi-ai 1.5.2, and `testedAgainst` is 1.5.2
  ([findings](pi-1.5.2-findings.md)).
- **Fixes:** the summarization retry card; the 1.3.0 verification fixes; `/tools` no longer
  cuts a reopened session's model history.
- **`/reload` while busy:** `SdkService.reloadContext()` checks `isStreaming`/`isCompacting` and
  returns a `ReloadOutcome`; chat `/reload` and the Reload Context command say "wait" and reload
  nothing (`reloadNotDoneText` in `src/pi-backend.ts`). A turn that starts between the check and
  the call maps Pi's #9222 error to the same outcome.
- **Cost display:** `getUsage()` counts the entries Pi's `getSessionStats()` counts (cache
  warm-ups, compaction and branch summaries, tool results with usage), and reports whether the
  cost was billed by the provider (`totalFromProvider`). `computeUsageStats` shows an all-billed
  cost even where the catalog rules would say `$??`, and sets `costSource`
  (billed/estimated/mixed), which the status chip and Sessions tree explain on hover
  (`src/shared/cost-source.ts`).

## Proven

- `pnpm run package` green at `3d0b264`; 435/435 unit tests. With the `/reload` and cost
  changes, 448/448; with the retry-card and session-name fixes, 455/455.
- The `/reload` guard and the billed-cost path are unit-tested against fakes shaped like the 1.5.2
  dist (`reload()` guard text, `isStreaming`/`isCompacting` getters, `usage` entry shape), read
  from the installed SDK. Not live-run; only OpenRouter sets `totalFromProvider` in pi-ai 1.5.2.
- The models.json cleanup, run on a file shaped the way 0.2.3 writes it (32 providers): 156
  items removed, the user's provider intact, Pi's own loader accepts the result, and a second
  run writes nothing.
- The SDK path ran live on pi-coding-agent 1.5.2: a tool call, compaction, persist, reopen, and
  bridge tools in a resumed session. That run was on the code **before** the runtime removal.
  The founder's manual check of the installed build covers the code after it.
- The `/tools` fix has a red-first test that reopens the session file the way Pi does.
- Acceptance greps: the word appears only in README.md, CHANGELOG.md, agent-wiki/log.md;
  in syntax highlighting for that language's code blocks, kept deliberately (`src/webview/highlight.ts`,
  `src/shared/webview-format.ts` and `src/test/unit/webview-format.test.ts`, plus
  `agent-wiki/architecture/syntax-highlighting.md`); and in the message shown when a restored tab of the
  removed runtime is closed (`src/extension.ts`), which names it because only its former users
  see it. The grep for second-runtime wording is clean.

## Deferred

- Old workspace/global state keys and the extension-installed binary folder from the second
  runtime are inert and left in place. The README promises that upgrading removes nothing from
  disk, and says where the binary lives.
- A models.json under a custom agent folder that only the second runtime used is not cleaned.
- The upstream-currency tooling keeps a `pi-coding-agent (TS backend)` row key, because renaming
  it would post a spurious issue comment.
- Open items not tied to this batch: [Open items](open-items.md).

## Process notes

The batch ran under [Agent Coordination](../discipline/agent-coordination.md). The coordinator's
review of record caught something in most units that the member's own reviewer had passed. In
this batch it found a shared test case dropped along with a deleted file, a user-facing message
that needed wording, and a stale README claim. Keep running it.

Signing: commits go through the founder's 1Password SSH agent. When it refuses, ask the founder to
approve the prompt. Never bypass signing. No push until the founder says so.

> **Last updated:** 2026-11-12 — `/reload` busy check and billed/estimated cost shipped in 0.2.8
> **Earlier:** 2026-11-12 — batch finished; plan retired (last at `3d0b264`)
> **Earlier:** 2026-11-11 — written as the handover before a container restart
