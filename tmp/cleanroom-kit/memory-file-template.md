<!-- Drop this into the project's agent-memory dir as a real memory file
     (e.g. ~/.claude/projects/<slug>/memory/pi-cleanroom-law.md) and add a one-line
     pointer to that project's MEMORY.md index. The memory points at the gate; the
     gate (check-cleanroom.sh + deny rules) is the enforcement. Ship both. -->
---
name: pi-cleanroom-law
description: "Never read pi_agent_rust/asupersync/franken-* source into an agent context (MIT+OpenAI/Anthropic Rider); earendil-works/pi is whitelisted; enforced by deny rules + check-cleanroom.sh"
metadata:
  type: project
---

`pi_agent_rust` (+ `asupersync`, `franken-decision`, `franken-evidence`, `franken-kernel`)
ships under "MIT + OpenAI/Anthropic Rider": the Software and derivatives may not be made
available to a Restricted Party (OpenAI, Anthropic, affiliates/agents). Claude Code is an
Anthropic surface, so their source must not enter agent context — treat the dependency as
a black box (wire probes + our own API notes). A fork's diffs of that source are a
derivative work → same rule. The MIT ancestor `github.com/earendil-works/pi` (© 2025 Mario
Zechner) carries no rider and is whitelisted: read/fetch it freely as a clean-room reference.

**How to apply:** the wall is codified — `permissions.deny` Read() rules in the agent
config + `scripts/check-cleanroom.sh` + `-smoke.sh` at pre-commit and CI. Before
recommending anything that reads a vendored dependency, confirm it is not one of the
restricted crates. Verify the deny rules still cover every restricted crate at HEAD before
trusting this note (paths/crate-names can drift).
