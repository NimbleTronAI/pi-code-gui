# Project Protocol

> AGENTS.md is loaded by Pi at startup. It covers project-specific
> operating conventions. Behavioral rules (how to think, how to verify,
> how to research) live in `.pi/APPEND_SYSTEM.md`. Detailed protocols
> live in `agent-wiki/` — this file is the map, not the territory.

## Project overview

Pi Code Gui is a VS Code extension that embeds the Pi coding agent into VS Code's
native UI. It provides a webview-based chat panel, 17 bridge tools that give the
AI agent access to VS Code editor state (diagnostics, symbols, hover, definitions,
references, and workspace edits), a sidebar with session and package tree views,
multi-session tab support with per-session model/thinking settings, and session
persistence via Pi's standard `.jsonl` format.

Key concepts:
- **SessionWindow** (`src/extension.ts`) — paired PiService + PiWebviewPanel, one per chat tab
- **PiService** (`src/pi-service.ts`) — SDK lifecycle bridge, event translation, model/settings
- **PiWebviewPanel** (`src/webview-panel.ts`) — webview creation, bidirectional messaging, rendering
- **Bridge Tools** (`src/bridge-tools.ts`) — 17 VS Code API tools for the AI agent
- **Event Translation** (`src/pi-service.ts` handleAgentEvent) — SDK events → webview messages
- **Extension UI Bridge** (`src/pi-service.ts` bindExtensionUI) — TUI widgets → webview
- **Webview Frontend** (`media/`) — chat UI, morphdom streaming, marked rendering
- **Tree Views** (`src/extension.ts` MultiSessionTreeProvider, `src/pi-packages-tree-provider.ts`)
- **Runtime Selection** (`src/pi-service.ts` `_backendKind`; `src/rust-*.ts`; `src/runtime-detection.ts`) — per-session TypeScript (in-process SDK) or Rust (out-of-process `pi --mode rpc`) Pi; default TypeScript; see `agent-wiki/architecture/runtime-selection.md`

See `agent-wiki/index.md` for the full topic catalog.

## Development workflow

```bash
pnpm install          # Install dev dependencies
pnpm run compile      # Type-check (tsc --noEmit), lint (eslint src), build (esbuild)
pnpm run watch        # Watch mode — esbuild + tsc in parallel
pnpm run package      # Production build (type-check + lint + minified esbuild)
pnpm run check-types  # Type-check only
pnpm run lint         # ESLint only
pnpm test             # Run tests via vscode-test
```

**Local dev loop:** Run `pnpm run watch`, then press `F5` in VS Code to launch
the Extension Development Host with live rebuilds.

**Packaging:** `pnpm run vsix` creates `pi-code-gui-x.x.x.vsix`.
Install locally: `code --install-extension pi-code-gui-*.vsix --force`.

**CI/CD:** GitHub Actions (`publish.yml`) triggers on GitHub Release.
Publishes to VS Code Marketplace (`vsce publish`) and Open VSX (`ovsx publish`).
Requires the `marketplace` environment with reviewer gates.

## pi clean-room — license law

Do not read, fetch, paste, or reference the source of `pi_agent_rust` and its restricted
runtime deps `asupersync`, `franken-decision`, `franken-evidence`, `franken-kernel` into
any agent context — **by any channel**: the Read tool, Bash (`cat`/`grep`/`sed`/`git
show`/`git log -p` on a checkout), or WebFetch of the repo's source/blob/raw/commit
pages. That covers local clones (e.g. a `~/pi_agent_rust` checkout), the `~/.cargo`
checkout/registry copies, and fork diffs (a fork's diff of restricted source is a
derivative work — same rule). These crates ship under "MIT + OpenAI/Anthropic Rider":
the Software and derivatives may not be made available to a Restricted Party (OpenAI,
Anthropic, their affiliates/agents), and Claude Code is an Anthropic surface — content
read into it is provided to Anthropic.

Work black-box instead: drive `pi --mode rpc` and capture its stdout (wire probes are
the established pattern), read its version/`--help` output, read its GitHub *issues*
(prose), and keep our own API notes in `agent-wiki/`. Reading the binary's observable
behavior is fine; reading its source is not.

`github.com/earendil-works/pi` (plain MIT © 2025 Mario Zechner) is the ancestor
`pi_agent_rust` was ported from. It carries no rider and MAY be read and fetched freely
as a clean-room reference. If you port ancestor code verbatim, carry its LICENSE note in
the module header + a NOTICE entry.

Enforced, not just prose: `permissions.deny` Read()/WebFetch rules + a Bash PreToolUse
hook in `.claude/settings.json`, and `scripts/check-cleanroom.sh` (+ `-smoke.sh`) at
pre-commit (`.githooks/`), `pretest`, and `package`. Removing a deny rule fails the
commit.

## Tool discipline

Raw bash for dev-loop (build, test, lint). VS Code extension publishing is
handled by CI.

**File edits should use `vscode_apply_workspace_edit`** (via the edit/write
tools) to keep open editor buffers in sync with disk. Direct file writes
bypass VS Code's buffer tracking and cause dirty-state mismatches.

## Storage rules

**Durable (versioned in git):** `AGENTS.md`, `agent-wiki/`, source in `src/`,
`media/` assets, config files at repo root.

**Durable (on disk, not versioned):**
- Pi sessions: `.jsonl` files in `~/.pi/agent/sessions/` or custom
  `pi-code-gui.sessionDir`. Survive VS Code restarts. Appear in Past Sessions.
- Pi packages: installed to `.pi/npm/node_modules/` (project) or global npm.
  The `.pi/` directory is gitignored.
- API keys: Pi SDK's `AuthStorage` (system keychain via keytar) or runtime
  override from `pi-code-gui.anthropicApiKey` / `pi-code-gui.openaiApiKey`.
  Never written to disk as plaintext.
- Open session paths: `context.workspaceState` (VS Code workspace storage) —
  per-workspace, survives window reloads.

**Ephemeral:**
- Webview DOM — rebuilt on every panel creation
- Pi SDK loaded dynamically from npm global install — not bundled with extension
- `dist/` and `out/` — build output, gitignored
- Extension output channel — diagnostic logs, cleared on window reload

**Rules:**
1. AGENTS.md and the wiki are versioned in git — they survive container
   rebuilds and new machines.
2. Ephemeral agent files go in a per-session directory (gitignored,
   auto-cleaned).
3. API keys never leave the extension — they're in-memory runtime overrides
   or the system keychain, never written to project files.

## Wiki conventions

Project knowledge lives in `agent-wiki/` — interlinked topic pages, not
a monolith. Start at `agent-wiki/index.md` for the catalog.

**Finding information:** The wiki is organized by topic area. Add your
own categories as the project grows:
- `architecture/` — system design, decision flow, key abstractions
- `operations/` — build, deploy, CI/CD, release process
- `discipline/` — think-before-acting, TDD, strong-opinions, verify, research
- (add more as needed — patterns, domain-models, api, etc.)

### Wiki Maintenance

The project wiki at `agent-wiki/` is a living artifact maintained by the
agent following the LLM Wiki pattern (Karpathy, 2025 —
https://gist.github.com/karpathy/442a6bf555914893e9891c11519de94f). This applies to
all code changes.

#### When code changes a concept the wiki documents
- Update the relevant wiki page(s) before the change is committed
- Update the page's `> **Last updated:**` footer with the change reference
- Append an entry to `agent-wiki/log.md`: `## [YYYY-MM-DD] update | <summary>`
- If the concept is removed, move its page to `agent-wiki/archive/` and
  remove from index.md

#### When new concepts are introduced
- Create a new wiki page (200-500 words, self-contained, cross-referenced)
- Add the page to `agent-wiki/index.md` under the appropriate category
- Append to `agent-wiki/log.md`: `## [YYYY-MM-DD] ingest | <concept>`
- Mark as `> **Status:** evolving` until proven stable

#### Periodic lint (run during any review)
- Check for broken cross-reference links, pages with stale content,
  orphan pages with no inbound links, concepts in code with no wiki
  page. Fix issues or flag them for follow-up.
- Update page status: evolving → stable when the concept has survived
  at least one production deployment.

Read `agent-wiki/discipline/wiki-maintenance.md` for the full Karpathy
pattern, conventions, and lint recipes.

## Context continuity

Long sessions may span hours and multiple steps. Pi's compaction
summarizes old messages to free context space. When this happens,
you will see a `CompactionSummary` entry in the session.

After compaction:
1. **Re-read** `agent-wiki/index.md` — re-establish project anchors
2. **Re-query** current state from relevant sources
3. **Re-read** the current step's wiki page for instructions
4. **Surface** a brief recap to the founder:
   `"Compacted. Current state: [state]. Continuing."`

When in doubt, query — don't guess from memory.

## Never quiet prompt

Every agent turn ends with either:
- A short-input decision prompt (`y/n`, `1/2/3`, a pick-list number)
- A progress report naming the next concrete action

Never end a turn with "what would you like to do?" or "let me know when
you're ready." The founder should be able to respond with one or two
keystrokes when a decision is needed, or trust that work continues when
you name the next action.

## Quick reference

| Need | Go here |
|------|---------|
| Project architecture overview | `agent-wiki/index.md` |
| How sessions work | `agent-wiki/architecture/session-window.md` |
| How PiService bridges the SDK | `agent-wiki/architecture/pi-service.md` |
| How the webview chat panel works | `agent-wiki/architecture/webview-panel.md` |
| How bridge tools expose VS Code APIs | `agent-wiki/architecture/bridge-tools.md` |
| How SDK events become webview messages | `agent-wiki/architecture/event-translation.md` |
| How TUI extensions render in webview | `agent-wiki/architecture/extension-ui-bridge.md` |
| How the build pipeline works | `agent-wiki/operations/build-pipeline.md` |
| How the SDK is found and initialized | `agent-wiki/operations/sdk-resolution.md` |
| How to think before acting | `agent-wiki/discipline/think-before-acting.md` |
| How TDD works here | `agent-wiki/discipline/tdd.md` |
| How the wiki is maintained | `agent-wiki/discipline/wiki-maintenance.md` |
| Wiki change log | `agent-wiki/log.md` |
| Why rust-pi source is off-limits (license wall) | `AGENTS.md` §"pi clean-room" + `scripts/check-cleanroom.sh` |
