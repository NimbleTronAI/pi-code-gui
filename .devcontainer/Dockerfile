# syntax=docker/dockerfile:1.7
#
# Dev container for pi-vscode-gui — VS Code extension development.
# Based on Microsoft's TypeScript + Node devcontainer image.
#
# Uses the Debian 13 "trixie" variant. glibc only moves forward here, so
# volume-cached binaries built on an older base (esbuild, ripgrep/fd, native
# node modules) remain forward-compatible; do not move back to bookworm.
#
# Node 26 (the active LTS line since 2026-10), matching `node-version: '26'` in
# every workflow: keep the two in step, or local runs and CI test different Nodes.
#
# Pinned by DIGEST on the `26-trixie` tag. Microsoft rebuilds that tag under the
# same name, and Dependabot compares tag names, so a bare tag never produced an
# update PR (none from 2026-08-08 to 2026-11-24) while each rebuild silently took
# whatever the tag held that day. With the digest, Dependabot proposes each
# rebuild as a digest update (auto-merged; the dev container ships nothing, so no
# release follows). A versioned tag (5.2.7-24-trixie) was tried and does not work:
# Dependabot misread this image's <image>-<node>-trixie scheme and proposed the
# floating `5-26-trixie` (#118).
FROM mcr.microsoft.com/devcontainers/typescript-node:26-trixie@sha256:fa6520fb01b8971e78312715c39672e7299f6abdb040e4b444b42ea0b7cd44d9

ARG USERNAME=node

USER ${USERNAME}

# User-owned npm global prefix so `npm install -g` works without sudo.
ENV NPM_CONFIG_PREFIX=/home/${USERNAME}/.npm-global \
    PATH=/home/${USERNAME}/.npm-global/bin:${PATH}

RUN mkdir -p /home/${USERNAME}/.npm-global/bin /home/${USERNAME}/.local/bin

# Node 25+ no longer bundles corepack, so install it from npm first (into the
# user-writable prefix above), then install the pnpm shim via corepack. The
# actual pnpm version is fetched lazily on first use, driven by the workspace's
# packageManager field — the workspace isn't mounted at build time, so we can't
# `corepack prepare --activate` here.
# --install-directory targets the user-writable npm prefix; without it corepack
# tries to symlink into /usr/local/bin and fails with EACCES under the node user.
# Also seed pi-coding-agent so the extension finds it
# immediately.
RUN npm install -g corepack && \
    corepack enable --install-directory /home/${USERNAME}/.npm-global/bin && \
    npm install -g @earendil-works/pi-coding-agent@latest

WORKDIR /workspaces
CMD ["sleep", "infinity"]
