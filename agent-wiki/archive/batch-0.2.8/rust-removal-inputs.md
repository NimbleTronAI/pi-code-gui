# Rust removal — founder's decisions and inputs (recorded 2026-11-04; plan NOT yet requested)

The founder will give a signal before any planning starts. Until then: no removal work.

## Decisions (verbatim where quoted)
- "0.2.8 will no longer support rust." 0.2.8 is the removal release.
- "0.2.3 will be locked as the last release that supported the rust interfaces."
- Voice in user-facing text: "we".
- The architecture diagram (media/architecture.svg → .png) is redrawn as part of the removal.
- Removal release AUTOMATICALLY deletes the `_managedBy` entries 0.2.x wrote into ~/.pi/agent/models.json
  on first start — only marked entries; user entries byte-identical. (README draft now promises this.)
- Scope: "rip everything rust related, including the clean room policy, etc."
- ACCEPTANCE: "the only remaining rust mentions would be in README and CHANGELOG and agent-wiki logs."
  i.e. `grep -ri rust` hits only README.md, CHANGELOG.md and agent-wiki/log.md.

## Known inputs for the plan
- README draft (uncommitted on release/0.2.8): the "Rust Pi support has ended" note + full scrub.
- The 0.2.8 batch is mostly Rust work. Phase D (Unit 7 wiring) is STAGED, uncommitted — HOLD; do not
  commit. Committed Rust work on release/0.2.8 since main: rust pin/startup (Units 3–5), catalog
  phases A/B/C. The plan must decide what of the batch survives (TS-side: Unit 1 catalog, Unit 2 TS
  runtime, Unit 6 summarization card, catalog source if useful for TS, Pi 1.4.0 catalog bump).
- CHANGELOG [0.2.8] currently describes Rust features — must be rewritten.
- Clean-room machinery to remove: AGENTS.md §"pi clean-room", .claude/settings.json deny rules + Bash
  PreToolUse hook (scripts/hook-cleanroom-bash.sh), scripts/check-cleanroom.sh + -smoke.sh, .githooks
  pre-commit, pretest/package wiring, CONTRIBUTING mention.
- devcontainer: post-start.sh rust block, build-rust-pi.sh, ~/.pi/rust-pi-build cache (volume).
- package.json rust* settings/commands, defaultRuntime, sessionHistoryScope; src/rust-*.ts;
  rust-pi-version.json; rust-pi-catalog.generated.json; gen-rust-pi-catalog.mjs; README badge already gone.
- Existing users' Rust sessions in ~/.pi/agent/sessions-rust/ stay on disk, unlisted (README says so).
