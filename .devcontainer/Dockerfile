# syntax=docker/dockerfile:1.7
#
# Dev container for pi-vscode-gui — VS Code extension development.
# Based on Microsoft's TypeScript + Node devcontainer image.
#
# Uses the Debian 13 "trixie" variant (glibc >= 2.39) rather than bookworm
# (glibc 2.36) so the prebuilt Rust Pi binary (`pi_agent_rust`, which links
# against glibc 2.39) runs. glibc only moves forward here, so volume-cached
# binaries built on the old base (esbuild, ripgrep/fd, native node modules)
# remain forward-compatible.
#
FROM mcr.microsoft.com/devcontainers/typescript-node:22-trixie

ARG USERNAME=node

# xz-utils is needed to extract the Rust release tarball (.tar.xz). curl and
# ca-certificates are normally present; install defensively. Done as root before
# dropping back to the unprivileged user. Non-fatal so a transient apt failure
# doesn't break the image build.
USER root
RUN apt-get update \
    && apt-get install -y --no-install-recommends xz-utils ca-certificates curl \
    && rm -rf /var/lib/apt/lists/* \
    || echo "WARN: apt step failed; Rust seed may be skipped below."

USER ${USERNAME}

# User-owned npm global prefix so `npm install -g` works without sudo.
ENV NPM_CONFIG_PREFIX=/home/${USERNAME}/.npm-global \
    PATH=/home/${USERNAME}/.npm-global/bin:${PATH}

RUN mkdir -p /home/${USERNAME}/.npm-global/bin /home/${USERNAME}/.local/bin

# Install the pnpm shim via corepack (the actual pnpm version is fetched lazily
# on first use, driven by the workspace's packageManager field — the workspace
# isn't mounted at build time, so we can't `corepack prepare --activate` here).
# --install-directory targets the user-writable npm prefix; without it corepack
# tries to symlink into /usr/local/bin and fails with EACCES under the node user.
# Also seed pi-coding-agent (the TypeScript runtime) so the extension finds it
# immediately.
RUN corepack enable --install-directory /home/${USERNAME}/.npm-global/bin && \
    npm install -g @earendil-works/pi-coding-agent@latest

# Seed the Rust runtime (`pi_agent_rust`) as `rust-pi` — deliberately NOT named
# `pi`, so it never shadows the TypeScript `pi` CLI that post-start.sh drives.
# The whole step is non-fatal: a network/checksum/arch issue logs a warning and
# the build still succeeds (the extension can install Rust on demand later).
RUN set -u; ( set -eux; \
      arch="$(dpkg --print-architecture)"; \
      case "$arch" in \
        amd64) rarch=amd64 ;; \
        arm64) rarch=arm64 ;; \
        *) echo "unsupported arch: $arch"; exit 1 ;; \
      esac; \
      tag="$(basename "$(curl -fsSL -o /dev/null -w '%{url_effective}' \
        https://github.com/Dicklesworthstone/pi_agent_rust/releases/latest)")"; \
      base="https://github.com/Dicklesworthstone/pi_agent_rust/releases/download/${tag}"; \
      asset="pi-linux-${rarch}.tar.xz"; \
      tmp="$(mktemp -d)"; cd "$tmp"; \
      curl -fsSL -o "$asset" "${base}/${asset}"; \
      curl -fsSL -o SHA256SUMS "${base}/SHA256SUMS"; \
      grep " ${asset}\$" SHA256SUMS | sha256sum -c -; \
      tar -xJf "$asset"; \
      binpath="$(find . -type f -name pi | head -1)"; \
      "$binpath" --version; \
      install -m 0755 "$binpath" "/home/${USERNAME}/.local/bin/rust-pi"; \
      cd /; rm -rf "$tmp"; \
    ) || echo "WARN: Rust Pi seed skipped (network/checksum/unsupported arch). Install it later via 'PiGui: Install Rust Pi'."

WORKDIR /workspaces
CMD ["sleep", "infinity"]
