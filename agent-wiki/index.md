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
- [Agent Coordination](discipline/agent-coordination.md) — the coordinator/member protocol: briefs, contracts notes, worktrees, review-in-the-loop, token discipline, landing
- [Documentation Discipline](discipline/documentation-discipline.md) — CHANGELOG is user-facing only; why entries regrow and how to cut them back

## Architecture

- [Session Window](architecture/session-window.md) — Paired PiService+WebviewPanel, multi-session, restore across reloads
- [PiService](architecture/pi-service.md) — the orchestrator over the in-process SDK: lifecycle, pickers, slash routing, and what was extracted out of it
- [PiBackend](architecture/pi-backend.md) — the SDK seam: the primitive interface `SdkService` implements, and where the seam still leaks
- [Pure Core Modules](architecture/pure-core-modules.md) — the extract-the-decision pattern, and an index of all ~27 pure modules
- [Model Catalog & the Shared Agent Home](architecture/model-catalog.md) — the bundled catalog and what reads it, the startup cleanup of entries earlier versions wrote into `models.json`, and why the agent home is shared
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


- [Batch 0.2.8 — status and next steps](operations/batch-0.2.8-status.md) — handover: what the branch holds, the Rust removal decision, and the ordered next steps
- [Open items](operations/open-items.md) — known gaps recorded and left unfixed (catalog generator, currency gate, custom-message validation)
- [Pi 1.5.2 findings](operations/pi-1.5.2-findings.md) — what 1.4.0 → 1.5.2 changed for us, and the live run of the extension on 1.5.2
- [Rust removal plan](operations/rust-removal-plan.md) — the 0.2.8 plan: units U1–U5, open decisions, acceptance; targets pi 1.5.2
- [SDK Resolution & Init](operations/sdk-resolution.md) — how the globally installed Pi SDK is found and loaded in-process
- [Build Pipeline](operations/build-pipeline.md) — esbuild, tsc, ESLint, VSIX packaging, CI publish
- [Logging](operations/logging.md) — single logger → "Pi Code Gui" Output channel; `piDebug`/`piLog`/`piWarn` levels; no console writes
- [Error Surfacing](operations/error-surfacing.md) — `extension-errors.ts` classifiers turn provider-key failures and early-stopped turns into clear in-chat diagnostics
- [Debugging a session](operations/runtime-debugging.md) — diagnostic checklist (Output channel, SDK install, session files, API keys)

## Meta

- [Wiki Log](log.md) — Append-only chronological record of all wiki operations

## Cross-reference

- `AGENTS.md` — Project protocol: workflow, tool discipline, storage rules
- `.pi/APPEND_SYSTEM.md` — The 5 golden rules (system-level, non-negotiable)

> **Last updated:** 2026-11-12 — Second runtime removed (0.2.8): dropped the runtime-selection, runtime-switching-ux and session-modes pages; added open-items.
> **Earlier:** 2026-08-05 — added PiBackend and Pure Core Modules; corrected the
> PiService description (it is the orchestrator, not the SDK bridge) and the init-sequence
> ownership.
