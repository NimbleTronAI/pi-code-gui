<!-- Paste this section into your AGENTS.md (and add a one-line pointer in CLAUDE.md). -->

## pi clean-room — license law

Do not read, fetch, paste, or reference the source of `pi_agent_rust` and its restricted
runtime deps `asupersync`, `franken-decision`, `franken-evidence`, `franken-kernel` (the
`~/.cargo` checkout/registry copies included) into any agent context. These crates ship
under "MIT + OpenAI/Anthropic Rider": the Software and derivatives may not be made
available to a Restricted Party (OpenAI, Anthropic, their affiliates/agents). Claude Code
is an Anthropic surface — content read into it is provided to Anthropic. Characterize the
dependency as a black box: probe it at the wire, keep your own API notes, read your own
docs. A fork's diffs of the restricted source are a derivative work, so routing those
through the agent is covered by the same rule.

Enforced by the agent-config `permissions.deny` Read() rules + `scripts/check-cleanroom.sh`
(pre-commit + a CI smoke). Removing a deny rule fails the commit.

`github.com/earendil-works/pi` (plain MIT © 2025 Mario Zechner) is the ancestor
`pi_agent_rust` was ported from. It carries no rider and MAY be read and fetched freely as
a clean-room reference. If you port ancestor code verbatim, carry its LICENSE note in the
module header + a NOTICE entry.
