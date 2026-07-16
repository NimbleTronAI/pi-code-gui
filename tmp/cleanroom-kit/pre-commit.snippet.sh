# ─── PASTE into your pre-commit hook (or .pre-commit-config.yaml as a local hook) ───
# Backpressure of FIRST resort: the wall is checked on every commit, in the dev
# environment, not deferred to CI. Both lines must run — the gate AND its smoke
# (the smoke proves the gate isn't vacuous).

echo "==> pre-commit: source clean-room wall (deny rules present + no source-path refs) + smoke"
bash scripts/check-cleanroom.sh
bash scripts/check-cleanroom-smoke.sh

# If you use pre-commit.com framework instead of a raw hook, add to
# .pre-commit-config.yaml:
#
#   - repo: local
#     hooks:
#       - id: cleanroom
#         name: source clean-room wall
#         entry: bash scripts/check-cleanroom.sh
#         language: system
#         pass_filenames: false
#       - id: cleanroom-smoke
#         name: source clean-room wall — smoke (non-vacuity)
#         entry: bash scripts/check-cleanroom-smoke.sh
#         language: system
#         pass_filenames: false
#
# ALSO run the same two scripts as a CI job so a commit made with --no-verify (or
# a hook someone deleted) can't sneak past. The pre-commit run is the fast signal;
# CI is the backstop. Both are cheap.
