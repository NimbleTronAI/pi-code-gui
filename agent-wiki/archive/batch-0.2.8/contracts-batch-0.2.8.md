# Contracts note — batch 0.2.8 (upstream catch-up)

Cite by number. Do not re-derive a seam; if one is missing or wrong, say so in your NOTE and the
coordinator amends this file.

C1. INTEGRATION. Everything lands on branch `release/0.2.8` (renamed 2026-10-17 from
    `deps/pi-ai-0.86.1`; local only, not pushed), rebased on origin/main (0.2.7).
    The batch ships as **0.2.8**. NOTHING merges to main without the founder's explicit sign-off.

C2. MEMBERS NEVER commit, push, stage, reset, checkout, restore, rebase or stash (protocol rule 7).
    Edit files in YOUR worktree only. Hand back a PATCH (`git diff` from your worktree, written to
    the path in your brief) plus a NOTE.
    AMENDED after Unit 1: protocol rule 11 ("members rebase onto the moving batch tree") conflicts
    with this. Resolution: members do NOT rebase. Deliver the diff against the base commit named in
    your brief; the COORDINATOR applies it onto the moving tip and resolves any drift.

C3. CLEAN ROOM (AGENTS.md §"pi clean-room", license law). Never read, grep, cat, fetch or paste the
    SOURCE of pi_agent_rust or asupersync / franken-*: not ~/.cargo/git, not a clone, not GitHub
    blob/raw/commit/diff pages, not a fork diff. ALLOWED: `cargo install` to build it, the binary's
    `--version` / `--help`, black-box RPC wire probes (`pi --mode rpc`, capture stdout), GitHub
    ISSUE and RELEASE-NOTE prose. If you are unsure whether something is source, do not open it.

C4. CHANGELOG has ONE owner: the coordinator. Do not edit CHANGELOG.md. Propose at most two
    user-visible lines in your NOTE, per agent-wiki/discipline/documentation-discipline.md
    (user-visible only, one or two sentences each, no internals).

C5. No vendor model product names in any repo text (comments, docs, wiki). Describe models by role.

C6. PINS — one owner each:
    - catalog stamp `src/model-registry.generated.json` + `package.json` pi-ai line + `pnpm-lock.yaml`
      → Unit 1 only
    - `src/pi-sdk-version.json` (`testedAgainst`) → Unit 2 only
    - `src/rust-pi-version.json` (`tag`) → Unit 3 only
    Units 2 and 3 must not touch package.json or pnpm-lock.yaml.

C7. GATES after every patch: `pnpm run check-types`, `pnpm run lint`, the targeted tests. Before
    hand-back: the full `npm test` (baseline: 642 passing) and `npm run wiki:lint`. Never write the
    next patch on red. Paste the rc / summary lines as evidence.

C8. FOREGROUND ONLY. No background processes, no `&`, no nohup, no waiter loops. At hand-back run
    `pgrep -fa 'cargo|rust-pi|pi --mode'` and paste the output to prove no strays (empty is the
    pass; your own pgrep line does not count).

C9. CONTAINER FACTS. Debian 13, glibc 2.41, apt pinned to a snapshot — glibc cannot be upgraded.
    Upstream's released Linux rust-pi binaries can need a newer glibc and then cannot exec here.
    The testing path is a LOCAL BUILD: `.devcontainer/build-rust-pi.sh` builds the pinned tag and
    caches it at `/home/node/.pi/rust-pi-build/pi-<version>` (an external docker volume — survives
    rebuilds). The binary on PATH is `/home/node/.local/bin/rust-pi`.

C10. WIKI. A unit that changes a concept the wiki documents updates that page (its `Last updated`
     footer) and appends `## [2026-10-16] update | <summary>` to agent-wiki/log.md. Proposed log
     lines go in the NOTE if two units would collide; the coordinator merges log.md.

C11. SHARED SOURCE FILES (`src/pi-service.ts`, `src/rust-service.ts`, `src/extension.ts`) — if your
     unit must change one, keep the hunk minimal and list it explicitly in the NOTE so the
     coordinator can integrate it against the other units.

C12. REAL IN THE RUNNING SYSTEM (rule 9). For every value you change, name the production call site
     that consumes it. Tests alone are not done.

C13. VERSIONS AT BATCH START (2026-10-16): pi-ai 1.3.0 (ours 0.86.1), pi-coding-agent 1.3.0
     installed globally in this container (tested-against 0.86.1), rust-pi latest v0.8.0 (pin
     v0.5.1; 0.6.0, 0.6.1, 0.7.1 between). Surface-checked only: pi-ai 1.3.0 still exports
     `providers/all` with getBuiltinProviders/getBuiltinModels/getBuiltinModelDataGeneratedAt, and
     pi-coding-agent 1.3.0 still contains `ModelRuntime`. Neither is proof of behavior.

C14. UNIT 1 LANDED (commit beee5f9, the base for Units 2 and 3). pi-ai 1.3.0; 34 providers; 1128 ->
     1242 models; regeneration alone sufficed, generator unchanged. api values present:
     openai-completions, anthropic-messages, google-generative-ai, openai-responses,
     mistral-conversations, pi-messages. NO new api value vs 0.86.1; `pi-messages` (radius) is the only
     one RUST_SUPPORTED_APIS withholds.

C15. PROVIDER CONNECTION CHANGES in 1.3.0 (owner: Unit 3 — it owns src/rust-models.ts this batch):
       kimi-coding  was anthropic-messages + https://api.kimi.com/coding
                    now openai-completions + https://api.kimi.com/coding/v1
       opencode     was https://opencode.ai/zen      now https://opencode.ai/inference
       opencode-go  was https://opencode.ai/zen/go   now https://opencode.ai/inference/go
     mergeModelsJson (rust-models.ts ~318) fills provider baseUrl/api only when ABSENT, with no marker
     telling ours from the user's at provider level — so existing users keep the old values while
     their refreshed MODEL entries carry new compat (a mixed entry). This bump triggers it, so it MUST
     be fixed before 0.2.8 ships. Reviewed fix shape (red test first, rust-agent-home.test.ts):
       (1) stamp MANAGED_KEY on any provider object mergeModelsJson creates;
       (2) when the stamp is present, overwrite baseUrl and api from the catalog;
       (3) migrate an UNSTAMPED legacy entry only when (api, baseUrl) exactly equals a known earlier
           bundled value listed above — rewrite and stamp it; anything else stays the user's.

C16. SDK NUDGE (owner: Unit 2). src/sdk-service.ts:45 derives TARGET_PI_AI_VERSION from the catalog
     stamp, now 1.3.0; :805 builds piAiVersionNotice(installed, SUPPORTED, TARGET). Every TS-runtime
     user on pi-ai 0.x now gets the "update" notice. Verify it reads correctly and is warranted.

C17. OUT OF SCOPE for this batch (recorded, not to be fixed here — founder's call later):
     F2 multi-api providers flattened to models[0].api by the generator (openrouter: 381
     openai-completions models written as anthropic-messages; also fireworks, opencode, opencode-go);
     N1 per-model `headers` dropped by the generator; N2 the currency gate fails OPEN when npm is
     unreachable; N3 (Unit 2b reviewer) custom-message events whose `details` is not an object fail
     schema validation and add a hidden diagnostic card; N4 (Unit 2 member) summarization_retry_*
     events still render the junk "Unhandled agent event" card on a provider error mid-compaction —
     founder's y/n pending; N5 (Unit 4c review) an optional same-filesystem `dev` check on the
     managed folder would also catch FUSE/volume mounts; N6 (Unit 4c review) if the managed file vanishes
     mid-Detect the user gets a misleading info line (fix shape in unit4c-review.md); R1 (Unit 5) the
     --append-system-prompt runtime-identity block is fixed at spawn and names the CONFIGURED model as
     "authoritative", so after a substitution or any /model switch the agent is told the wrong model;
     R2 (Unit 5) the resumed path's same-provider preference uses the configured default's provider,
     not the session's own (get_state reports model:null); N1/N3 from unit5-review.md. Do not drift into these.
     (R1 and Unit 5 review's R3 were PROMOTED into Unit 5b — see C25.)

C18. REVIEWER IN THE FOREGROUND (amended after Unit 2). Spawn your rule-10 reviewer with
     run_in_background=false and WAIT for its verdict before you hand back. Unit 2 spawned its diff
     reviewer in the background, handed back before it replied, and the review arrived after the
     fact. A hand-back with the review outstanding does not satisfy rule 10 and will not be landed.

C19. REVIEW OF RECORD for Unit 2 is scratchpad/unit2-review.md
     (the coordinator's independent delta review). Its S1/S2/S3 remedy shapes are binding; N1 is
     closed by a live run, not a comment.

C20. UNIT 4 (added 2026-10-16, base commit c624619 = batch tip after Units 1–3 and the changelog).
     Founder-reported, evidenced: the founder's MAC profile settings
     (~/Library/Application Support/Code/User/profiles/-524dc53a/settings.json) hold
       "pi-code-gui.rustBinaryPath": "/Users/<founder>/Library/Application Support/Code/User/
        globalStorage/nimbletron.pi-code-gui/rust-pi/pi"
     written by an earlier MANAGED Rust install run while the extension ran locally on the Mac.
     VS Code applies it inside the Linux dev container too (despite the setting's "machine" scope —
     observed, not explained), so every Rust session warns "could not be used (the file does not
     exist …)" and then correctly falls back to /home/node/.local/bin/rust-pi. Root cause: the
     managed install records its binary by WRITING AN ABSOLUTE PATH INTO A SETTING
     (src/rust-install.ts, `update("rustBinaryPath", dest, ConfigurationTarget.Global)`), because
     the resolver (src/rust-resolver.ts `candidatePaths()`) never looks in the extension's own
     install folder (context.globalStorageUri/rust-pi).

C21. SHARED FILES for Unit 4: src/extension.ts and src/pi-service.ts are C11 shared files; package.json
     may be edited ONLY in the `pi-code-gui.rustBinaryPath` setting's description (Unit 1's pi-ai line
     is done; do not touch dependencies or the lockfile).

C22. UNIT 5 (base d214cef = batch tip with Unit 4). Founder-reported, evidenced 2026-10-17 in a live
     Rust session on 0.8.0. Log: "Rust session has no resolved model (configured:
     deepseek/deepseek-v4-flash-vision-exp)" and NO "Substituted …" line. The UI text was the
     NEW-SESSION branch ("\"deepseek-v4-flash-vision-exp\" (provider \"deepseek\") could not be
     resolved"), so `restoring` was false. Source of that id: the founder's MAC profile settings
     `pi-code-gui.defaultModelId` (also `defaultModelProvider` = deepseek), applied inside the container.
     The id was dropped from the pi-ai catalog and then retired from models.json by this batch
     (Unit 3's retirement), so a default that previously resolved now does not. The resumed-session
     recovery added earlier (rust-service.ts, the `if (!this._model)` block) only runs when
     `restoring`. ALSO shown: "Rust Pi's get_state reply is missing expected fields
     (model/thinkingLevel) — the binary's RPC shape may have drifted …" — suspected FALSE ALARM: with
     no resolved model there is nothing to report in those fields. Prove or refute it black-box.

C23. FOUNDER'S DECISIONS (2026-10-17), binding on every unit:
     - The catalog work JOINS 0.2.8: "I am not in a hurry to release 0.2.8 because of all the catalog
       complexities. I'd rather do it right." Quality over speed.
     - The summarization-retry junk card (C17 N4) is fixed in 0.2.8.
     - No push. No merge prompts — the founder says when.
     - The release process is the founder's: never propose changes to release.yml / publish.yml.

C24. CATALOG SOURCE — PROVIDER EVIDENCE (spike: scratchpad/catalog-spike.md).
     NEVER fetch pi.dev `/api/models*` from the extension: maintainers call it "a protocol shared by pi
     and pi.dev", version-negotiated by `User-Agent: pi/x.y.z`, unendorsed for third parties, and it has
     broken a direct consumer (earendil-works/pi#9099, open). Consume it ONLY through Pi's own
     `ModelRuntime`. Never pass `allowNetwork:true`; inherit PI_OFFLINE, the 4 h throttle and ETags.
     Today src/sdk-service.ts:492 calls `ModelRuntime.create()` with no options and nothing refreshes it.

C25. UNIT 5b (fold, base = Unit 5's worktree). Review of record: unit5-review.md. Coordinator's rulings:
     S1 and N2(a) fold as written. R1 folds via the review's option (a): the Rust model line in
     buildRuntimeIdentityPrompt states the model REQUESTED AT LAUNCH and that the chat/status bar is
     current; "authoritative" stays only for runtime/backend facts — because Unit 5 made the misreport
     reachable from turn 1 and it already affects every resumed session. R3 folds: a spawn-time failure
     caused by the stale default (the binary exits — e.g. "Model … not found", "No API key found") is
     classified, retried ONCE without --provider/--model, and then reaches the same substitution + notice.
     Never retry in a loop; never retry for unrelated startup failures.

C26. NEW-1 (from Unit 5c) is ASSIGNED TO UNIT 7 PHASE B, which owns src/rust-models.ts:
     setupRustModels / credentialedProviders scope the models.json write from process.env only, so a
     provider whose key exists only in SecretStorage (injected into the binary's env from
     cfg.anthropicApiKey / cfg.openaiApiKey …) gets no managed entries. Use the same credential source as
     Unit 5c's credentialPredicate() — one predicate, not two.

C27. DESIGN S — THE FOUNDER'S DECISION (2026-10-17: "y ... let's try it and test thoroughly"). It
     SUPERSEDES the C31 options of unit7-design-v2.md. The rule, verbatim as approved:
     > On Rust, the extension only *adjusts* models rust-pi already supports, using exactly the values
     > Pi itself uses. It never adds providers, never moves endpoints, and never shrinks context windows.
     Mechanism: `modelOverrides` filled from the installed Pi's own catalog (the catalog-only runtime of
     the Unit 7 design), plus `models: []` to hide rust-pi's stale built-ins; NO full `models[]` entries,
     NO provider-level baseUrl/api, NO context-budget clamp in models.json. User entries always win and are
     never touched. Existing files are migrated once, automatically.
     The three accepted give-ups: (1) the 9 providers rust-pi does not support (74 models) are not offered
     on Rust; (2) pi-code-gui.contextBudget becomes TypeScript-only; (3) moved endpoints (kimi-coding,
     opencode, opencode-go) use rust-pi's built-in endpoint — PENDING VERIFICATION that each still
     answers; a dead one is escalated to the founder, never carried silently.
     The founder's ask: "test thoroughly" — a dedicated end-to-end verification phase is mandatory.

C28. DESIGN S, COORDINATOR'S RULINGS after the v3 review of record (unit7-design-v3-record-review.md).
     They FOLLOW FROM C27's approved rule, so they need no new founder decision:
     (1) NO `models: []` anywhere. It moves rust-pi's own endpoints (measured: zai, 14 opencode, 68
         vercel-ai-gateway models change protocol), which C27 forbids. Without it, 0 models move. Residual,
         accepted under "only adjust": models rust-pi itself still lists but Pi has withdrawn stay visible
         on Rust; Unit 5's recovery handles a stale selection. The two founder questions of v3 §7 (zai, B3)
         rested on measurements taken WITH `models: []` loaded and are WITHDRAWN; re-check whether either
         still exists without it, and report — do not ask.
     (2) WRITE ONLY AT RUST SESSION START. Our override values equal Pi's, so TS sees no difference whenever
         we write; rust-pi reads models.json only at spawn. No background or TS-triggered re-merge.
     (3) NEVER delete or rewrite anything we did not write: no user key, field, model, override or provider
         object — including keys a user adds INSIDE an object we stamped.
     (4) A models.json we cannot rewrite safely (comments, trailing commas, BOM, unparseable): never write
         it; tell the user once, in plain words, that rust-pi will ignore the whole file — custom providers
         included — and how to fix it.
     (5) SIMPLICITY IS THE SPEC: every special case beyond the one rule must be removed or justified as
         unavoidable in one sentence. Target: as close to zero as the evidence allows.
     (6) PHASE E must be shown to FAIL on each planted bug the record review proved it misses (dropped
         thinking map, placeholder maxTokens, lost user connection, endpoint movement vs rust-pi's OWN
         endpoints with NO models.json loaded), plus one planted bug per promise.

C29. CREATED MODELS ONLY WHERE RUST CALLS THEM AS PI DOES (coordinator's ruling, from "simple and RELIABLE").
     Design S v4 creates 836 models rust-pi lacks, on rust-pi's default connection; 62 of them (zai 5,
     opencode 42, opencode-go 11, kimi-coding 4) would run on an endpoint or protocol Pi does not use for
     them — unverified, likely to fail. Rule: an override that would CREATE a model is written only when
     rust-pi will call that model with the same endpoint and protocol Pi uses. Models rust-pi already has
     are adjusted as v4 says. Phase B chooses the mechanism with the fewest moving parts and states it in
     one sentence; prefer evidence from the binary at hand over a hand-kept table. Phase E must include a
     check, with a planted-bug red, that every created model's endpoint+protocol equals Pi's.

C30. THE BUILD SPEC is scratchpad/unit7-design-v4.md (Design S v4) as amended by C29. Phase
     order: A and C in parallel (disjoint files); B after A; D after B and C; E last. Each phase's file
     ownership and red-first tests are as v4 §5 names them. Accepted residuals (v4 §4), not to be "fixed":
     365 Pi-withdrawn models stay visible on Rust with rust-pi's values; the CLI shows previous values after
     a Pi upgrade until the next Rust start; 0.2.7 files migrate at the first Rust start.

C31. HAND-OFFS FROM PHASE C (landing note for B and D):
     - Phase B MUST delete the models.json context clamp in src/rust-models.ts (~:218) AND its docstring
       (~:102). A phase-C comment in rust-service.ts is only true once both are gone; the coordinator checks
       B's diff for both at landing.
     - Phase D receives phase C's reviewer note N4 (see unit7-C-note.md) — fold it or state why not.

C32. PHASE E MUST PROVE COMPACTION COST on Rust (phase C's record review could not: rust-pi would not
     compact against the mock). Find a way to make 0.8.0 compact under a mock (a tiny contextWindow in a
     scratch models.json, many turns) and assert the displayed cost across the compaction.
     PRIORITY LEAD (phase Cb): with a hand-written compaction entry, get_session_stats counted only the
     kept context and the cost DROPPED. If a real compaction does the same, the binary-reported cost
     UNDER-COUNTS what the user spent. Prove or refute on a real compaction; if real, it is a blocker.

C33. PHASE D DISCLOSURE (from phase A's record review N1): a catalog refresh reaches pi.dev, AND
     openrouter.ai with the user's own OpenRouter key, AND the radius gateway when a radius login exists.
     Phase D's wiki/docs must name all three; never describe it as "pi.dev only".

C34. FOUNDER'S DECISION (2026-10-18): when part of a Rust session's spend is unknowable, show `$??` — NOT a
     lower bound. As presented: "The current fix, extended to aborts." So a STOPPED (aborted) turn — billed by
     the provider but stored by rust-pi at $0 (phase Cc review N1, pre-existing) — also makes the session
     cost `$??`, like a compaction. Assigned to phase D (phase C is landed; D may touch rust-service.ts's
     cost path for this).
