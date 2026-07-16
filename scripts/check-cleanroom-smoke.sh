#!/usr/bin/env bash
# check-cleanroom-smoke.sh — asserts the clean-room gate is non-vacuous.
#
# Tampers a COPY of the agent config (drops one deny rule) and asserts
# check-cleanroom.sh fails against it; then asserts the real config passes.
#
# SETTINGS + TAMPER_NEEDLE match check-cleanroom.sh's config.
set -uo pipefail

cd "$(dirname "$0")/.."

SETTINGS=".claude/settings.json"    # the agent-config file
TAMPER_NEEDLE="pi_agent_rust"       # one restricted needle to strip in the tampered copy

fails=0
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT

# (a) a config MISSING one deny rule must FAIL the gate.
python3 - "$SETTINGS" "$tmp/tampered.json" "$TAMPER_NEEDLE" <<'PY'
import json, sys
src, dst, needle = sys.argv[1], sys.argv[2], sys.argv[3]
with open(src) as f:
    settings = json.load(f)
deny = settings.get("permissions", {}).get("deny", [])
settings["permissions"]["deny"] = [r for r in deny if needle not in r]
with open(dst, "w") as f:
    json.dump(settings, f)
PY
if CLEANROOM_SETTINGS_PATH="$tmp/tampered.json" bash scripts/check-cleanroom.sh >/dev/null 2>&1; then
    echo "FAIL: the gate passed a config with the '$TAMPER_NEEDLE' deny rule removed (vacuous gate)"
    fails=$((fails + 1))
else
    echo "ok: a tampered config (deny rule removed) is caught"
fi

# (b) the REAL config must pass.
if bash scripts/check-cleanroom.sh >/dev/null 2>&1; then
    echo "ok: the real $SETTINGS passes"
else
    echo "FAIL: the real $SETTINGS fails the clean-room gate"
    fails=$((fails + 1))
fi

if [[ "$fails" -gt 0 ]]; then
    echo "check-cleanroom-smoke: FAIL ($fails)"
    exit 1
fi
echo "check-cleanroom-smoke: OK (the gate bites and the real config stands)"
