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
# TWO SOURCES, in this order:
#   1. The released asset for the pinned tag, checksum-verified.
#   2. A locally BUILT binary cached at ~/.pi/rust-pi-build/pi-<version> (an external docker
#      volume, so it survives rebuilds), built by .devcontainer/build-rust-pi.sh.
#
# The release comes first because it is what users run: since v0.6.0 upstream builds Linux assets
# against a glibc 2.28 floor (v0.8.0 measured with objdump -T), so it execs on this Debian 13
# (2.41). The local build is a FALLBACK for a release whose floor climbs again — v0.3.0 needed
# 2.39 and v0.5.1 needed 2.43, which could not exec here at all — and it is built with a lighter
# profile than upstream's (see build-rust-pi.sh), so it should not displace a release that runs.
#
# AND NOTHING IS INSTALLED WITHOUT BEING RUN FIRST. This block used to `install` whatever it
# extracted and then print the version, so an asset that could not exec REPLACED a working binary
# and left the container with a broken rust-pi — the extension then failed sessions with
# "RPC 'get_state' timed out after 15000ms", naming nothing. Every candidate is now probed with
# --version before it is allowed to overwrite what works.
PIN_TAG="$(sed -n 's/.*"tag"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' /workspaces/pi-vscode-gui/src/rust-pi-version.json 2>/dev/null)"
if [ -n "$PIN_TAG" ]; then
    echo "==> rust-pi (pinned $PIN_TAG)"
    WANT="${PIN_TAG#v}"
    TARGET=/home/node/.local/bin/rust-pi
    CACHED="/home/node/.pi/rust-pi-build/pi-$WANT"

    rust_pi_version() { "$1" --version 2>/dev/null | sed -n 's/^pi \([0-9.]*\).*/\1/p'; }

    INSTALLED=0
    if [ "$(rust_pi_version "$TARGET")" = "$WANT" ]; then
        echo "    already on $WANT"
        INSTALLED=1
    else
        case "$(uname -m)" in
            aarch64|arm64) ASSET="pi-linux-arm64.tar.xz" ;;
            *)             ASSET="pi-linux-amd64.tar.xz" ;;
        esac
        BASE="https://github.com/Dicklesworthstone/pi_agent_rust/releases/download/$PIN_TAG"
        TMP="$(mktemp -d)"
        # Checksum-verified, like the extension's own managed install. Any failure here leaves
        # whatever was already installed rather than breaking container start.
        if curl -fsSL -o "$TMP/$ASSET" "$BASE/$ASSET" && curl -fsSL -o "$TMP/SHA256SUMS" "$BASE/SHA256SUMS"; then
            if (cd "$TMP" && grep " $ASSET\$" SHA256SUMS | sha256sum -c - >/dev/null 2>&1); then
                tar -xJf "$TMP/$ASSET" -C "$TMP"
                BIN="$(find "$TMP" -type f -name pi -perm -u+x | head -1)"
                if [ -z "$BIN" ]; then
                    echo "    WARNING: no pi binary in $ASSET"
                elif WHY="$("$BIN" --version 2>&1 >/dev/null)"; [ "$(rust_pi_version "$BIN")" != "$WANT" ]; then
                    # Downloaded and verified, but will not run here. Say why, and say what to do.
                    echo "    WARNING: the released $PIN_TAG binary will not run in this container:"
                    echo "             ${WHY:-unknown error}"
                    echo "             Trying the local build cache instead (bash .devcontainer/build-rust-pi.sh makes one)."
                else
                    mkdir -p /home/node/.local/bin
                    install -m 0755 "$BIN" "$TARGET"
                    echo "    installed $("$TARGET" --version 2>/dev/null | head -1)"
                    INSTALLED=1
                fi
            else
                echo "    WARNING: checksum mismatch for $ASSET"
            fi
        else
            echo "    WARNING: could not download $PIN_TAG (offline?)"
        fi
        rm -rf "$TMP"
    fi
    if [ "$INSTALLED" = 0 ]; then
        if [ -x "$CACHED" ] && [ "$(rust_pi_version "$CACHED")" = "$WANT" ]; then
            mkdir -p /home/node/.local/bin
            install -m 0755 "$CACHED" "$TARGET"
            echo "    restored locally built $WANT from ~/.pi cache"
        else
            echo "    Keeping $(rust_pi_version "$TARGET" | grep . || echo none). To get $WANT, build it locally:"
            echo "      bash .devcontainer/build-rust-pi.sh   (caches to ~/.pi, which survives rebuilds)"
        fi
    fi
fi
