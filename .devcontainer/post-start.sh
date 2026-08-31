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

# ── rust-pi (pinned release) ─────────────────────────
# The extension resolves rust-pi at ~/.local/bin/rust-pi, which lives on the
# container layer and is WIPED on every rebuild — so it is installed here.
#
# This block used to restore a locally-built 87b70f74 (0.1.20) from the persistent
# ~/.pi volume, from before upstream shipped those fixes. It now installs the
# version the extension is actually pinned to (src/rust-pi-version.json), because
# 0.2.0 targets the rust-pi 0.3.0 RPC contract and does not support older binaries.
# Restoring 0.1.20 on every container start silently reverted the pin and made
# 0.3.0-only behaviour untestable — including a probe run that reported a command
# surface belonging to the wrong binary.
PIN_TAG="$(sed -n 's/.*"tag"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' /workspaces/pi-vscode-gui/src/rust-pi-version.json 2>/dev/null)"
if [ -n "$PIN_TAG" ]; then
    echo "==> rust-pi (pinned $PIN_TAG)"
    WANT="${PIN_TAG#v}"
    HAVE="$(/home/node/.local/bin/rust-pi --version 2>/dev/null | sed -n 's/^pi \([0-9.]*\).*/\1/p')"
    if [ "$HAVE" = "$WANT" ]; then
        echo "    already on $HAVE"
    else
        case "$(uname -m)" in
            aarch64|arm64) ASSET="pi-linux-arm64.tar.xz" ;;
            *)             ASSET="pi-linux-amd64.tar.xz" ;;
        esac
        BASE="https://github.com/Dicklesworthstone/pi_agent_rust/releases/download/$PIN_TAG"
        TMP="$(mktemp -d)"
        # Checksum-verified, like the extension's own managed install. A failure here
        # leaves whatever was already installed rather than breaking container start.
        if curl -fsSL -o "$TMP/$ASSET" "$BASE/$ASSET" && curl -fsSL -o "$TMP/SHA256SUMS" "$BASE/SHA256SUMS"; then
            if (cd "$TMP" && grep " $ASSET\$" SHA256SUMS | sha256sum -c - >/dev/null 2>&1); then
                mkdir -p /home/node/.local/bin
                tar -xJf "$TMP/$ASSET" -C "$TMP"
                BIN="$(find "$TMP" -type f -name pi -perm -u+x | head -1)"
                if [ -n "$BIN" ]; then
                    install -m 0755 "$BIN" /home/node/.local/bin/rust-pi
                    echo "    installed $(/home/node/.local/bin/rust-pi --version 2>/dev/null | head -1)"
                else
                    echo "    WARNING: no pi binary in $ASSET — left existing install alone"
                fi
            else
                echo "    WARNING: checksum mismatch for $ASSET — left existing install alone"
            fi
        else
            echo "    WARNING: could not download $PIN_TAG (offline?) — left existing install alone"
        fi
        rm -rf "$TMP"
    fi
fi
