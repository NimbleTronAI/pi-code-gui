#!/usr/bin/env bash
# check-cleanroom.sh — the pi_agent_rust source clean-room wall, gated.
#
# pi_agent_rust / asupersync / franken-* ship under "MIT + OpenAI/Anthropic Rider":
# the Software and derivatives may not be made available to a Restricted Party
# (OpenAI, Anthropic, their affiliates/agents). Claude Code is an Anthropic surface
# — content read into it is provided to Anthropic — so that source must not enter an
# agent context. This wall has two bricks, both asserted here:
#
#   (1) The agent config (.claude/settings.json) carries permissions.deny Read()
#       rules for every restricted dependency-source shape, so a config edit that
#       drops a rule fails the commit.
#   (2) No live repo file references those dependency-source paths (a script or
#       test that reads a checkout would route the source into logs/context).
#       History/decision-record files are exempt (they cite the paths to state the
#       rule) via EXEMPT_GLOBS.
#
# The MIT ancestor github.com/earendil-works/pi carries no rider and is NOT covered
# by this wall — it may be read/fetched freely.
#
# Env-overridable settings path (CLEANROOM_SETTINGS_PATH) so the companion
# -smoke.sh can assert the gate fails against a tampered config.
set -uo pipefail

cd "$(dirname "$0")/.."

# ─── CONFIG ──────────────────────────────────────────────────────────────────
# The restricted crates. A deny Read() rule must cover each needle, and no live
# file may reference an on-disk source path that matches SOURCE_PATH_RE.
RESTRICTED_NEEDLES=("pi_agent_rust" "asupersync-" "franken-")

# Regex (ripgrep syntax) matching the forbidden on-disk source-path shapes:
# a pi_agent_rust clone's source tree (any /home checkout or a src|crates|target
# subpath), the cargo git checkout, and the asupersync / franken-* registry
# sources. Deliberately NOT the bare repo name: "pi_agent_rust" legitimately
# appears in issue URLs, the managed-download config (src/rust-pi-version.json),
# and this repo's branch name.
SOURCE_PATH_RE='\.cargo/(git/checkouts/pi_agent_rust|registry/src/[^"'"'"' ]*/(asupersync|franken))|/home/[^"'"'"' ]*/pi_agent_rust|pi_agent_rust[^"'"'"' ]*/(src|crates|target|tests)/'

# The agent-config file that must carry the permissions.deny rules.
SETTINGS=${CLEANROOM_SETTINGS_PATH:-".claude/settings.json"}

# Where to scan for live references, and which paths are exempt (decision record,
# wiki log/archive, and this wall's own scripts — they legitimately name the shapes).
SCAN_ROOTS=(src scripts media agent-wiki .claude .github .githooks .devcontainer .vscode AGENTS.md README.md CONTRIBUTING.md CHANGELOG.md)
EXEMPT_GLOBS=(
  '!agent-wiki/log.md'
  '!agent-wiki/archive/**'
  '!scripts/check-cleanroom.sh'
  '!scripts/check-cleanroom-smoke.sh'
  '!scripts/hook-cleanroom-bash.sh'
  # The deny-rule registry itself must NAME the paths it denies — that is its job. Its contents
  # are validated structurally by check (1) above, not by this text scan.
  '!.claude/settings.json'
  '!tmp/cleanroom-kit/**'
)
# ─────────────────────────────────────────────────────────────────────────────

fails=0

# ── (1) the deny rules exist in the agent config ─────────────────────────────
if [[ ! -f "$SETTINGS" ]]; then
    echo "FAIL: $SETTINGS not found (the clean-room deny rules must live there)"
    exit 1
fi

for needle in "${RESTRICTED_NEEDLES[@]}"; do
    if python3 - "$SETTINGS" "$needle" <<'PY'; then
import json, sys
settings_path, needle = sys.argv[1], sys.argv[2]
with open(settings_path) as f:
    settings = json.load(f)
deny = settings.get("permissions", {}).get("deny", [])
# A rule must actually COVER the needle's sources, not merely mention the string. The old check
# was `needle in rule`, which a decorative rule like Read(/nonexistent/pi_agent_rust/x) satisfied
# while denying nothing. Require a recursive Read() glob rooted at ** or /.
import re as _re
_pat = _re.compile(r"^Read\((?P<glob>.+)\)$")
def _covers(rule):
    m = _pat.match(rule.strip())
    if not m: return False
    g = m.group("glob")
    return needle in g and g.endswith("/**") and (g.startswith("**/") or g.startswith("/"))
ok = any(_covers(r) for r in deny)
sys.exit(0 if ok else 1)
PY
        echo "ok: settings deny a Read() of ${needle}* sources"
    else
        echo "FAIL: $SETTINGS has no permissions.deny Read() rule covering '${needle}' sources"
        fails=$((fails + 1))
    fi
done

# ââ (1b) the Bash PreToolUse hook + the WebFetch deny âââââââââ
# AGENTS.md promises "permissions.deny Read()/WebFetch rules + a Bash PreToolUse hook".
# Only the Read() rules were ever asserted, so deleting the whole hooks block passed, and the
# WebFetch rule was never checked at all.
if python3 - "$SETTINGS" <<'HOOKCHK'; then
import json, sys
with open(sys.argv[1]) as f:
    settings = json.load(f)
entries = settings.get("hooks", {}).get("PreToolUse", [])
ok = any(
    e.get("matcher") == "Bash"
    and any("hook-cleanroom-bash.sh" in (h.get("command") or "") for h in e.get("hooks", []))
    for e in entries
)
sys.exit(0 if ok else 1)
HOOKCHK
    echo "ok: a Bash PreToolUse hook runs the clean-room guard"
else
    echo "FAIL: $SETTINGS has no Bash PreToolUse hook running scripts/hook-cleanroom-bash.sh"
    fails=$((fails + 1))
fi

if python3 - "$SETTINGS" <<'WEBCHK'; then
import json, sys
with open(sys.argv[1]) as f:
    settings = json.load(f)
deny = settings.get("permissions", {}).get("deny", [])
sys.exit(0 if any(r.strip().startswith("WebFetch(") for r in deny) else 1)
WEBCHK
    echo "ok: a WebFetch deny rule is present"
else
    echo "FAIL: $SETTINGS has no WebFetch() deny rule (the wall must cover fetching source too)"
    fails=$((fails + 1))
fi

# rg MUST exist: a missing rg exited 127 and fell through to the PASS branch below, so the
# whole scan silently reported ok on a machine that simply lacked ripgrep.
if ! command -v rg >/dev/null 2>&1; then
    echo "FAIL: ripgrep (rg) is not installed - the source-path scan cannot run"
    echo "  install it:  apt install ripgrep   |   brew install ripgrep"
    echo "  (this check refuses to pass without it: a missing rg once exited 127 and"
    echo "   fell through to a silent PASS, so the wall reported OK while scanning nothing)"
    echo "check-cleanroom: FAIL (cannot verify)"
    exit 1
fi
# ── (2) no live repo file references the dependency-source paths ─────────────
# rg exits 1 when nothing matches (PASS); 0 = matches (FAIL); 2 = error (fail LOUD).
exempt_args=()
for g in "${EXEMPT_GLOBS[@]}"; do exempt_args+=(--iglob "$g"); done

matches=$(rg -n "$SOURCE_PATH_RE" "${SCAN_ROOTS[@]}" "${exempt_args[@]}" 2>&1)
rc=$?
if [[ $rc -ne 0 && $rc -ne 1 ]]; then
    # ANY status other than hit(0)/no-match(1) is an error: 2 = rg error, 127 = not found, ...
    # The old test caught only rc==2 and treated everything else as "no matches".
    echo "FAIL: rg exited $rc (a renamed root? a broken pattern?): $matches"
    fails=$((fails + 1))
elif [[ $rc -eq 0 ]]; then
    echo "FAIL: live files reference restricted dependency-source paths:"
    echo "$matches"
    fails=$((fails + 1))
else
    echo "ok: no live repo file references the dependency-source paths"
fi

if [[ "$fails" -gt 0 ]]; then
    echo "check-cleanroom: FAIL ($fails)"
    exit 1
fi
echo "check-cleanroom: OK (the clean-room wall stands)"
