# Local Agent Coordination Protocol

> **Status:** evolving

> Standing law for delegated work in this repo. Set by the founder on 2026-10-06.
> The protocol text below is reproduced **verbatim** — it is the law, not a summary of one.
> Repo-specific bindings follow it in §"Bound for this repo"; anything not bound there is
> deliberately unbound, not forgotten.

## The protocol (verbatim)

**LOCAL AGENT COORDINATION PROTOCOL — coordinator + delegated members**

### ROLES

- Coordinator (this session): decisions, briefs, reviews of reviews, integration, and the commit
  ceremony. It writes almost no code itself. Members build; independent reviewers judge.
- Model tiers: the strongest model for design-heavy builds, subtle merges and EVERY
  review; a cheaper model for mechanical phases (applying patches, running gates,
  docs/ledger, mechanical fold-ins); a same-tier critic for briefs and forensics.
- Use task appropriate thinking/effort settings for the above
- If you are not sure which models qualify, ask the operator before you begin.

### BEFORE A MEMBER STARTS

1. The brief quotes the plan verbatim: every requirement and judge the unit owns, as a checklist
   the hand-back ticks. Never paraphrase the plan.
2. One numbered cross-unit contracts note per batch, quoted into every brief and amended as
   reviews find seams. Members cite the number; they never re-derive a seam. Decisions are
   written ONCE there and referenced.
3. For non-trivial units: a one-page design note before code (deliverables and where each lands at
   runtime, contracts touched, the red-first tests by name, anything in the plan that cannot be
   built as written), reviewed first.
4. Each member gets its own git worktree, branch and build-target dir (<worktree script or
   `git worktree add`>), so nothing is built twice in one tree and no member touches another's files.

### WHILE A MEMBER WORKS

5. TDD: a red test first, then the code. After each patch: format check, lint with warnings as
   errors, targeted tests. Never write the next patch on red.
6. Foreground only: no background processes, no waiter loops, no polling. At hand-back, prove no
   strays with pgrep.
7. Members never commit, push, stage, reset, checkout or restore. A member can silently wipe all
   uncommitted work tree-wide. They edit files and hand back a PATCH plus a NOTE (files, red and
   green evidence, rc lines, deviations, anything left undone). The coordinator stages after each
   delegation.
8. Prove each claim by breaking it: a gate is proven by a plant that turns it red; a test that pins
   a call site is proven by reverting each site alone and pasting one red per site.
9. Real in the running system, not only in tests: name the production call site that consumes each
   value. Exposed-but-never-consumed is not done.
10. Review in the loop: before hand-back the member spawns its own independent reviewer (a
    different agent, code in front of it) and folds the findings, then hands back once. The
    reviewer's first question: is this real in the running system? A reviewer's remedy cites the
    law (a rule, a contract number) and gives the exact shape, so it never opens a further round.
11. Members rebase onto the moving batch tree before hand-back and deliver the diff from it.

### CONTEXT AND TOKEN DISCIPLINE (tokens are an expensive commodity, not fuel for a bonfire)

12. Why: every tool call re-sends the whole transcript, so cost grows with context size times the
    number of calls. Nine members at 400k–860k tokens each once burned a whole session limit in
    minutes.
13. A member is a phase, not a lifetime: note → build → fold. Aim for a phase to end around
    ~350k tokens. Each phase hands back at its natural boundary (deliverable green and reviewed),
    and a FRESH successor takes the next phase from the worktree plus the notes, never from the
    transcript.
14. Never resume a member whose transcript is large (400k+), or one that was killed or stopped.
    Spawn a successor with a compact brief: the goal, the contracts note, the worktree state, what
    is done, and what is left.
15. Measure, don't guess: read a member's size from its transcript (e.g. cache_read_input_tokens).
    It informs the hand-back point; it is not a hard cutoff.
16. Keep the coordinator lean: it reads short hand-back notes and reports, never raw dumps, full
    logs or large exports (grep or tail them, or have a member summarize). Delegate file-heavy
    reading and forensics to a subagent that returns the conclusion. Write each decision once to the
    contracts note instead of re-explaining it. Batch status-board updates per milestone.
17. Cap concurrency (3 builders by default; fewer while a usage limit binds). The next member
    starts when one hands back. No idle waiting agents; no acknowledgement messages to a parked
    member. One reviewer per delta; a delta review reads only the diff and the note.
18. No hard turn budgets and no forced small reads: quality first. Instead, the brief names the
    files and sections that matter, so the first read is the right one.

### HAND-BACK → LANDING (coordinator)

19. Verify the tree, never the exit code: after every apply or bulk write, check that no file went
    empty or NUL-filled (reverse-apply the patch, or compare blob ids), and restore from the base if
    one did.
20. One batch = one preflight, one commit, one push: `git add -A` → <run every pre-commit stage on
    the staged tree> → `git commit` → <the push script that watches CI per job>. The pre-commit
    hook is the confirmation, never the discovery loop. Never bypass a red check
    (no --no-verify). The full/heavy CI tier runs at phase end.
21. Batches are stacked, never serialized: while one batch's hook and CI run, the next batch is
    built in its own worktree from main. A blocker on batch N never blocks batch N+1: hand the
    blocker to the founder and start the next batch the same minute.
22. Wave end: delete landed members' worktrees and build targets (keep anything not regenerable;
    look before deleting), and record the wave's wall clock, agent-hours and hand-backs per unit
    beside the previous wave's.

### MONITORING AND REPORTING

23. Event-driven only: watch long runs with a monitor that emits a line on every terminal state
    (including stalls). No clock-based wake-ups. Never kill processes by pattern: list PIDs first.
24. A status board updated once per milestone; the founder's decisions, open questions and
    results go there. Close each change with proven-vs-deferred: what it proves in the running
    system, and what it does not yet.
25. Web research: search to find URLs, then read the raw page. Never accept a summarizing fetch tool
    as the source.

## Bound for this repo

The protocol arrived with bracketed placeholders from another project. These are the bindings the
founder has actually made here; the rest stay unbound on purpose.

Model tiers are recorded by **role and capability, never by vendor product name** — names change
every few months and this page is read by more than one agent. Resolve each role to whatever the
harness currently offers at that tier; if the mapping is unclear, Roles already says to ask the
operator before starting.

| Protocol element | Binding |
|---|---|
| Strongest model (Roles) | **Top tier** — design-heavy builds, subtle merges, and **every** review |
| Cheaper model (Roles) | **Mid tier, not the cheapest** — applying patches, running gates, docs/ledger, mechanical fold-ins. The founder deliberately chose mid over the cheapest tier: mechanical work still touches real files, and the cheapest tier needs briefs so prescriptive that the saving disappears. |
| Same-tier critic (Roles) | **Top tier** — briefs and forensics. Reviews are never downgraded to save tokens. |
| Worktrees (§4) | Plain `git worktree add`. There is no worktree script in this repo. |

**Learned in practice** — seams found in the first batch run (0.2.8, 2026-10-16), now standing:

- **Members do not rebase.** Rule 11 ("rebase onto the moving batch tree") collides with rule 7
  (members never touch git history). Members deliver the diff against the base commit named in their
  brief; the coordinator applies it onto the moving tip and resolves drift.
- **The rule-10 reviewer runs in the foreground, and the member waits for it.** A member that spawns
  its reviewer in the background can hand back before the review arrives — it happened. A hand-back
  with its review outstanding does not satisfy rule 10 and is not landed.
- **The coordinator runs its own delta review of record on every unit before landing.** In the first
  batch this caught real defects in two units that each member's own reviewer had approved: a
  feature check reading the wrong package, and a fix that silently discarded user-visible messages.

**Deliberately unbound** — asked and declined on 2026-10-06 as belonging to another project. Do
not invent a local substitute for these; ask the founder when a batch first needs one:

- §20 the preflight command and the CI-watching push script
- §24 the status board's location
- The threshold at which the full ceremony (worktree + member + reviewer) applies

Until §20 is bound, the commit ceremony stays what it already was here: the founder says when to
commit, `.githooks/pre-commit` runs the clean-room gates, and the full gate is `pnpm run package`.

## Why this is here and not in a private memory

AGENTS.md §"Storage rules" rule 4: all agent memory is repo-scoped, and assistant-private memory
layers are forbidden because they fork the source of truth and are invisible to other contributors
and tools. A coordination protocol is law, so it lives in the repo where Pi, Claude and any human
read the same copy.

## Related

- [TDD](tdd.md) — §5's red-first requirement, and this project's test conventions
- [Verify, Don't Assume](verify-dont-assume.md) — the habit §8 and §19 formalise
- [Think Before Acting](think-before-acting.md) — the design-note reflex behind §3
- [Research, Don't Guess](research-dont-guess.md) — §25's raw-source rule
- [Documentation Discipline](documentation-discipline.md) — what §24's reporting may and may not say in user-facing docs

> **Last updated:** 2026-10-16 — three standing lessons from the first batch run (0.2.8) added under the bindings
> **Earlier:** 2026-10-06 — ingested; model tiers bound by capability (top / mid / top) rather than vendor name, worktrees to `git worktree add`; §20, §24 and the ceremony threshold recorded as deliberately unbound
