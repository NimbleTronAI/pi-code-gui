#!/usr/bin/env bash
# hook-cleanroom-bash.sh — PreToolUse(Bash) brick of the pi clean-room wall.
#
# The agent-config Read() deny rules stop the Read tool, but Bash can route the same
# restricted source into agent context via cat/grep/sed/git-show — which is exactly how
# it happened before the wall existed. This hook rejects a Bash command that references
# a restricted-source PATH SHAPE, or that would create a fresh clone / fetch raw source.
#
# Deliberately path-shaped, not name-based: the bare string "pi_agent_rust" is legal in
# commands (it is this repo's BRANCH name, and the upstream repo name appears in issue
# URLs and the managed-download config). Only source-tree shapes are blocked.
#
# Exit 2 blocks the tool call and feeds stderr back to the agent as the reason.
set -uo pipefail

input="$(cat)"

cmd="$(python3 - <<'PY' "$input"
import json, sys
try:
    print(json.loads(sys.argv[1]).get("tool_input", {}).get("command", ""))
except Exception:
    print("")
PY
)"

[[ -z "$cmd" ]] && exit 0

# Restricted-source path shapes + clone/raw-fetch vectors:
#  - any pi_agent_rust source tree (clone dirs: .../pi_agent_rust/src|crates|target|tests, or a home-dir clone root)
#  - the cargo git checkout / registry sources of pi_agent_rust, asupersync, franken-*
#  - `git clone` of the upstream repo (recreating a local copy)
#  - raw.githubusercontent.com fetches of the upstream org's source
RE='pi_agent_rust[^ ]*/(src|crates|target|tests)(/|[" ]|$)'
RE+='|/home/[^ ]*/pi_agent_rust'
RE+='|\.cargo/git/checkouts/pi_agent_rust'
RE+='|\.cargo/registry/src/[^ ]*/(asupersync|franken)'
RE+='|git[[:space:]]+clone[^|;&]*pi_agent_rust'
RE+='|raw\.githubusercontent\.com/Dicklesworthstone'

if echo "$cmd" | grep -qE "$RE"; then
  echo "cleanroom: blocked — this Bash command references pi_agent_rust/asupersync/franken-* SOURCE (MIT + OpenAI/Anthropic Rider: that source must not enter agent context). Probe the binary at the wire instead; the MIT ancestor github.com/earendil-works/pi may be read freely. See the 'pi clean-room' section of AGENTS.md." >&2
  exit 2
fi
exit 0
