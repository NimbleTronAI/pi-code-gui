#!/usr/bin/env bash
# Build the PINNED rust-pi release from source into the persistent ~/.pi volume.
#
#   bash .devcontainer/build-rust-pi.sh
#
# WHY A SOURCE BUILD. Upstream's Linux binaries are built on a nightly toolchain and their glibc
# floor climbs between releases: v0.3.0 needs GLIBC_2.39, v0.5.1 needs 2.43. This container is
# Debian 13 with glibc 2.41 and its apt sources are pinned to a snapshot, so 2.43 is simply not
# available — the released v0.5.1 binary cannot exec here at all ("libm.so.6: version `GLIBC_2.43'
# not found"). A binary compiled HERE links against this machine's glibc, so the floor stops
# mattering. Upstream ships no musl/static asset, so this is the only way to run it locally.
#
# SINCE v0.6.0 upstream builds Linux assets against a glibc 2.28 floor (measured on v0.8.0 with
# objdump -T: max GLIBC_2.28 on arm64 and amd64), so the released binary runs here too. This
# script stays as the fallback for a release whose floor climbs again, and to test a pin offline.
#
# The result is cached at ~/.pi/rust-pi-build/pi-<version>, which is an EXTERNAL docker volume
# (see docker-compose.yml) and therefore survives container rebuilds. post-start.sh installs the
# released asset first and falls back to this cache only when the release will not run here, so a
# rebuild on a too-new glibc floor reinstates the working binary in a second rather than
# recompiling for twenty minutes.
#
# Re-run this when the pin moves, or if the ~/.pi volume is ever recreated.
#
# CLEAN ROOM: compiling is fine; READING the source is not. pi_agent_rust is "MIT + OpenAI/
# Anthropic Rider" and must not enter an agent context — see AGENTS.md §"pi clean-room". cargo
# fetches the source into ~/.cargo, which .claude/settings.json already denies reading. Build it,
# do not open it.
set -euo pipefail

REPO="https://github.com/Dicklesworthstone/pi_agent_rust"
# The checkout this script lives in, so a worktree builds ITS pin rather than the main checkout's.
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE_DIR="/home/node/.pi/rust-pi-build"
# Upstream states the toolchain each release was built with in its release notes; v0.5.x through
# v0.8.0 use this one (v0.8.0's notes: "the repository pins nightly-2026-08-31"). Pinning it avoids a future nightly breaking a build that has nothing to do with us.
TOOLCHAIN="nightly-2026-08-31"

PIN_TAG="$(sed -n 's/.*"tag"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$ROOT/src/rust-pi-version.json")"
[ -n "$PIN_TAG" ] || { echo "error: no tag in src/rust-pi-version.json" >&2; exit 1; }
WANT="${PIN_TAG#v}"
DEST="$CACHE_DIR/pi-$WANT"

if [ -x "$DEST" ] && "$DEST" --version >/dev/null 2>&1; then
  echo "rust-pi $WANT already built and runnable: $DEST"
  echo "  ($("$DEST" --version | head -1))"
  exit 0
fi

# cmake and a C compiler are needed by transitive C dependencies. They live on the container
# layer, so a rebuild loses them — which is exactly why the BINARY is cached rather than rebuilt.
command -v cmake >/dev/null || { echo "==> installing cmake"; sudo apt-get update -qq && sudo apt-get install -y -qq cmake; }

if ! command -v "$HOME/.cargo/bin/cargo" >/dev/null 2>&1 && ! command -v cargo >/dev/null 2>&1; then
  echo "==> installing rust $TOOLCHAIN"
  curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \
    | sh -s -- -y --profile minimal --default-toolchain "$TOOLCHAIN"
fi
CARGO="$(command -v cargo || echo "$HOME/.cargo/bin/cargo")"

BUILD_ROOT="$(mktemp -d)"
trap 'rm -rf "$BUILD_ROOT"' EXIT

# MEMORY. The crate's own `release` profile is fat LTO with one codegen unit. Measured building
# v0.8.0 here (8 cores, ~5-7 GB free): the final link was SIGKILLed by the OOM killer, and with LTO
# off but optimization kept, the library alone ran past ten minutes. This profile finished in
# 2m31s once dependencies were built. It is a LOCAL testing binary — the released assets are
# what users download — so trade size and peak speed for a build that completes. Override any of
# these from the environment to get the upstream profile back.
export CARGO_PROFILE_RELEASE_LTO="${CARGO_PROFILE_RELEASE_LTO:-off}"
export CARGO_PROFILE_RELEASE_CODEGEN_UNITS="${CARGO_PROFILE_RELEASE_CODEGEN_UNITS:-256}"
export CARGO_PROFILE_RELEASE_OPT_LEVEL="${CARGO_PROFILE_RELEASE_OPT_LEVEL:-1}"

echo "==> building rust-pi $PIN_TAG from source (this takes a while)"
# The crate is `pi_agent_rust` (the repo also contains a `pi_agent_rust-fuzz` binary crate, so
# cargo refuses to guess); the binary it produces is named `pi`.
"$CARGO" install --git "$REPO" --tag "$PIN_TAG" --root "$BUILD_ROOT" --locked pi_agent_rust

BUILT="$BUILD_ROOT/bin/pi"
[ -x "$BUILT" ] || { echo "error: no binary at $BUILT" >&2; exit 1; }

# Verify it RUNS before caching it. A cached binary that cannot exec would be reinstalled on
# every container start, which is the failure this whole script exists to avoid.
"$BUILT" --version >/dev/null 2>&1 || { echo "error: the binary just built will not run" >&2; exit 1; }

mkdir -p "$CACHE_DIR"
install -m 0755 "$BUILT" "$DEST"
echo "==> cached $DEST"
echo "    $("$DEST" --version | head -1)"
echo "    post-start.sh falls back to this when the released $PIN_TAG binary will not run here."

# CLEAN ROOM: cargo left the pinned tag's SOURCE in ~/.cargo/git (and crate sources in
# ~/.cargo/registry/{src,cache}). Remove them unopened so
# it cannot be read into an agent context later (AGENTS.md §"pi clean-room").
rm -rf "$HOME/.cargo/git" "$HOME/.cargo/registry/src" "$HOME/.cargo/registry/cache"
