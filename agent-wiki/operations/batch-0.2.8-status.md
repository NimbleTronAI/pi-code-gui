# Batch 0.2.8 — status and next steps

> **Status:** evolving

> Handover page. Written 2026-11-11 before a container restart, so a fresh session can resume from
> the repo alone. Read this first, then the archive it links.

## Where things stand

- **Branch:** `release/0.2.8` (pushed; **no PR** — the founder decides when). Rebased on main 0.2.7.
- **The founder's decision (2026-11-04): 0.2.8 drops Rust Pi entirely.** 0.2.3 is locked as the last
  release that supported the Rust interfaces. Much of what is committed on this branch is Rust work
  that the removal will delete — it is kept in history, not because it ships.
- **Tests:** 819 passing at the last full run (phase D landed).
- **README:** rewritten for the removal and approved by the founder — a one-line pointer near the
  top, and a "Rust Pi support has ended" section (why, apology, three ways to keep Rust Pi incl.
  forking `v0.2.3`, cleanup) near the bottom, above Credits.
- **CHANGELOG `[0.2.8]`:** still describes Rust features. Rewrite it as part of the removal.

## What this branch contains (oldest first, since main)

| Work | Ships in 0.2.8? |
|---|---|
| Catalog refreshed to pi-ai 1.3.0 (Unit 1) | yes — and needs bumping to **1.4.0** (see below) |
| TypeScript runtime verified on pi-coding-agent 1.3.0; entry_appended and ModelRuntime fixes (Unit 2) | yes |
| Summarization-retry shown as a retry, not a junk card (Unit 6) | yes |
| rust-pi pin, startup diagnostics, managed install, stale-default recovery (Units 3–5) | **no — remove** |
| Catalog source backed by Pi's ModelRuntime (Unit 7 phase A) | decide in the removal plan — it was built to feed Rust |
| Overrides-only merge into the shared models.json (phase B) | **no — remove**; but see "Cleanup" below |
| Rust cost from the binary; `$??` rules (phases C, D) | **no — remove** |
| Coordination protocol + documentation discipline (agent-wiki/discipline) | yes (repo law) |

## Next steps, in order

1. **Wait for the founder's signal**, then build the Rust **removal plan** (not before). Its inputs:
   [archive/batch-0.2.8/rust-removal-inputs.md](../archive/batch-0.2.8/rust-removal-inputs.md).
   Acceptance: afterwards `rust` appears only in README.md, CHANGELOG.md and agent-wiki logs. Scope
   includes the clean-room policy and its machinery, the devcontainer Rust provisioning, every
   `rust*` setting and source file, and redrawing `media/architecture.svg`.
2. **Cleanup the removal release must do:** on first start, delete every entry carrying
   `"_managedBy": "pi-code-gui@…"` from `~/.pi/agent/models.json` (and providers left empty), touching
   nothing else — the README already promises this. Phase B's migration code recognises exactly these
   entries and is the starting point.
3. **Bump the catalog to pi-ai 1.4.0** (Unit 1's shape: `pnpm add -D @earendil-works/pi-ai@1.4.0` +
   `gen:model-registry`, both together). Proven clean on a scratch copy — findings:
   [archive/batch-0.2.8/pi-1.4.0-findings.md](../archive/batch-0.2.8/pi-1.4.0-findings.md).
4. **Verify the TypeScript runtime live on 1.4.0** before moving `src/pi-sdk-version.json`
   `testedAgainst` to 1.4.0 (one trivial prompt, as Unit 2 did for 1.3.0). Also exercise resumed
   sessions' bridge tools (1.4.0 re-enables them, pi#11062 — never run live).
5. **Rewrite CHANGELOG `[0.2.8]`** for what actually ships, per
   [Documentation Discipline](../discipline/documentation-discipline.md).
6. Consider (optional, from the 1.4.0 findings): validate any models.json we write against Pi's
   shipped `models.schema.json`; cite Pi's documented override contract.

## Open items not tied to Rust

From the contracts note C17 (the full list is in the archived contracts): 381 OpenRouter models
flattened to one protocol by the generator (F2); per-model `headers` dropped (N1); the currency gate
fails open when npm is unreachable (N2); custom-message events with non-object `details` fail
validation (N3).

## Process notes

The batch ran under [Agent Coordination](../discipline/agent-coordination.md). Its contracts note,
with every ruling and decision, is archived:
[archive/batch-0.2.8/contracts-batch-0.2.8.md](../archive/batch-0.2.8/contracts-batch-0.2.8.md).
The catalog design history (spike → Design S v4) is in the same folder. The review of record caught
a real defect in nearly every unit that the member's own reviewer had passed — keep running it.

Signing: commits and pushes go through the founder's 1Password SSH agent; when it refuses, ask the
founder to approve the prompt — never bypass signing.

> **Last updated:** 2026-11-11 — written as the handover before a container restart
