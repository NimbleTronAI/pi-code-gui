# Wiki Index

Project knowledge, organized by topic area. Each page is a self-contained
reference; follow the links for depth.

## Discipline

- [Think Before Acting](discipline/think-before-acting.md) — Full protocol, trusted turns, when to skip, anti-patterns
- [TDD](discipline/tdd.md) — Red-Green-Refactor, project test conventions, when to stop and ask
- [Strong Opinions, Loosely Held](discipline/strong-opinions-loosely-held.md) — Challenge founder, challenge self, know when to stop
- [Verify, Don't Assume](discipline/verify-dont-assume.md) — Verification patterns, error handling conventions, failure modes
- [Research, Don't Guess](discipline/research-dont-guess.md) — Research patterns, uncertainty labeling, when to stop
- [Wiki Maintenance](discipline/wiki-maintenance.md) — Karpathy LLM Wiki pattern: ingest, update, lint; page conventions; log.md format

## Architecture

- [Session Window](architecture/session-window.md) — Paired PiService+WebviewPanel, multi-session, restore across reloads
- [PiService](architecture/pi-service.md) — SDK lifecycle bridge, dynamic import, event translation, model/settings
- [Runtime Selection](architecture/runtime-selection.md) — TypeScript vs Rust runtimes, `backendKind` branching, RPC, install/detection
- [Runtime Switching UX](architecture/runtime-switching-ux.md) — per-session runtime pickers, switch command, indicators, install dialogs
- [Webview Panel](architecture/webview-panel.md) — Webview creation, bidirectional messaging, tab indicators
- [Bridge Tools](architecture/bridge-tools.md) — 16 VS Code API tools for the AI agent
- [Event Translation](architecture/event-translation.md) — SDK agent events → PiServiceEvent types
- [Extension UI Bridge](architecture/extension-ui-bridge.md) — TUI widgets → webview via Proxy
- [Syntax Highlighting](architecture/syntax-highlighting.md) — highlight.js integration replacing hand-rolled regex
- [Tool Block Rendering](architecture/tool-block-rendering.md) — Write/edit/read/bash tool renderers and scroll-view pattern
- [Streaming Pipeline](architecture/streaming-pipeline.md) — RAF-batched rendering, token-diff patching, morphdom
- [Custom Message Renderer](architecture/custom-message-renderer.md) — Inline interactive cards, renderer registry, action buttons
- [Webview Frontend](architecture/webview-frontend.md) — Chat UI, streaming, TypeScript modules, typed protocol
- [Tree Views](architecture/tree-views.md) — Sessions and Packages sidebar trees
- [Component System Proposal](architecture/component-system-proposal.md) — 3-layer architecture (typed protocol, safe HTML builder, micro-component system) — all 7 steps shipped; kept as the design record

## Operations

- [SDK Resolution & Init](operations/sdk-resolution.md) — Finding Pi SDK on disk, the 11-step init sequence
- [Build Pipeline](operations/build-pipeline.md) — esbuild, tsc, ESLint, VSIX packaging, CI publish
- [Logging](operations/logging.md) — single logger → "Pi Code Gui" Output channel; `piDebug`/`piLog`/`piWarn` levels; no console writes

## Meta

- [Wiki Log](log.md) — Append-only chronological record of all wiki operations

## Cross-reference

- `AGENTS.md` — Project protocol: workflow, tool discipline, storage rules
- `.pi/APPEND_SYSTEM.md` — The 5 golden rules (system-level, non-negotiable)
