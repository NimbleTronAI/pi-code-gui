# Pi (TypeScript) 1.3.0 → 1.4.0 — changelog, risks, opportunities for batch 0.2.8

Researched 2026-10-29. Read-only on the repo. Evidence lives in `scratchpad/p140/` (absolute paths below).
P = `scratchpad/p140`.
The 1.3.0 comparison install is `$P/ca130` (`npm i --ignore-scripts @earendil-works/pi-coding-agent@1.3.0`); the 1.4.0
one is the container's global install. The repo was copied to `$P/repo` (node_modules symlinked or overlaid), and every
run used scratch homes, PI_OFFLINE or a stubbed `fetch`. No prompt was sent to any provider. No rust-pi source was read.

## Verdict
**1.4.0 breaks nothing the batch depends on: the SDK surface, the events, ModelRuntime, the models-store and the override
semantics are all PROVEN unchanged or still green. One thing must change before 0.2.8 ships: the bundled catalog is
pi-ai 1.3.0, and the strict publish gate now FAILS (PROVEN, rc=1).** The fix is mechanical, and it was test-run in scratch: 819/819 pass.

## 1. Changelog (quoted verbatim; sources: installed `pi-coding-agent/CHANGELOG.md` §[1.4.0] — identical to upstream
tag v1.4.0 (`diff` clean); pi-ai and pi-agent-core from upstream `packages/{ai,agent}/CHANGELOG.md?ref=v1.4.0`, since the
installed pi-ai ships no CHANGELOG). Released 2026-10-21. No 1.3.x patch releases exist between the two versions.

### BREAKING (all from pi-ai; pi-coding-agent declares none)
- "Renamed provider request option `telemetryContext` to `telemetry?: TelemetrySpan`, without a compatibility alias."
- "The default `User-Agent` is now `pi/<version> (<platform>; <runtime>; <arch>)` … and `@earendil-works/pi-ai/utils/pi-user-agent` (`getPiUserAgent()`) is removed; use `formatUserAgent()`."
- "`resolveTranscriptTools()` now takes a `TranscriptToolSupport` (`"none"`, `"additions"`, or `"changes"`) instead of a boolean, and `TranscriptTools.anchorsAdditions` is replaced by `foldedSystemMessages`…"
→ **None hits us** (PROVEN: `grep` of src/ and media/ finds no `telemetryContext`, `getPiUserAgent`, `pi-user-agent`,
`resolveTranscriptTools` or `anchorsAdditions`. rust-install.ts sends its own `"User-Agent": "pi-code-gui"`).

### Behaviour changes (pi-coding-agent "### Changed")
- "Provider attribution headers now come from pi-ai's client identity. Extensions' `before_provider_headers` handlers no longer see the OpenRouter, NVIDIA NIM, and OpenCode attribution headers; returning `null` for one still removes it. …"
- "`generateSummary()` and `generateSummaryWithUsage()` now ignore their `reserveTokens` parameter. Summary requests use the model's output limit instead."
- "Changed the default GitHub Copilot model from `gpt-5.4`, which Copilot retired, to `gpt-6.1-sol`."
- "Changed the default NVIDIA model to `nvidia/nemotron-3.5-super-vl-120b-a12b`"
- "Changed the default Xiaomi model to `mimo-v2.6-pro` for the `xiaomi` and Xiaomi Token Plan providers, since `mimo-v2.5-pro` left the catalog."
- "Grok 4.3 and Grok 4.5 on the `xai` provider now offer the `xhigh` thinking level."
- "Sign in with ChatGPT: ChatGPT Business workspace usage-limit errors are not retried …"

### New features
- coding-agent: "**Image input for classifiers**…", "**Models Configuration reference**: every provider, model, model override, and compatibility field of `models.json`, generated from its schema.", "**Summaries without a fixed output cap**: compaction and branch summaries use the model's output limit, so long reasoning no longer makes them fail.", "**Codemode waits for a free worker**…", "**Rex terminal support**…"; Added: `MiniMax-M3.1-Flash`, provider-level `compat` for classifiers, schema-generated reference (#10790).
- pi-ai Added: "client identity configuration: an `identity` request option and `createModels({ identity })` …", "`AI_TELEMETRY_SCHEMA` and opt-in `pi.ai.request`/`pi.ai.poll` tracing …", `x-opencode-session` for custom OpenCode providers, classifier image input, `SystemOneCompat`, `MiniMax-M3.1-Flash` ("New MiniMax models from models.dev now appear without a manual allowlist entry"), Clef Omni / Jev 1.14.
- pi-agent-core: "Added `AgentOptions.identity` and `Agent.identity` (a pi-ai `ClientIdentity`) …" (its only entry).

### Fixes (coding-agent; the ones that touch the extension's TS runtime are marked ★)
- ★ "Fixed compaction and branch summaries failing with "generation hit the token cap" … `compaction.reserveTokens` only controls when compaction starts (#9512, #9075)."
- ★ "Fixed `/compact <instructions>` ignoring the instructions when summarizing the start of a turn that compaction splits… (#11058)"
- ★ "Fixed resumed sessions and `/tree` navigation leaving extension tools inactive when the branch recorded its tools before they were registered… Extension tools the branch never added or removed are now active unless they are registered with `defaultActive: false` (#11062, #11075)"
- ★ "Fixed sessions breaking after recovery from a response cut off at the output limit: the truncated tool call was omitted but its tool results were kept, so providers rejected every later request (#11227, #11233)"
- ★ "Fixed automatic retry not triggering for more gateway upstream failures, `stream disconnected before completion` … and retrying errors because of digits inside request ids or byte counts (#10920, #11057, #10996)"
- ★ "Fixed whitespace-only tool output (for example a bare `\r\n` from bash) making OpenAI Completions, OpenAI Responses, and Google requests fail with a 400 (#8720)"
- ★ "Fixed GitHub Copilot sessions with large request bodies … failing with HTTP 413 … instead of compacting and retrying (#11016)"
- ★ "Fixed OpenAI Responses models losing the prompt cache on every deferred tool load after a tool was removed (#10940)"
- ★ "Fixed the `grep` tool following `RIPGREP_CONFIG_PATH` … The tool now runs `rg --no-config` (#11203, #11230)"
- "Fixed the `openai-codex` provider offering `gpt-5.5` and `gpt-5.3-codex-spark`, which always fail for ChatGPT accounts (#11173)"
- "Fixed `models.schema.json` missing descriptions …", "Fixed Cloudflare Workers AI classifier pricing …", `pi update` BOM, HTML-export CJK markdown, terminal teardown, concurrent extension dialogs (TUI), clipboard Ctrl+Z, codemode workers, `@earendil-works/pi-ai/models` in the extension loader (#11156), `mcp.json` BOM, Windows shell detection ×2, `$$` math, CJK bold, `@` autocomplete.
- pi-ai Fixed: whitespace tool output, retry classification ×4, Responses deferred-tool cache (#10940), "Any HTTP 413 now counts as context overflow", codex models removed, classifier pricing.

## 2. Risks to the batch: each dependency, PROVEN on the real 1.4.0
Method for "changed?": `diff -rq` of both installs' `dist/` (file list at `$P` notes) plus targeted diffs.

| Dependency | Changed in 1.4.0? | Status |
|---|---|---|
| SDK runtime exports (`dist/index.js`) | **No**: 157 names, identical (`$P/exp130.txt` vs `exp140.txt`) | PROVEN |
| `ModelRuntime.create` options (modelsPath, modelsStorePath, credentials, allowModelNetwork) | model-runtime **.d.ts unchanged**. The .js change is only OpenCode session headers at request time | PROVEN |
| models-store.json format + locked writer | `pi-ai/dist/models-store.js` **byte-identical** | PROVEN |
| credential reader / auth storage | not in the changed-file list | PROVEN |
| pi.dev catalog protocol / refresh | refresh code unchanged in `pi-ai/dist/models.js` (only identity + telemetry added). Live: same 2 URLs, same headers | PROVEN (3a) |
| `modelOverrides` PATCH semantics | schema unchanged for overrides (only `models[]` defaults + classifier compat added). Parity green | PROVEN (3b) |
| Events the extension translates | `AgentSessionEvent` union **identical**. Every literal emitted in dist JS has identical counts (summarization_retry_*, compaction_*, auto_retry_*, entry_appended, agent_settled) | PROVEN (3d) |
| `providers/all` getBuiltinProviders/getBuiltinModels/getBuiltinModelDataGeneratedAt | export map keys identical. The generator runs on 1.4.0 | PROVEN (§3) |
| `generateSummary*` | signature changed (`_reserveTokens` ignored). **Not called by us** | PROVEN (grep) |

(a) **Phase A, catalog source on real 1.4.0** (`$P/phaseA.txt`, `$P/phaseA-headers.txt`; control on 1.3.0 `$P/phaseA-130-control.txt`):
compiled `out/catalog-source.js`, expired fake Anthropic OAuth (`expires: 1`) + mistral api_key in auth.json, fetch stubbed
(anything not `https://pi.dev/` throws):
```
1.4.0-online: kind=pi label="Pi's catalog (pi-coding-agent 1.4.0)" providers=34 models=1239 fetchesAfterCreate=0
  after refresh: fetches=2 allToPiDev=true ua=pi/1.4.0 (linux; node/v24.18.0; arm64)
  second refresh (throttled): newFetches=0
  auth.json unchanged: bytes=true mtime=true
  headers: [{"u":"https://pi.dev/api/models/providers/mistral","hk":"accept+user-agent","auth":"none"},
            {"u":"https://pi.dev/api/models/providers/deepseek","hk":"accept+user-agent","auth":"none"}]
1.4.0-offline (PI_OFFLINE=1): … fetches=0 … auth.json unchanged: bytes=true mtime=true
```
The 1.3.0 control is identical except for the UA version (`pi/1.3.0 …`). There was no OAuth token-endpoint call and no credential sent to pi.dev.
(deepseek is refreshed because this container has `DEEPSEEK_API_KEY` set. The key is not sent.) "Matches Pi's catalog": the
source's slim snapshot equals the generator run on pi-ai 1.4.0 **exactly** (`snapshot==generator(slim): True`, 1239 models).
The 26 providers that differ from the floor are the expected 1.3.0→1.4.0 catalog drift (§3).

(b) **"Other Pi tools unaffected", landed `mergeModelsJson`, Pi 1.4.0 DEFAULT ModelRuntime** (`$P/parity.mjs`, `$P/phaseB.txt`).
The script compares every model field, provider, auth status, compat request config and getError, between the user's file and the merged file:
```
empty   merge written 731 / notCreated 405  keys 3391  models 1599→1599  diffPaths 0  PARITY GREEN
v027    written 731  diffPaths 0  GREEN      v028pre written 731  diffPaths 0  GREEN
mixed   written 315 / notCreated 818  keys 3397  models 1601→1601  diffPaths 0  PARITY GREEN
```
**The upgrade window is a recorded residual, now measured for this version.** Overrides written while 1.3.0 was installed, read by 1.4.0
(`$P/phaseB-upgrade.txt`) give `PARITY RED: 192 differing paths` (empty fixture) and 48 (mixed). The differences are costs (input 45, output 43, cacheRead 52),
maxTokens 27, contextWindow 13 and thinking maps, all of them 1.3.0 values pinned over 1.4.0's in the Pi CLI's view. This is design v4 residual 4 /
C28(2) ("After you upgrade Pi, the CLI sees the previous version's values until your next Rust session start"), and it
clears at the next Rust start (the 1.4.0-sourced run above is GREEN). The model count is unchanged (1599→1599): overrides for ids that 1.4.0
dropped create nothing, and 1.4.0's new doc says so: "Unknown IDs are ignored." Not a new risk. The founder
should know that it is real for anyone who used Rust on 1.3.0 and then upgraded.

(c) **Unit suite** (`$P/test.log`): run in a scratch copy with scratch HOME, `pnpm run test:unit` gives **819 / 819 pass**. The
suite is hermetic: no test imports the installed SDK. Every SDK is a fake (`importModule`/`ModelRuntime` stubs; path tests use literal
strings). So **the suite cannot detect an SDK change. It passing on 1.4.0 says nothing about 1.4.0**; (a), (b) and (d) are the
evidence. (The suite also writes `mkdtemp` dirs under `/tmp`, so it is not "only out/".)

(d) **Events**: the `AgentSessionEvent` type literals in `core/agent-session.d.ts` are identical (`$P/ase130.txt` = `ase140.txt`).
All `type: "…"` literals across coding-agent + agent-core + pi-ai d.ts: only `"image_url"` (classifier wire) and
`"number"` (a schema) were added. No event was added, renamed or removed. The extension handles every session event Pi emits.
`compaction_cost` / `compaction_delta` appear in dist JS in both versions, but only inside `interactive-mode.js` (TUI-internal
items built from `entry.usage`), not as SDK events. INFERRED: no translation gap was opened by 1.4.0.

**Other risks (INFERRED, low):**
- R-a. **Resume tool activation changed (#11062).** Bridge tools are `customTools` (sdk source), not base tools (agent-session.js:1405
  `newTools = … !this._baseToolDefinitions.has(name) && this._isActivatedOnRegistration(name)`). So on 1.4.0 a resumed session whose
  recorded loadout predates a bridge tool now ACTIVATES it. The direction is good, but this is exactly the path pi-sdk-version.json says was "not
  live-run". Not exercised here: it would need a recorded system message, which needs a turn.
- R-b. **Compaction output.** Summaries now ask for the model's full output limit. They succeed where they used to fail, but a compaction can produce
  longer and costlier summaries on TS sessions. The event shape is unchanged.
- R-c. **Upstream #11534** (closed 2026-10-28, fix after 1.4.0, unreleased): "Recovery `context_edit` entries that omit a failed/aborted
  response … invalidate that report … can inflate context usage and trigger unnecessary compaction." On 1.4.0 a TS session's
  context % may jump after an errored turn. Whether 1.3.0 had the same behaviour was not checked.
- R-d. Pre-existing, not caused by 1.4.0: `prepare(2500)` took 4.3–6.9 s on BOTH versions under this machine's load. The import is
  CPU-bound and blocks the timer, so the budget is not enforced. Raw import timings for 1.3.0 and 1.4.0 interleave (5.8–72 s vs 6.3–12.6 s, noisy;
  `$P/imptime.mjs`), so there is no import-time regression attributable to 1.4.0.

## 3. Catalog: pi-ai 1.4.0 vs bundled 1.3.0 (`$P/catdiff.txt`, full 42-provider dump; `$P/gen140/`)
- **The generator works unchanged on 1.4.0.** Output: "34 providers, 1239 models (pi-ai 1.4.0, model data 2026-10-21)", with the same 7 skipped
  special-auth providers. Control: the generator on 1.3.0 reproduces the bundled file **byte-for-byte** (`gen130 == bundled: True`).
- Providers: 42 → 42, none added or removed. **No new `api` value. No connection (api, baseUrl) change on any model** (0 CONNECTION
  CHANGE). Slim provider-level baseUrl/api unchanged for all 34.
- Bundled slim: 1242 → 1239 models; 26 of 34 providers differ. Field changes across the full catalog: cost 68, compat 52 (51 are
  amazon-bedrock `supportsStrictMode`, skipped by us), maxTokens 31, thinkingLevelMap 24, contextWindow 14, promptCache 8,
  reasoning 2.
- Notable removals: xiaomi ×3 / token-plan ×6 `mimo-v2.5*`; mistral `open-mistral-7b`, `open-mixtral-8x7b/8x22b`; openai
  `gpt-5.2/5.3-chat-latest`; openai-codex `gpt-5.5`, `gpt-5.3-codex-spark`; github-copilot ×10 incl. `gpt-5.4`; baseten ×10;
  together ×5; openrouter ×4. Additions: `MiniMax-M3.1-Flash` (minimax, minimax-cn), `deepseek-v4.1-flash-1017` on 8 providers,
  google `gemini-pro-latest`, openrouter ×9, opencode ×5, radius ×3, others.
- Notable prices: mistral `ministral-3b-latest` 0.04→0.1 in/out; openrouter `mistralai/mistral-large-4-0` doubled; `z-ai/glm-5.2`
  in 0.65→0.0341; nvidia `nemotron-3-ultra-550b-a55b` 0.5/2.5 → 0/0; minimax-cn and moonshotai-cn ~+2–4% (looks like an FX re-basing).
- Hard-coded ids: the only literal in src is model-picker.ts:34 `["gpt-5.5","gpt-5.2","gpt-5"]` for `openai`, and openai still has
  `gpt-5.5` in 1.4.0 (only openai-codex dropped it). The chain is self-healing anyway.

## 4. Opportunities
1. **The override contract is now documented upstream** (new in 1.4.0, `docs/models-configuration.md:61`): "Each `modelOverrides` key
   is the ID of a built-in or extension model. Unknown IDs are ignored. Object fields, such as `cost`, merge with the model's value
   field by field; other fields replace it." That is the core of "your other Pi tools are unaffected", now a published
   contract rather than only our measurement. Cite it in `agent-wiki/architecture/model-catalog.md` (optional, cheap).
2. **A schema we can test against**: `schemas/models.schema.json` ships in the package (1.4.0 adds descriptions and the `models[]`
   defaults; the override part is unchanged). A unit test could validate `mergeModelsJson` output against Pi's own schema (via the
   devDep install, or a vendored copy) to catch a key Pi would reject. Optional; this would be a new test.
3. **Users get fixes for free on TS sessions**: compaction no longer fails at the token cap (#9512) and honours `/compact
   <instructions>` (#11058); sessions no longer brick after a truncated tool call (#11227); more transient errors auto-retry
   (#10920/#11057/#10996). Our `auto_retry_*` handling will show those as retries. Bridge tools come back active on resumed sessions
   (#11062); grep ignores the user's ripgrep config (#11203). Worth a CHANGELOG line ("works with Pi 1.4.0") once verified.
4. Nothing in 1.4.0 adds a supported catalog API, emits compaction/abort cost for Rust, or changes the summarization-retry events.
   **No recorded follow-up is closed by 1.4.0** and no special case can be removed. The `$??` cost follow-ups are rust-pi
   behaviour, and rust-pi is unchanged at 0.8.0. Client identity (`getClientIdentity(settingsManager)` in sdk.js) is fixed by Pi's settings and
   cannot be set through `createAgentSession`, so it offers no attribution hook for the extension.

## 5. Recommendation
**MUST before 0.2.8 ships** (PROVEN blocker):
- The publish jobs run `vsce publish` / `vsce package` with `PI_REGISTRY_CURRENCY_STRICT: "1"` (publish.yml:84-85, 127-128), and
  `vscode:prepublish` → `package` → `scripts/check-model-registry.mjs`. Today that gives: "model catalog is STALE: pi-ai 1.3.0 is
  installed, 1.4.0 is published." **rc=1**. Fix: `pnpm add -D @earendil-works/pi-ai@1.4.0 && pnpm run gen:model-registry`, then commit
  package.json, the lockfile and `src/model-registry.generated.json`. **Rehearsed in scratch** (pi-ai 1.4.0 overlaid on the copy): the regenerated
  file equals `$P/gen140` byte-for-byte; `check-model-registry` STRICT gives "in sync with pi-ai 1.4.0 (current)" rc=0; `check-types`
  rc=0; `test:unit` **819/819** (`$P/test-regen2.log`). Swapping only the JSON without the devDep fails 1 test (catalog-source.test.ts:187,
  the generator-parity assertion), so bump both together. The rust-pi catalog (`gen-rust-pi-catalog`) is unaffected. Wiki/CHANGELOG:
  the floor label becomes "bundled catalog (pi-ai 1.4.0)".
- Alternative if the founder wants to hold the catalog: `PI_SKIP_REGISTRY_CURRENCY=1` for the release. Not recommended: the floor
  would ship 68 stale prices.

**OPTIONAL / follow-up:**
- Bump `src/pi-sdk-version.json` `testedAgainst` → 1.4.0 **only after** the same headless live-verify that 1.3.0 had. check-currency
  is advisory here (it only nudges), so this does not block. Add a resumed-session-with-bridge-tools check (R-a) to that run.
- Cite the newly documented override contract and the measured upgrade-window figure (192 paths) in model-catalog.md.
- Consider a schema-validation test (Opportunity 2).

## Proven vs inferred, at a glance
PROVEN: changelog contents; no BREAKING item touches our code; SDK exports, event union and models-store unchanged; the generator works and its output
equals the live source; phase A green (auth.json bytes and mtime unchanged, pi.dev-only, no auth header); phase B parity 0 diffs on 4 fixtures;
upgrade-window 192/48 diffs (known residual); the unit suite is hermetic and 819/819 both before and after the regen; the strict publish gate fails now and passes after the regen.
INFERRED: R-a (resume activation), R-b (compaction output cost), R-c (#11534 on 1.4.0), R-d (prepare budget, pre-existing),
and that no event-translation gap exists beyond what was diffed.
Housekeeping: no processes left running. My scratch `mkdtemp` homes in `/tmp` (`imp-*`, `snapsrc-*`, `u7a-home-*`) were not
removed: the sweep was denied by the permission classifier. They hold only fake credentials.
