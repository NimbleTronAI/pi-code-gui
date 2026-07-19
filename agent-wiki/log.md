# Wiki Log

Append-only chronological record of all wiki operations. Every entry
starts with `## [YYYY-MM-DD] <action> | <description>`. Actions:
`ingest` (new page), `update` (existing page changed), `lint` (quality
pass performed), `archive` (page moved to archive).

## [2026-07-19] update | PiService and Bridge Tools — delegated session persistence to SessionManager APIs to prevent headerless files and first-response EEXIST failures

## [2026-05-27] lint | Full wiki + README audit — bridge-tools (16 tools, not 17; dedup table row), syntax-highlighting (15 languages, +yaml/sql/diff), tree-views (progressive load, entry caching, state-change refresh), event-translation (turn-end, message_update error, user message_end), streaming-pipeline (progressive replay), README (16 tools)
## [2026-05-26] update | Bridge Tools, PiService — added `/tools` runtime picker with persistence, replaced static `pi-code-gui.tools` allowlist
## [2026-05-25] archive | Architecture — Multi-Backend Architecture → `archive/multi-backend.md` (rejected: incompatible extension/UI model)
## [2026-05-25] ingest | Architecture — Multi-Backend Architecture (`architecture/multi-backend.md`)
## [2026-05-19] update | Webview Frontend — Steps 6-7 complete (interactive dialogs, persistent status bar); Component System Proposal all 7 steps done
## [2026-05-19] update | Webview Frontend — Layer 3 micro components (CodeBlock, ThinkingBlock, LiveCard, InlineCard, ToolBlock); Component System Proposal Layers 1-3 complete
## [2026-05-19] update | Webview Frontend — Layer 2 safe HTML tagged template; Component System Proposal Layers 1+2 marked complete
## [2026-05-19] update | Webview Frontend — Layer 1 Zod runtime protocol validation; Component System Proposal Layer 1 marked complete
## [2026-05-19] ingest | Architecture — Syntax Highlighting (`architecture/syntax-highlighting.md`)
## [2026-05-19] ingest | Architecture — Custom Message Renderer (`architecture/custom-message-renderer.md`)
## [2026-05-19] ingest | Architecture — Tool Block Rendering (`architecture/tool-block-rendering.md`)
## [2026-05-19] ingest | Architecture — Streaming Pipeline (`architecture/streaming-pipeline.md`)
## [2026-05-19] ingest | Roadmap — Component System Proposal (`architecture/component-system-proposal.md`)
## [2026-05-19] update | Webview Frontend — added highlight.js, streaming pipeline, component proposal cross-refs
## [2026-05-19] update | Extension UI Bridge — added custom message renderer bridge, HTML support in setStatus, globalThis injection
## [2026-05-19] update | Event Translation — added custom message display/details fields, diagnostic default case
## [2026-05-19] update | Index — added Syntax Highlighting, Tool Block Rendering, Streaming Pipeline, Custom Message Renderer, Roadmap category
## [2026-05-16] archive | Webview Rewrite Plan moved to archive/ (all 5 steps completed)
## [2026-05-16] stale | Removed WEBVIEW_REWRITE_TODO.md (tracking complete)
## [2026-05-16] lint | Fixed all 65 ESLint warnings in src/webview — 0 warnings remain
## [2026-05-16] update | Webview Panel + Frontend — CSS extracted to media/style.css, @layer organization, native nesting
## [2026-05-16] update | Webview Panel — updated for single-bundle loading via esbuild, typed postMessage bridge
## [2026-05-16] update | Webview Rewrite Plan — marked all 5 steps complete, final architecture documented
## [2026-05-16] stale | Removed media/app.js, media/core.js, media/tools.js (migrated to src/webview/)
## [2026-05-16] ingest | Webview Rewrite Plan — 5-step modularization + TS migration, TODO tracking file
## [2026-05-15] ingest | Bootstrap — wiki structure initialized from Pi template (discipline pages, index, log, archive)
## [2026-05-15] ingest | Architecture — Session Window (`architecture/session-window.md`)
## [2026-05-15] ingest | Architecture — PiService (`architecture/pi-service.md`)
## [2026-05-15] update | PiService — added pickModel/pickThinkingLevel, de-duplicated pickers from extension.ts and webview-panel.ts, added model pricing display
## [2026-05-15] ingest | Architecture — Webview Panel (`architecture/webview-panel.md`)
## [2026-05-15] ingest | Architecture — Bridge Tools (`architecture/bridge-tools.md`)
## [2026-05-15] ingest | Architecture — Event Translation (`architecture/event-translation.md`)
## [2026-05-15] ingest | Architecture — Extension UI Bridge (`architecture/extension-ui-bridge.md`)
## [2026-05-15] ingest | Architecture — Webview Frontend (`architecture/webview-frontend.md`)
## [2026-05-15] ingest | Architecture — Tree Views (`architecture/tree-views.md`)
## [2026-05-15] ingest | Operations — SDK Resolution & Init (`operations/sdk-resolution.md`)
## [2026-05-15] ingest | Operations — Build Pipeline (`operations/build-pipeline.md`)
## [2026-05-15] update | AGENTS.md bootstrap — filled project overview, dev workflow, tool discipline, storage rules, quick reference
## [2026-05-15] update | TDD discipline — filled project test conventions (locations, commands, preflight)
