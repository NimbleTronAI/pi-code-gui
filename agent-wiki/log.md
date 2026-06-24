# Wiki Log

Append-only chronological record of all wiki operations. Every entry
starts with `## [YYYY-MM-DD] <action> | <description>`. Actions:
`ingest` (new page), `update` (existing page changed), `lint` (quality
pass performed), `archive` (page moved to archive).

## [2026-06-24] lint | Phase-0 drift sweep — tdd.md (82 headless `node:test` unit tests via `pnpm run test:unit`, extract-then-test pattern; killed "single skeleton test"); runtime-selection.md (`RustService.handleEvent`→`normalizeRustEvent`/`routeRustEvent`→`RustHost.handleAgentEvent`; added `src/rust-service.ts`+`src/rust-events.ts` to file inventory); streaming-pipeline.md (200ms `TOOL_PREVIEW_THROTTLE_MS` tool-arg throttle, commit 8322a4d); webview-frontend.md (38 events/17 commands; removed false "webview→extension is Zod-validated" claim — inbound `validateWebviewToExtension` is unwired); tree-views.md (banner images non-functional, Rust "Update All" false-positive); session-window.md (single restore loop in `activate()`, no `restoreAdditionalSessions()`/`continueRecent`); index.md + bootstrap/AGENTS.md (16 bridge tools, not 17; moved Component System Proposal out of Roadmap)
## [2026-06-05] update | Tree Views + Runtime Selection — runtime-aware Packages view: shared catalog, focus-driven available-vs-active (`computeActiveSources`/`setFocusedRuntime`), Rust binary backend (`src/rust-packages.ts`: list/install/remove/update/info/doctor), install-time Rust-compat warning, provenance/safety signals
## [2026-06-05] update | Runtime Selection — interop caveat resolved: `--no-extensions` + `pi-code-gui.rustExtensions` setting (auto/enabled/disabled), `shouldDisableRustExtensions`/`workspaceHasTsPiExtensions`/`isRustExtensionConflict`, spawn-retry self-heal + actionable conflict dialog
## [2026-06-05] ingest | Architecture — Runtime Selection (`architecture/runtime-selection.md`): TypeScript + Rust runtimes, `backendKind` internal branching, RPC plumbing, detection/install, documented Rust limitations
## [2026-06-05] ingest | Architecture — Runtime Switching UX (`architecture/runtime-switching-ux.md`): commands, persisted default, status chip + tree badges, setContext gating, resume-follows-origin, mixed-runtime tabs
## [2026-06-05] update | Archive — `archive/multi-backend.md` marked superseded (2025 rejection reversed; dual-runtime shipped in v0.0.56 with markdown-fallback for custom cards)
## [2026-06-05] update | Index — added Runtime Selection + Runtime Switching UX under Architecture
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
