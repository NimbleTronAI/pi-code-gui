# Pi 1.4.0 → 1.5.2: findings and live verification

> **Status:** evolving

## Verdict

**1.5.2 breaks nothing the extension depends on.** The SDK entry point, the session-event union and the
`createAgentSession` options are unchanged from 1.4.0 (PROVEN). The real extension ran on 1.5.2 end to end, including
bridge tools called in a resumed session (PROVEN, §3). There is one behaviour change users can see: `/reload` during a
response or compaction now fails with an error (#9222, PROVEN live). The bundled catalog moves to pi-ai 1.5.2, and
`testedAgainst` moves to 1.5.2. The live run also exposed a **pre-existing** bug that is not caused by 1.5.2: a session
closed right after `/tools` reopens with an empty model history (§3, hand-off 3).

Researched 2026-11-11 for batch "0.2.8". Sources: the installed `pi-coding-agent/CHANGELOG.md` §[1.5.0]–[1.5.2], which
is identical to upstream tag v1.5.2 (`diff` prints nothing), and the raw upstream `packages/{ai,agent}/CHANGELOG.md` at
v1.5.2. The 1.4.0 comparison install is an `npm pack` of 1.4.0 (scratch); 1.5.2 is the container's global install.
**PROVEN** means we ran or read it; **ASSUMED** means inferred and not run. Method as in the
1.4.0 findings (that page was removed with the batch archive; it last existed at commit `69c2e74`).

## 1. Breaking items, checked against our code

- 1.5.0: "Tool argument validation runs on `@earendil-works/pi-schema`. TypeBox features outside JSON Schema
  (`Type.Refine()`, `Type.BigInt()`, `Type.Undefined()`, codecs, `Format.Set()` formats) no longer apply to tool
  arguments". **Does not hit us (PROVEN).** No such call exists in `src/` or `media/` (grep exit 1). The bridge tools
  use only `Object`, `Number`, `String`, `Optional`, `Boolean` and `Array`. The model's calls to `read` and two
  `vscode_*` tools ran (§3), but those `vscode_*` calls took no arguments. Parameter validation was therefore checked
  offline against pi-ai's `validateToolArguments` with TypeBox-built schemas (coercion, optional, missing-required,
  extra fields): 1.5.2 gives the same results as 1.4.0.
- 1.5.0 pi-ai: "The main entry no longer re-exports TypeBox … and `typebox` is no longer a dependency." **Does not hit us
  (PROVEN).** We load TypeBox from `<pi>/node_modules/typebox/build/index.mjs` (sdk-service.ts), and that file still
  exists in 1.5.2 (typebox 1.3.27, a direct dependency of pi-coding-agent). Watch item: if pi-coding-agent ever drops
  typebox, the bridge tools need another schema builder.
- 1.5.0 agent-core: "`AgentTool` takes any JSON Schema object as `parameters`". This changes types only, and we pass
  `any`. **No effect (PROVEN).**
- 1.5.1: "Custom `GrepOperations.readFile` callbacks are no longer called for context lines." We have no
  `GrepOperations` (grep exit 1). **No effect (PROVEN).**
- 1.5.1: OpenAI-compatible models no longer send `"tools": []` when every tool is disabled. We write no `compat`.
  **No effect on our code (PROVEN).** A user whose proxy needs `compat.requiresToolsWithToolHistory` would set it in
  their own models.json (ASSUMED rare).

## 2. Behaviour changes that touch us

- **#9222 (1.5.1)**: "Fixed SDK and RPC reloads replacing extensions while a response or compaction was still running;
  reload now asks the caller to wait". In the dist, `reload()` **throws** "Wait for the current response to finish
  before reloading." or "Wait for compaction to finish before reloading." (agent-session.js, `async reload`). It does
  not queue the reload. 1.4.0 had no such guard. **PROVEN live (§3):** `SdkService.reloadContext()` threw while the
  model was streaming, and the same call succeeded when the session was idle. Our chat `/reload` and the
  "Reload Context" command call it without checking first, so the user gets an error card or toast that reads like a
  failure. Nothing is lost and nothing reloads. A friendlier pre-check is a follow-up (see the hand-off below).
- **`cacheWarming` defaults to `"idle"` (1.5.1)**: "pi also keeps eligible prompt caches warm for up to 30 minutes
  between agent runs". PROVEN: the default changed (`settings-defaults.js`: "streaming" in 1.4.0, "idle" in 1.5.2), and
  `createAgentSession` wires the warmer. Warm-up spend is saved as `usage` entries (`kind: "cache_warm"`), but
  `SdkService.getUsage()` sums only assistant `message` entries. **So the panel's $ leaves out warm-up and compaction
  spend.** That gap existed before 1.5.1; the new default makes it larger. How large it gets in practice is ASSUMED: it
  was not measured, and warming applies only to eligible (cache-capable) providers.
- **#11460 (1.5.0)**: "Fixed failed session writes leaving entries in memory that were absent from disk". The SessionManager
  internals we touch (`flushed`, `_rewriteFile`) still exist in 1.5.2, and the session format version is still 3
  (PROVEN by reading the dist). Persist and reopen worked (§3).
- #11975 (1.5.2): when a session's folder no longer exists, "interactive mode now offers `Continue`, `Fork`, or
  `Cancel`". That prompt lives in interactive mode and `AgentSessionRuntime`, which we don't use. `SessionManager.open`
  is unchanged, so Past Sessions opens such a session as before (PROVEN by reading the dist).
- Anthropic message threads (1.5.1, on by default for `api.anthropic.com`). Their per-session state is freed in
  `AgentSession.dispose()`, which we call. We assume no effect; not live-run.

## 3. Live verification on 1.5.2 (PROVEN)

The harness drove the real `PiService` (and with it the real `SdkService`, the production `createBridgeTools`,
`handleAgentEvent`, the active-tools restore and replay) under the unit-test vscode stub, against the global pi-coding-agent 1.5.2. It ran with a scratch
`PI_CODING_AGENT_DIR`, used DeepSeek `deepseek-flash` through env-var auth with thinking off, and had one
workspace folder. Scratch settings set `compaction.keepRecentTokens: 1` because a two-turn session is otherwise "too
small" to compact, which is Pi's guard and not a defect. The table is the final run, which repeated every earlier
step and added the last row.

| Step | Result |
|---|---|
| init (fresh) | success; 20 tools active, 16 of them `vscode_*` |
| turn 1: "read hello.txt" | `read` tool call; reply `PELICAN` |
| turn 2 + manual compaction | `compaction_end` reason manual, tokensBefore 3487, summary 1159 chars |
| persist | .jsonl holds session, model_change, thinking_level_change, system, 2 user, 3 assistant, toolResult, compaction |
| reopen (`openPath`) | same file; replay emitted chat, assistant, tool and `compaction-summary-message` events |
| resumed session | all 16 `vscode_*` tools active and present in `agent.state.tools` |
| resumed turn | the model called `vscode_get_workspace_folders` and `vscode_get_open_editors`, both `isError=false`; reply `ws`; both results persisted |
| `/reload` path | threw while streaming (#9222); `ok=true` when idle |
| `/tools` narrowed, close, reopen | restore works: only `read` and `vscode_get_workspace_folders` active. **But the model's history is empty** (0 context messages), and asked for the secret word it replies `UNKNOWN` |

SDK events seen: `agent_start`, `turn_start`, `message_start`, `message_update`, `message_end`,
`tool_execution_start`, `tool_execution_end`, `turn_end`, `agent_end`, `agent_settled`, `compaction_start`,
`compaction_end`. **The extension did not report a single event as unhandled** (no "Unhandled agent event" diagnostic).
The type literals in the event typings (agent-session + agent-core d.ts) are identical between 1.4.0 and 1.5.2, 23 of
them (PROVEN by `diff`). The only one we don't translate is `bash_execution_update`, which comes only from
`session.executeBash()`, and we never call that.

**The `/tools` bug (pre-existing, PROVEN live).** `PiService.setActiveTools` appends `tools_active_change` with
`parentId: null`. On reopen, `SessionManager.open` takes the last line as the leaf, so the branch is that parentless
entry alone: the UI replays the full history (it reads every entry), but the model sees none of it. A probe with the same
file, where only that entry's `parentId` was set to the previous leaf, reopened with all 8 context messages. The
bug is not new: our entry shape is unchanged since before 1.4.0, and `SessionManager._buildIndex` is byte-identical in
1.4.0 and 1.5.2. The vscode stub stands in for VS Code itself. The run proves the SDK path (registration, validation, dispatch, persistence), not
VS Code's own API behaviour.

Not run on 1.5.2: thinking deltas and HTML export, which were live-run on 1.3.0. Boundary-draft entries from an
extension have never been live-run.

## 4. Catalog: pi-ai 1.5.2 vs the bundled 1.3.0

`pnpm add -D @earendil-works/pi-ai@1.5.2 && pnpm run gen:model-registry`. The generator needed no change, and it gives
byte-identical output when re-run.
- Providers: 34 → 35 (`qwen-token-plan-individual-cn` added). Models: 1242 → 1270 (+142, −114). Changes on models in
  both versions: cost 102, maxTokens 51, contextWindow 30, thinkingLevelMap 23, compat 6, name 3, input 1,
  reasoning 1.
- Connection changes: `opencode` and `opencode-go` move to `…/inference/anthropic` and `…/inference/go/anthropic` (api
  unchanged). No code depends on their old baseUrl except the legacy-entry cleanup list, which correctly lists only the
  pairs that earlier versions wrote.
- models.dev v2 drops: `openai/gpt-realtime-2.1`, `google/gemini-3.1-flash-live-preview` and
  `google/gemini-3.1-flash-lite-image` leave the catalog. No code special-cases them. Every id in the model-picker
  fallback chains still exists (PROVEN).
- Version nudge: `TARGET_PI_AI_VERSION` follows the stamp to 1.5.2. `piAiVersionNotice` returns null for 1.5.2 and
  1.6.0, an info nudge for 1.5.1 through 0.80.8, and the floor warning for 0.80.7 (PROVEN).
- pnpm's lockfile metadata now marks the transitive `@smithy/core@3.36.0` as deprecated by AWS. This is not caused
  by pi-ai and does not affect the strict gate.

## 5. Opportunities (not done)

- ~~`Usage.cost.totalFromProvider` (1.5.0) could mark the cost readout as billed rather than estimated.~~ Done in
  0.2.8: `costSource` billed/estimated/mixed. Only OpenRouter sets it in pi-ai 1.5.2 (`utils/openrouter-cost.js`).
- ~~Count `usage` entries in `getUsage()` to close the cache-warm/compaction gap.~~ Done in 0.2.8: `getUsage()` counts
  the same entries as `getSessionStats()`.
- `ModelRuntime.settleCredentialWrites()` is called only by `AgentSessionRuntime.dispose`. We use `createAgentSession`,
  so we would call it on dispose ourselves to keep the #11692 OAuth-refresh protection.
- Users get these fixes on upgrade: resized images in steer/follow-up (#11738), resume keeps the right thinking level
  (#11451), retry on dropped streams (#11879), the read and grep tools no longer load whole files (#9654, #9276).

## Hand-off (for the session-service owner)

1. ~~`/reload`: check `isStreaming`/`isCompacting` first and show a notice instead of an error.~~ Done in 0.2.8.
2. ~~`SdkService.getUsage()`: include `usage` entries (cache_warm, compaction) in the cost readout.~~ Done in 0.2.8.
3. **`PiService.setActiveTools`**: write the entry as `parentId: this.sessionManager?.getLeafId?.() ?? null` (the
   probe shape above), with a red test that reopens a file ending in `tools_active_change` and asserts the context
   still holds its messages. The founder decides whether 0.2.8 carries the fix.

> **Last updated:** 2026-11-12 — hand-off items 1 and 2 and the `totalFromProvider` opportunity done in 0.2.8.
> **Earlier:** 2026-11-11 — created for the pi-ai 1.5.2 catalog bump and the 1.5.2 live verification (batch 0.2.8, unit U4).
