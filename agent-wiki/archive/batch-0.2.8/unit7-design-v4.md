# Unit 7 design v4 — Design S, folded (C27 + C28): adjust what rust-pi has, with Pi's values, and nothing else

Base 61d934e (worktree /workspaces/pi-wt/unit7, read-only). Supersedes v3. v1's CatalogSource and D4 (Rust cost from
the binary) stand as amended in §5. TS Pi = pi-coding-agent 1.3.0 (MIT, read) and 0.80.8 (the floor). rust-pi 0.8.0
(the pin) and 0.5.1: black box only (C3): `--help`, `--version`, RPC `get_available_models` / `get_state` /
`set_thinking_level`, and prompts sent ONLY to a local mock behind a get_state guard. No provider prompt. Scratch
homes only. **The baseline of record is rust-pi with NO models.json** (C28(6)); `{"providers":{}}` measured identical.
Prototypes, probes and outputs: `scratchpad/u7d/` (`scripts/`, `out/`). PROVEN = run here; INFERRED = reasoned.

## 0. Summary

The rule, as approved: *on Rust the extension only adjusts models rust-pi already supports, using exactly the values
Pi itself uses. It never adds providers, never moves endpoints, and never shrinks context windows.*

What that means in practice, measured: v4 **adjusts rust-pi's own models (300 of Pi's ids) and adds Pi's other models
(836) on providers rust-pi already supports, at rust-pi's own endpoint for that provider**. Every model was
override-built under the approved C27 mechanism (`models: []`), so adding them is within the decision; it is stated,
not hidden.

v4 writes ONE thing: `providers.<p>.modelOverrides.<id> = {Pi's per-model values, _managedBy}`, for every model of
every provider in Pi's catalog, at Rust session start only. No `models: []`, no provider-level key, no stamp on
provider objects, no credential scope. Each pass first removes everything we ever wrote, then writes Pi's values.

Deliverable 1, measured against rust-pi 0.8.0 with no models.json (`out/measure-130-final.*`, `connections.mjs`):
- **(a) Endpoints: 0 of 2489 rust-pi models change api or baseUrl.** Same on 0.5.1. With `models: []` planted on one
  provider (zai), E1 turns red at once (§6).
- **(b) B3 no longer exists; zai is narrowed, not gone.** zai: rust-pi's own 10 zai ids stay on its coding endpoint,
  but Pi's 5 newest zai ids (which Pi sends to the coding endpoint) reach rust-pi's zai default, the GENERAL endpoint
  — INFERRED to fail for a coding-plan key. Reported under C27 give-up 3 with the other UNVERIFIED created ids (§4.1)
  for the coordinator to put to the founder or accept; not designed around. B3: the extension never creates a `models` array and removes the ones it emptied, so the only `models` array left is
  one YOU wrote, and rust-pi then treats your file exactly as it would without the extension (E4, `mixed`, proven
  id-by-id against a hand-written "user-only" file). Recorded in §4: an id you override shows rust-pi's own base
  values for the fields you left out.
- **(c) Models rust-pi lists but Pi has withdrawn: 365 stay visible on Rust, with rust-pi's own values** (openrouter
  109, nvidia 67, vercel-ai-gateway 54, xai 22, anthropic 15, google 15, opencode 13, fireworks 12, groq 11, openai 10,
  zai 8, 10 others ≤ 6). That is rust-pi's own catalog, untouched (C28(1)). A stale selection is handled by Unit 5's
  recovery.
- Also measured: **all 1136 Pi models Rust lists show Pi's values exactly** (window, output limit, 4 prices, input,
  reasoning, name: 0 mismatches) — **300 that rust-pi already had, 836 that rust-pi creates from our overrides** on its
  own default connection for that provider (§4.1); 10 providers rust-pi does not know are written and ignored.

**Special cases: 13 in v3 → 11 kept (K1..K11), 9 removed (§3).**

## 1. What the user gets on Rust (per provider kind)

| Kind | Rust shows | Endpoint |
|---|---|---|
| A Pi model rust-pi already lists (300) | Pi's window, output limit, prices, thinking map | rust-pi's own, unchanged (0 of 2489 moved) |
| A Pi model rust-pi does not list (836) | created by rust-pi from our override, Pi's values | rust-pi's default for that provider; 334 on a protocol Pi would not use (§4.1) |
| A rust-pi model Pi withdrew (365) | rust-pi's own values | rust-pi's own |
| A provider rust-pi does not know (10: ant-ling, meta, qwen-token-plan ×3, xiaomi-token-plan ×3, zai-coding-cn, radius) | nothing (C27 give-up 1) | — |
| A provider Pi builds per request (7: amazon-bedrock, azure, cloudflare-ai-gateway, cloudflare-workers-ai, github-copilot, google-vertex, openai-codex) | rust-pi's own catalog, untouched (K7) | rust-pi's own |
| together, opencode-go (rust-pi knows them, ships no models) | Pi's models (15, 29), created by rust-pi; `together` appears beside rust-pi's own `togetherai` (18), one service | rust-pi's own (`api.together.xyz/v1`, `opencode.ai/zen/go/v1`; alive per v3 §1) |

## 2. The algorithm — `mergeModelsJson(doc, source)` (prototype `u7d/scripts/merge-v4.mjs`)

**When.** Only in `setupRustModels()`, which runs at every Rust spawn (rust-service.ts:410), i.e. a Rust session
start or its respawn. Nothing else writes models.json: no TS session, no catalog refresh, no activation (C28(2)).
A live rust-pi never re-reads the file (record N1), so a write affects only that tab's next spawn.

**Source (K9).** TS Pi installed and its catalog-only runtime ready within the start budget (v1's 2500 ms) → that catalog.
No TS Pi installed → the bundled floor (`model-registry.generated.json`). Anything else (installed but not ready,
or failed to load) → **write nothing this start** and log why; the previous file stays valid for rust-pi.

**Read (K8).** ENOENT → `{}`. Unsafe = any other read error; a leading BOM; a strict `JSON.parse` failure; or a shape
either runtime rejects: a top level, `providers`, a provider value, a `modelOverrides` or an override value that is not
an object, a `models` that is not an array, or a `models[]` entry that is not an object. Unsafe → **never write**, and
show this once per window (module flag in rust-models.ts; the warning reaches the chat via rust-service.ts:410-414):

> Your models.json (`<path>`) `<why>`. Rust Pi ignores a file like that completely — including any custom providers
> in it — so Rust sessions use only Rust Pi's built-in models. The extension has not changed the file. To fix it,
> `<fix>`, then start a new Rust session.

| Reason | `<why>` | `<fix>` |
|---|---|---|
| read error | could not be read (`<code>`) | make it a readable file (check its permissions) |
| BOM | starts with a byte-order mark | save it as plain JSON (no comments, no trailing commas, UTF-8 without a byte-order mark) |
| parse | isn't plain JSON (it may have comments, trailing commas or a syntax error) | (same as BOM) |
| shape | isn't shaped like a models file | make the file, its "providers" and each provider JSON objects, each "models" a list and each "modelOverrides" an object |

PROVEN (E6, 8 fixtures; reviewer: EACCES and EISDIR): rust-pi drops the whole file in every case (its stderr names
the error), so "including any custom providers" is measured. TS Pi loads the comment, trailing-comma and BOM files.

**STEP 1 — remove everything we wrote.** "Ours" = a value carrying `_managedBy`. First (K10): a stamped value
holding any key no release ever wrote (outside `id, name, contextWindow, maxTokens, input, cost{4}, reasoning,
thinkingLevelMap, compat{thinkingFormat, forceAdaptiveThinking, thinkingLevelMap}`) was edited by you — it loses only
its `_managedBy` and is yours from then on; a 0.2.8-pre provider-level `_managedBy` is removed the same way. Then, in
every provider object: delete the remaining stamped `models[]` entries and `modelOverrides` values; (K11) a `models`
array or `modelOverrides` object our removal empties is removed with them, and so is a provider object our removal
leaves empty (R-B3 (z); TS Pi rejects an empty provider object, provider-composer.js:156-166).
**Migration (K1)** is one more clause of the same step: an object that holds stamped `models[]` entries and none of
yours was filled by an older release, so its `(api, baseUrl)` is ours **iff** it equals a pair some release shipped for
that provider (`SHIPPED_PAIRS`, 41 pairs from git history v0.2.0..0.2.8, frozen: v4 never writes a connection
again). After that pass the object holds no `models[]` entry of ours, so the clause can never match it again:
migration happens once, with no version flag. Never matched: a connection in an object holding a model of yours, or
any pair we never shipped. Matched although yours: a shipped pair you typed yourself into an object 0.2.7 then filled
(indistinguishable; you move to rust-pi's default — §4).

**STEP 2 — write Pi's values.** For each source provider and each of its models: skip an id you define in that
provider, in `models[]` or `modelOverrides` (K2), comparing `x` and `<provider>/x` as one id (K3) and writing only the
prefixed twin; otherwise set `modelOverrides[id]` to (K6) Pi's fields as they are, absent ones omitted: `{name, contextWindow, maxTokens?, input,
cost{input,output,cacheRead,cacheWrite}, reasoning, thinkingLevelMap?, compat?{thinkingFormat,
forceAdaptiveThinking}, _managedBy}` with `contextWindow` never clamped, `maxTokens` omitted when it is ≥ the window
(K4), and the map top-level with string levels only (K5). Create the provider object (plain, unstamped) only to hold
overrides.

**Never touched:** every key you wrote, anywhere, including keys you add inside an override or object we created
(C28(3), K10); your `models[]` entries; your override values; your provider objects; a `models: []` you wrote. The
exceptions are exactly K1 and K11: an array or object holding only our entries, or a shipped pair inside one, is
treated as ours (§4.5). **Never written:** any
provider-level key, `models: []`, a per-model api/baseUrl/headers, `cost.tiers`, a null map level, a clamp.

**Write.** Serialize; equal bytes → no write. Otherwise re-read the file just before renaming a temp file over it; if
its bytes changed since the read, start over once, and if they changed again, skip this start (a user saving in an
editor, or a second window, is never overwritten). Content depends only on (file, source), so two windows starting Rust
together converge on the same bytes; no in-process queue is needed.

**Size.** 34 providers, 1241 overrides, 667 KB; strict parse 1.6 ms.

## 3. THE SPECIAL-CASE LEDGER (deliverable 2)

| # | Case (record review §4 numbering; + new) | v4 | One-sentence reason |
|---|---|---|---|
| 1 | LEGACY pair table recognising 0.2.7 objects | **KEPT as K1**, merged with R-B2's predicate into one clause; frozen, no runtime floor pairs | 0.2.7 wrote connections unstamped, and leaving them would move rust-pi's endpoints, so the only way to tell ours from a user's is "an object of only our entries, holding a pair we shipped". |
| 2 | `models: []` only on objects we own | **REMOVED** | C28(1); it alone moved 82+ endpoints. |
| 3+13 | `modelOverrides` lingering `{}`; STEP 3 deleting an empty object of ours | **KEPT as K11** (one clause: a container our removal empties is ours) | R-B3 (z) needs it (a leftover `models: []` hides rust-pi's built-ins) and TS rejects an empty provider object; it cannot tell a `models: []` you wrote and 0.2.7 then filled from one 0.2.7 created (§4.5). |
| 4 | "You win" for your id | **KEPT as K2** | Your override and ours would be the same key, and C28(3) says yours stays. |
| 4b+5 | Twin: `x` ≡ `<p>/x`, for dedupe and for "you win" | **KEPT as K3** (one rule) | rust-pi resolves both to one model and applies the two overrides in random order (PROVEN `twin.mjs`: mt 4096 in 4 runs, 30000 in 1). |
| 6 | Placeholder maxTokens omitted | **KEPT as K4** | rust-pi sends a written limit verbatim, so Pi's placeholder (= the window) would replace rust-pi's own 65536/16384 on 5 ids it has (E2/E3 plants). |
| 7 | Thinking map strings-only | **KEPT as K5** | A null level makes rust-pi reject the whole file ("invalid type: null, expected a string"). |
| 8 | Field whitelist | **KEPT as K6** | The rule adjusts per-model values; connection, headers, price tiers and wire-compat keys are how rust-pi talks to the provider, which the rule leaves to rust-pi. |
| 9 | Source excludes 7 providers | **KEPT as K7**, documented; the generator's predicate, one shared function | rust-pi creates Pi-only ids on bedrock and vertex with an EMPTY baseUrl (PROVEN: 166 models, E1 rule 4 + NO_K7 plant); the other five match the same predicate and are a no-op (azure, openai-codex, copilot: 0 created) or templated like rust-pi's own (cloudflare ×2). |
| 10 | Unparseable file → skip | **KEPT as K8** | C28(4); and rust-pi would drop the whole file anyway. |
| 11 | Second entry point (B1 re-merge with `only`) | **REMOVED** | C28(2). |
| 12 | Source selection (installed / floor / defer) | **KEPT as K9**, simplified: no deferral, no floor on failure | With no TS Pi the floor IS Pi's values; with TS Pi installed, writing anything but its catalog would change its CLI's view. |
| new | Credential scope / predicate (C26 NEW-1, `credentialedProviders`) | **REMOVED** | rust-pi lists only providers it has credentials for (PROVEN `scope.mjs`: same providers as with no file), so writing all providers adds nothing to the picker and closes NEW-1 by deletion. |
| new | A key you add inside our override (review B2) | **KEPT as K10**; the 0.2.8-pre provider-stamp removal is the same clause at provider level | C28(3): your key must survive, and a stamped value cannot be half ours, so the whole value becomes yours. |
| new | Writing a provider-level `_managedBy` stamp | **REMOVED** | Not needed once emptied containers are removed. |
| new | In-process write queue (U7-11) | **REMOVED** | Deterministic content + re-read before rename. |
| new | `decideRustMerge` deferral, freshness gate, `only` parameter | **REMOVED** | Consequences of #11/#12. |

**Kept: 11 — K1 migration pair, K2 you win, K3 twin, K4 placeholder limit, K5 string-only map, K6 field list,
K7 per-request providers, K8 unsafe file, K9 source, K10 your key makes a value yours, K11 emptied containers.**
K4, K5 and K6 are one function (`overrideOf`, "what one override carries, in rust-pi's form"): 9 lines if shown so.
The reviewer re-proved or reasoned each and found none removable.

## 4. What the user still sees (residuals, measured; reported, not asked)

1. **Pi ids rust-pi lacks use rust-pi's default connection for that provider.** For 334 of the 836 created ids, Pi
   itself would use another protocol: vercel-ai-gateway 233 (gateway serves both), mistral 16, fireworks 13,
   openrouter 11, xai 4 (documented OpenAI-compatible, alive). **UNVERIFIED per model, carried under C27 give-up 3
   for the coordinator to put to the founder or accept:** opencode 42 (e.g. claude-* ids: Pi anthropic `/inference`,
   Rust chat-completions `/zen/v1`; INFERRED some are not served there), opencode-go 11, kimi-coding 4, and **zai 5**
   (glm-5-turbo, glm-5.2-highspeed, glm-5.3, glm-5.3-flash, glm-5.3-highspeed: Pi coding endpoint, Rust
   `api.z.ai/api/paas/v4`, beside rust-pi's own 10 zai ids on the coding endpoint). The live acceptance (§6) covers
   none of them: its two calls are deepseek.
2. **An id you override** shows rust-pi's own values for the fields you did not set (rust-pi's own sonnet-4.6 price
   is 0), exactly as without the extension (K2).
3. **Null thinking levels** (Pi: "unsupported") cannot be written (K5): rust-pi sends the level as-is where TS clamps
   it (gpt-5.4 @minimal: TS `low`, Rust `minimal`). `off`→`none` is never sent by rust-pi, map or not. groq sends no
   effort at all. All PROVEN on the mock; none changes with or without our map (`scan.json`).
4. **After you upgrade Pi, the CLI sees the previous version's values until your next Rust session start** (PROVEN
   drift arm: 419 differing paths, 0 after the next merge). Same for a CLI store refresh. C28(2) accepts this.
5. **Migration happens at your first Rust session start on 0.2.8.** A user who never starts Rust again keeps 0.2.7's
   entries (clamped windows) in the CLI's view — pre-existing, and C28(2) forbids a TS-triggered write.
5. **K1/K11 edges (indistinguishable from ours):** a `models: []` you wrote that 0.2.7 then filled is removed, so
   rust-pi's built-ins reappear for that provider; an empty `modelOverrides: {}` you wrote is removed after a pass
   whose source lacks that provider; a shipped pair you typed into an object 0.2.7 filled moves you to rust-pi's
   default. An object that keeps 0.2.7's pair because it holds a model of yours keeps ALL of rust-pi's built-ins for
   that provider on that pair (pre-existing; the conservative choice).
6. **An override you edited (K10) is yours whole**, including the old values we had written in it; a level you add
   inside our `thinkingLevelMap` cannot be told from ours and is replaced.
7. **together**: rust-pi lists its own models under `togetherai` and Pi's under `together` (two names, one service).
8. `pi-code-gui.contextBudget` is TypeScript-only (C27 give-up 2); Rust's % uses the real window.

## 5. BUILD PLAN — A → B → C → D → E; disjoint files; red first (v3 minus 13 tests, minus every C11 one-liner)

- **A, catalog source** (new: `src/catalog-source.ts`, `src/test/unit/catalog-source.test.ts`). v1 as amended: a
  catalog-only runtime (non-existent modelsPath, shared store), read-only credentials, `refreshInBackground` with no
  `allowNetwork`/`force`/`catalogBaseUrl` (C24), host throttle, `createCatalogSource({ piPackagePath? })` (the seam E
  uses for 0.80.8). DELETED: freshness gate, bundled-connection carriage, `decideRustMerge`. Red first:
  `providers() returns the installed Pi's catalog whatever its age`; `providers() is "none" while not ready and the
  floor only when no TS Pi is installed`; `providers() excludes a provider with a templated baseUrl, a special api or
  github-copilot` (shared with the generator); `refreshInBackground never passes allowNetwork, force or catalogBaseUrl`;
  `refreshInBackground dedupes and throttles`; `catalog refresh never writes auth.json`.
- **B, merge** (sole owner `src/rust-models.ts`, `src/test/unit/rust-agent-home.test.ts`). `setupRustModels()` keeps
  its signature, so **no C11 one-liners** (v3's three are gone). `credentialedProviders`, `RUST_SUPPORTED_APIS`,
  `apisUnsupportedByRust`, `refreshConnection`, `LEGACY_PROVIDER_CONNECTIONS` are deleted; `SHIPPED_PAIRS` added.
  Red first:
  `every source model is written as one stamped modelOverrides entry and nothing else is written`;
  `no provider-level key and no models array is ever written`;
  `the override carries Pi's values: window unclamped, string-only top-level map, two compat flags, no tiers`;
  `a placeholder maxTokens (>= window) is omitted; a real one is written`;
  `x and <provider>/x are one id: only the prefixed twin is written, and your override of either wins`;
  `your models[] entry and your override for an id are byte-identical and ours is not written`;
  `a key you add inside an object we created survives, and the object is not deleted` (R-B2);
  `a key you add inside our override (top level, cost, compat) survives, and that id becomes yours` (K10);
  `your provider object keeps every key: baseUrl, api, headers, apiKey, models: []` (R-B2);
  `a models array or modelOverrides object our removal empties is removed; one you wrote empty stays` (R-B3 z);
  `migration: an object of only our models[] entries loses a shipped pair; any other pair stays`;
  `migration: an object holding a model of yours keeps its connection`;
  `0.2.8-pre provider _managedBy is removed`; `a provider object left empty is removed`;
  `running the merge twice yields identical bytes`;
  `a comment, trailing comma, BOM, a non-ENOENT read error, or a non-object provider, models entry, modelOverrides or
  override value, or a non-array models: never written, bytes and mtime unchanged, one warning per window, with the
  exact why and fix text for each of the four reasons`;
  `a file changed between read and rename is re-merged once, never overwritten`;
  `setupRustModels writes nothing when the source is not ready`.
- **C, Rust service + cost** (`src/usage-stats.ts`, `src/model-catalog.ts` comment, `src/rust-service.ts` C11 hunks:
  `accumulateUsage`, the display-window clamp at :1382 with its rationale comment at :1370-1381 rewritten to
  "contextBudget is TypeScript-only"; their tests). v1 D4/R4 tests plus `the Rust context window shown is the model's
  real window whatever contextBudget is`.
- **D, wiring** (`pi-service.ts`, `sdk-service.ts`, `model-picker.ts`, `extension.ts`, `rust-doctor.ts`,
  `webview-panel.ts` budget picker text, `package.json` contextBudget description only, wiki
  `architecture/runtime-selection.md`, the model-catalog page, `log.md`). v1 D tests MINUS every re-merge test, PLUS
  `initializeRust awaits prepare (2500 ms) before setupModels`, `a TS session start and a catalog refresh never write
  models.json` (C28(2)), `the budget picker says TypeScript sessions only`. Rule 8: revert each call site alone.
- **B..D land together.** Between B and D production writes nothing (no `prepare` wired yet, source "none"); gates stay
  green (C7), and C12's consumer is D's `prepare` in `initializeRust`.
- **E, verification** (new `scripts/catalog-e2e/*.mjs`, opt-in, SKIP when the binary or TS Pi is absent). Prerequisite
  `pnpm run compile-tests`; run as `node --import ./scripts/vscode-register.mjs scripts/catalog-e2e/<x>.mjs` (the stub
  `test:unit` uses; `out/rust-models.js` imports vscode). Scripts take the source ONLY from compiled
  `out/catalog-source.js` (no local filter, so a production K7 change is visible) and the merge from
  `out/rust-models.js`; 0.80.8 via `createCatalogSource({ piPackagePath })`. package.json is not touched.

## 6. PHASE E — checks, PASS rules, and every plant RED (deliverable 5; run on the prototypes now)

Runner: `u7d/scripts/run-e.sh`. Plants are env switches in `merge-v4.mjs` / `unsafe.mjs`.

| Check | PASS rule | Clean |
|---|---|---|
| **E1 `connections.mjs`** (promise 2, endpoints) | vs rust-pi with NO models.json: 0 ids change (api, baseUrl with `/v1/messages` normalised); no provider appears that rust-pi alone lists none for, except golden {together, opencode-go}; no listed model has an empty baseUrl unless rust-pi alone lists it so; stderr empty | GREEN, 0 moved, 0 empty, 0.8.0 and 0.5.1 |
| **E2 `values.mjs`** (promise 2, values) | FILE: every override equals Pi's values in rust's form, no forbidden key, never both twins. RUST: every listed Pi model (1136) shows Pi's cw, prices, input, reasoning, name, and real output limit; a placeholder keeps rust-pi's own limit; file loads | GREEN, 0.8.0 and 0.5.1 |
| **E3 `wire.mjs`** (promise 2, on the wire, local mock) | "ts": rust's effort fields equal TS Pi's (`ModelRuntime.completeSimple` to the same mock) and max_tokens = Pi's limit (deepseek-v4-pro high, max; gpt-5.4 xhigh; sonnet-4.6 high, minimal). "carry": the source map's level value reaches rust's wire (3 apis). "own": a placeholder keeps rust-pi's own limit (baseten Kimi-K2.5: 65536, not 262000) | GREEN 9/9 |
| **E4 `migration.mjs`** (promise 3) | 0.2.7, 0.2.8-pre and mixed (now with a key you added inside our override) fixtures, each with a hand-written user-only twin: every user value deep-equal; nothing left but stamped overrides; idempotent; rust lists every user id exactly as from user-only; rust's built-ins keep their connection; TS view (E5 with USER=user-only) 0 diffs | GREEN 3/3, TS 0/0/0 diffs |
| **E5 `ts-parity.mjs`** (promise 1) | TS default view (every model field, getProviders, auth status, compat request config) before = after; getError null | GREEN: 1.3.0 3407 keys, 0.80.8 2210 keys, 0 diffs |
| **E6 `unsafe.mjs`** (promise 3, C28(4)) | 8 unsafe fixtures (comment, trailing comma, BOM, syntax, providers array, provider null, modelOverrides array, models object): never written (bytes, mtime), one message, the reason's own why/fix | GREEN |

Plants (C28(6): the record review's four, then one+ per promise). Every one RED:

```
[endpoint movement vs rust's own]  MODELS_EMPTY=zai  -> E1 RED  moved 2: zai/glm-4.7 coding/paas/v4 -> api/paas/v4
                                   WRITE_CONN=kimi-coding -> E1 RED  kimi-coding/k2p5 anthropic /coding -> openai /coding/v1
[dropped thinking map]  DROP_MAP   -> E2 RED  fileBad 584 (ant-ling/Ring-2.6-1T.map want {"high":"high","xhigh":"xhigh"} got undefined)
                                   -> E3 RED  3 failed: deepseek/openai/anthropic [carry] rust sent high, not max/xhigh/max
[placeholder maxTokens] PLACEHOLDER_MT -> E2 RED fileBad 142, rustBad 5 (baseten/moonshotai/Kimi-K2.5: mt 262000, rust-pi's own 65536)
                                   -> E3 RED  1 failed: baseten Kimi-K2.5 max_tokens 262000
[lost user connection]  WIPE_USER_CONN -> E4 RED mixed: openrouter.baseUrl "https://my-proxy.example/v1" -> undefined
                        V3_STRIP (v3's STEP 1) -> E4 RED mixed: xai.baseUrl "https://my-xai-proxy.example/v1" -> undefined
[promise 1, CLI unchanged] CLAMP   -> E5 RED 1200 differing paths (model.contextWindow); E2 RED fileBad 1202, rustBad 1101
[promise 2, Rust = Pi]     NULL_MAP -> E2 RED rust-pi rejects the file ("invalid type: null, expected a string"), rustBad 374
                           NO_TWIN  -> E2 RED "openrouter: overrides both auto and openrouter/auto"
[promise 3, yours kept]    OVERWRITE_USER -> E4 RED anthropic.modelOverrides.claude-sonnet-4-6 changed; rust name "my sonnet" lost
                           KEEP_EMPTY_MODELS (R-B3 z) -> E4 RED v027/v028pre/mixed: "<p>.models: left behind"
                           LENIENT (writes a JSONC/BOM file) -> E6 RED comment/trailingComma/bom: result=written untouched=false
  (review folds)           DROP_FOREIGN (B2) -> E4 RED mixed: groq.modelOverrides.llama-3.1-8b-instant changed; rust cw 2000 -> 131072
                           SHALLOW (B3, v4's old check) -> E6 RED providersArray/providerNull/overridesArray/modelsObject: result=written
                           NO_K7 (S1) -> E1 RED emptyBaseUrl 166 (google-vertex/gemini-3.1-flash-lite, ...)
                           WRITE_MODELS=meta (N7) -> E1 RED newProviders ["meta"]
[residual demo, not a bug] drift: merged from 0.80.8, viewed by 1.3.0 -> 419 paths, 0 after the next Rust-start merge
```

**16 plants, 19 red check-runs, 0 plants survived** (the reviewer re-ran 5 of them red independently). Live acceptance (v3 §5f) stands unchanged for the coordinator:
the production entry, env stripped to one key, a mandatory `LIVE=0` mock dry run, then exactly two real calls, once.

## 7. The three promises (deliverable 6) — each verifiable by trying the extension

1. **Your Pi CLI and TypeScript sessions show the same models, prices and limits as without the extension** (after a
   Pi upgrade or Pi's own catalog refresh, again from your next Rust session start).
2. **In a Rust tab, a model shows the same window, price and thinking levels as in a TypeScript tab, and talks to the
   endpoint rust-pi itself uses for that provider** (except levels Pi marks unsupported, which rust-pi sends as-is;
   models only rust-pi has keep rust-pi's values).
3. **Nothing you wrote in models.json is changed or removed; if the file isn't plain JSON, the extension leaves it
   alone and tells you once why Rust can't read it.**

Proposed CHANGELOG lines (C4): "Rust sessions now use your installed Pi's model prices, limits and thinking levels,
and keep Rust Pi's own endpoints." / "The context budget setting now applies to TypeScript sessions only."

## 8. Record review fold (`unit7-design-v3-record-review.md`)

- **R-B1** folded by C28(1): no `models: []`; re-measured against the no-file run (§0, E1 with a `models: []` plant).
- **R-B2** folded: the connection clause matches only objects of only-our entries holding a shipped pair; keys you add
  anywhere stay; E4 compares every key against a hand-written user-only file; v3's STEP 1 planted → RED.
- **R-B3** folded: both questions withdrawn (C28(1)) and re-checked — neither exists (§0(b)); (z) is STEP 1's
  container clause (KEEP_EMPTY_MODELS plant RED).
- **S1** BOM, non-ENOENT errors and non-object `providers` are unsafe; the message says rust drops the whole file,
  custom providers included (measured); the re-merge path no longer exists. **S2** writes only at Rust start; the
  CHANGELOG line no longer claims the CLI is untouched; read-then-rename race closed. **S3** K7 documented and proven,
  red test in A, E1/E2 cover it. **S4** E2/E3 now fail on a dropped map and a written placeholder (reds above); baseline
  of record = rust-pi with no models.json. **S5** one behaviour for every provider object. **S6** seam
  `createCatalogSource({ piPackagePath })`, prerequisite stated, E4 comparator = user-only twin, E5 widened.
- **N1** recorded (§2 When). **N2** store read only via ModelRuntime (C24). **N3** the container clause keeps TS from
  an empty object. **N4** an object holding your model keeps its connection. **N5** re-derived against the no-file run.
  **N6** contextBudget: covered by the CHANGELOG line; no new chat line (simplicity).

## 9. Rule-10 review fold (`unit7-design-v4-review.md`, top tier, foreground: BUILD-WITH-CHANGES, 3 B / 5 S / 8 N)

All folded; no redesign, no new founder question.
- **B1** text: 300 adjusted / 836 created everywhere (§0, §1); rule restated; zai "narrowed, not gone", reported under
  give-up 3 (§0(b), §4.1); promise 2 says "the endpoint rust-pi itself uses for that provider".
- **B2** K10 clause (§2 STEP 1, §3), red test (§5), E4 fixture, plant DROP_FOREIGN → RED.
- **B3** K8 widened to every level we read or write (§2), 3 E6 fixtures, plant SHALLOW → RED.
- **S1** E1 rule 4, NO_K7 plant → RED, K7 reason corrected, E takes the source only from compiled catalog-source.
  **S2** K11 ledgered (with its residuals, §4.5); the 0.2.8-pre provider stamp folded into K10, not a separate case;
  K1's "never matched" corrected. **S3** per-reason why/fix table (§2). **S4** UNVERIFIED list in §4.1 and the
  hand-back; live acceptance covers none. **S5** `--import ./scripts/vscode-register.mjs` (§5 E).
- **N1** K4..K6 = one function (§3). **N2** Pi's fields written as-is, no invented defaults (§2; merge-v4.mjs).
  **N3/N4** promise wording (§7). **N5** §4.5. **N6** B..D land together, 2500 ms (§5). **N7** WRITE_MODELS plant
  → RED. **N8** together/togetherai in §1.
- Not folded: the reviewer's suggestion to drop the 0.2.8-pre clause as "dev builds only" — the founder's own dev
  container file carries 0.2.8-pre stamped objects, and under K10 the clause costs no extra case.
