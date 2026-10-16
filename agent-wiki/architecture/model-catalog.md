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

## Merge, don't rewrite

Because the home is now the user's, `models.json` is theirs. The extension **merges**
per-model entries into it, each stamped `_managedBy: "pi-code-gui@<version>"`:

- an entry carrying the marker is ours, and is refreshed on each session start;
- an entry **without** it is the user's and is left exactly as found, even when its
  id collides with one we manage — deleting the marker takes an entry out of
  management permanently.

**Provider objects carry the same stamp (0.2.8).** A provider's `baseUrl` and `api` used
to be filled only when absent, so a catalog bump that moved an endpoint never reached a
user who already had the provider: the stamped models were refreshed with the new compat
while the provider kept the old endpoint — a mixed entry. Now a provider object we create
is stamped; a stamped one has `baseUrl`/`api` rewritten from the catalog on every session
start; an unstamped one is migrated (and stamped) only when its `(api, baseUrl)` exactly
equals a pair an earlier release bundled (`LEGACY_PROVIDER_CONNECTIONS` — kimi-coding,
opencode, opencode-go, moved by pi-ai 1.3.0). Any other unstamped provider is the user's.
To keep your own endpoint on a provider we created, delete its `_managedBy` — like a
stamped model, a stamped provider is rewritten on every session start.

**One entry per model identity.** rust-pi canonicalises a bare (slash-free) id to its
provider-prefixed form and rejects the **whole** file — every provider, with only a
stderr warning — when both are present ("duplicate canonical model identity"). The
bundled openrouter catalog carries both `auto` and `openrouter/auto`; the merge keeps the
prefixed one and retires the bare alias; when the *user* has written one of the pair by
hand, theirs is kept and ours is not written. Only a bare (slash-free) id is a twin:
`vendor/model` and `openrouter/vendor/model` are two identities and both are written.
Measured on 0.5.1 and 0.8.0.

Entries are written only for providers the user can authenticate to
(`credentialedProviders`): env keys derived as `<ID>_API_KEY`, with five irregular
ones mirroring `pi --list-providers`, plus any OAuth entry in the shared `auth.json`.
Describing all 963 bundled models wrote ~501 KB for models the user could not reach;
scoped, a typical machine gets ~1.6 KB for one provider.

## Why the catalog is needed at all

rust-pi 0.3.0 ships 94 built-in models and **none of the DeepSeek V4 family**, so the
merged entries are what make current models reachable. They also carry metadata a
live `--fetch-models` cannot supply: `contextWindow` clamped to the context budget
(so auto-compaction fires where the user set it), a real `maxTokens`, and the
`thinkingLevelMap` / `thinkingFormat` the picker and the binary both need.

## Cross-reference

- [Runtime Selection](runtime-selection.md) — how a session picks its runtime
- [Session Modes](session-modes.md) — approval mode also lives in this shared home
- [Runtime Debugging](../operations/runtime-debugging.md) — what to check when a model is missing

> **Last updated:** 2026-10-16 — provider-level stamp, refresh and legacy migration;
> duplicate-identity dedupe (0.2.8, rust-pi v0.8.0).
> **Earlier:** 2026-08-31 — new page. The catalog and agent-home rules were
> undocumented, and the one place that mentioned them (runtime-selection.md)
> described the relocated home and linked auth.json that 0.2.0 removed.
