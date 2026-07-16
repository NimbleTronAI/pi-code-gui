# Source Clean-Room Kit — pi_agent_rust license wall for AI-agent contexts

Files to prevent an AI coding agent from reading the source of `pi_agent_rust` (and
its restricted runtime deps) into its context, while allowing the MIT ancestor to be
read as a clean-room reference.

## What the license requires

`pi_agent_rust` and its runtime deps `asupersync`, `franken-decision`, `franken-evidence`,
and `franken-kernel` (author: Jeffrey Emanuel) ship under **"MIT License (with
OpenAI/Anthropic Rider)"**. The rider grants no rights to Restricted Parties (OpenAI,
Anthropic, their affiliates and agents) and states you may not make the Software or any
derivative work available "to or for" a Restricted Party.

Claude Code is an Anthropic surface: content read into it is provided to Anthropic. So
reading `pi_agent_rust` / `asupersync` / `franken-*` source into an agent context routes
that source to a Restricted Party. This kit blocks that.

## The mitigation that allows reading earendil-works/pi

`pi_agent_rust` is a Rust port of `github.com/earendil-works/pi` (plain MIT © 2025 Mario
Zechner). That upstream carries no rider, so it may be read and fetched freely as a
clean-room reference. The wall forbids the riddered crates' source; the ancestor is
whitelisted.

## What's in this kit

| File | What it is | Where it goes |
|---|---|---|
| `scripts/check-cleanroom.sh` | The gate. (1) asserts the deny rules exist in the agent config, (2) asserts no live repo file references the restricted source paths. | `scripts/` |
| `scripts/check-cleanroom-smoke.sh` | Tampers a copy of the config (drops a deny rule), asserts the gate fails against it, then asserts the real config passes. | `scripts/` |
| `settings.deny.snippet.json` | The `permissions.deny` Read() rules to paste into your agent config (`.claude/settings.json` for Claude Code). | `.claude/settings.json` |
| `pre-commit.snippet.sh` | Two lines to add to your pre-commit hook (+ a `.pre-commit-config.yaml` and CI variant). | pre-commit hook + CI |
| `AGENTS-md-law.snippet.md` | The rule for AGENTS.md / CLAUDE.md, plus the whitelisted-ancestor carve-out. | `AGENTS.md` |
| `memory-file-template.md` | An agent-memory file (+ MEMORY.md pointer) that recalls the rule and points at the gate. | agent memory dir |

## Setup

1. **`settings.deny.snippet.json`:** set your `~/.cargo` home dir; fold the `deny` array
   into `.claude/settings.json`. One Read() rule per restricted crate.
2. **`scripts/check-cleanroom.sh`:** the CONFIG block is preset for `pi_agent_rust` /
   `asupersync` / `franken-*`. Adjust `SETTINGS`, `SCAN_ROOTS`, `EXEMPT_GLOBS` for your
   repo layout.
3. **`pre-commit.snippet.sh`:** paste the two lines into your hook and mirror them as a
   CI job (so a `--no-verify` commit does not bypass the wall).
4. **`AGENTS-md-law.snippet.md` + `memory-file-template.md`:** paste in.

## Enforcement, not prose

The deny rules and the two scripts are the wall. `check-cleanroom.sh` runs at pre-commit
+ CI and fails the commit if a deny rule goes missing or a live file references the
restricted source. The AGENTS.md text and the memory file point at the gate; they do not
replace it.
