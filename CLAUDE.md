# Claude Code — project law

Read `AGENTS.md` (the project protocol). Non-negotiable highlight:

- **pi clean-room (license wall):** never read/fetch/reference the source of
  `pi_agent_rust` / `asupersync` / `franken-*` into context — any channel (Read, Bash,
  WebFetch). Probe the binary at the wire instead. The MIT ancestor
  `github.com/earendil-works/pi` is the whitelisted clean-room reference. See
  `AGENTS.md` §"pi clean-room — license law"; enforced by `.claude/settings.json` deny
  rules + `scripts/check-cleanroom.sh`.
