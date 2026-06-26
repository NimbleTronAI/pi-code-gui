#!/usr/bin/env bash
# Runs on every container start. Restores git identity and keeps
# pi-coding-agent + project pi packages up to date.
set -u

# ── Git identity ──────────────────────────────────────
# Set your name/email below, or configure via GIT_USER / GIT_EMAIL env vars.
GIT_NAME="${GIT_USER:-}"
GIT_EMAIL="${GIT_EMAIL:-}"

if [ -n "$GIT_NAME" ] && [ -n "$GIT_EMAIL" ]; then
    echo "==> Git"
    git config --global user.name "$GIT_NAME"
    git config --global user.email "$GIT_EMAIL"
    echo "    Git identity set: $GIT_NAME <$GIT_EMAIL>"
fi

# ── Commit signing (SSH via 1Password agent) ─────────
# Set GIT_SIGNING_KEY to the literal public key string (e.g.
# "ssh-ed25519 AAAA... comment"). The matching private key must be in
# 1Password's SSH agent (forwarded automatically by Dev Containers) and
# added to GitHub as a "Signing Key" (Settings → SSH and GPG keys).
if [ -n "${GIT_SIGNING_KEY:-}" ]; then
    echo "==> Git signing (SSH)"
    git config --global gpg.format ssh
    git config --global user.signingkey "key::${GIT_SIGNING_KEY}"
    git config --global commit.gpgsign true
    git config --global tag.gpgsign true
    echo "    Signing enabled — commits and tags will be SSH-signed"
fi

# ── pi-coding-agent ──────────────────────────────────
# Check for updates instead of reinstalling every start.  npm install -g is
# destructive (removes old files before writing new ones), which races with
# the VS Code extension host activating and importing from node_modules.
echo "==> pi-coding-agent"
CURRENT=$(pi --version 2>/dev/null || echo "0.0.0")
LATEST=$(npm view @earendil-works/pi-coding-agent version 2>/dev/null || echo "")
if [ -n "$LATEST" ] && [ "$CURRENT" != "$LATEST" ]; then
    echo "    updating: $CURRENT → $LATEST"
    npm install -g @earendil-works/pi-coding-agent@latest >/dev/null 2>&1 && \
        echo "    pi $LATEST → $(command -v pi)" || \
        echo "    warn: pi install/update failed (network?) — existing pi still works"
else
    echo "    pi $CURRENT (up to date)"
fi

# ── pi packages ──────────────────────────────────────
# Update project-local pi packages to latest on every start. `--approve` trusts
# the project's .pi/ files for this command so the install runs non-interactively;
# without it, pi stops to ask "Trust project folder?" and blocks container start.
echo "==> pi packages (latest)"
if command -v pi &>/dev/null; then
    pi install npm:pi-web-access -l --approve
    echo "    pi packages updated"
else
    echo "    warn: pi not found — skipping package updates"
fi

# ── rust-pi (TEMPORARY local build) ──────────────────
# The extension resolves rust-pi at ~/.local/bin/rust-pi, which lives on the
# container layer and is WIPED on every rebuild. We're temporarily running a
# locally-built rust-pi (pi_agent_rust 6c5f43b3 — the DeepSeek thinking-level
# fix, ahead of the upstream release). It's stashed in the persistent ~/.pi
# volume; restore it here so the extension survives rebuilds.
# REVERT once upstream pi_agent_rust ships the fix: delete this block, remove
# /home/node/.pi/rust-pi-6c5f43b3, and install the published rust-pi.
if [ -x /home/node/.pi/rust-pi-6c5f43b3 ]; then
    echo "==> rust-pi (local 6c5f43b3)"
    mkdir -p /home/node/.local/bin
    cp /home/node/.pi/rust-pi-6c5f43b3 /home/node/.local/bin/rust-pi
    echo "    restored $(/home/node/.local/bin/rust-pi --version 2>/dev/null | head -1)"
fi
