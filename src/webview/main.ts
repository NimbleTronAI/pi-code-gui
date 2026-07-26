// ── Pi on Code Webview Entry Point ─────────────────────────
//
// Initializes state, debug, rendering engine, tool renderers,
// event handlers, and the VS Code message bridge.
//
// Import order matters:
//   1. state.js    — shared mutable state
//   2. debug.js    — debug infrastructure
//   3. engine.js   — rendering functions (pure, no side effects)
//   4. tools.js    — registers tool renderers (side effect)
//   5. handlers.js — sets up message listener (side effect)

import { state, initState } from "./state.js";
import { initDebugObserver } from "./debug.js";
import {
  setupCodeBlockHandlers,
  updateStreamingState,
  scrollToBottom,
} from "./render/engine.js";
import { shouldLoadOlderHistory } from "./render/history-pagination.js";

// Side-effect imports (self-register on load)
import "./tools/index.js";
import "./handlers/index.js";

// ── Initialize ──────────────────────────────────────────────

// Acquire VS Code API and store globally (handlers need it)
const vscode = acquireVsCodeApi();
window.__vscode = vscode;

// Populate DOM refs (called automatically by state.js on import,
// but called again here for clarity and safety)
initState(document);

// Start MutationObserver for debug logging
initDebugObserver();

// Set up event delegation (code copy buttons, file path clicks)
setupCodeBlockHandlers();

// Set initial streaming state (show/hide buttons)
updateStreamingState();

// Populate the composer with the current visible-editor context.
vscode.postMessage({ type: "requestEditorContext" });

// ── Viewport recovery ────────────────────────────────────────
// VS Code retains this webview while its tab is hidden. Chromium can preserve
// the old, small compositor surface when the editor group is resized in the
// background, then repaint it only after a noticeable delay. Briefly promoting
// the app to a fresh layer forces an immediate full-viewport paint. A second
// pass covers the delayed viewport update seen after long background sleeps.
let viewportRecoveryGeneration = 0;

function recoverViewportLayout(): void {
  if (document.visibilityState === "hidden") { return; }

  const generation = ++viewportRecoveryGeneration;
  const root = document.documentElement;
  const restoreScroll = (): void => {
    if (state.hasScrolledUp) { return; }
    state.chatContainer.scrollTop = state.chatContainer.scrollHeight;
  };
  const repaint = (): void => {
    if (generation !== viewportRecoveryGeneration || document.visibilityState === "hidden") {
      return;
    }
    root.classList.remove("pi-viewport-recovering");
    void root.offsetWidth;
    root.classList.add("pi-viewport-recovering");
    void root.offsetWidth;
    requestAnimationFrame(() => {
      if (generation !== viewportRecoveryGeneration) { return; }
      root.classList.remove("pi-viewport-recovering");
      void root.offsetWidth;
      restoreScroll();
    });
  };

  repaint();
  window.setTimeout(repaint, 100);
}

window.addEventListener("pi-viewport-refresh", recoverViewportLayout);

// ── Scroll tracking ─────────────────────────────────────────
state.chatContainer.addEventListener("scroll", () => {
  const threshold = 50;
  const atBottom =
    state.chatContainer.scrollHeight -
      state.chatContainer.scrollTop -
      state.chatContainer.clientHeight <
    threshold;
  state.hasScrolledUp = !atBottom;

  if (shouldLoadOlderHistory({
    scrollTop: state.chatContainer.scrollTop,
    hasMore: state.historyHasMore,
    loading: state.historyLoading,
    streaming: state.isStreaming,
    inBatch: state._inBatch,
  })) {
    state.historyLoading = true;
    vscode.postMessage({ type: "loadOlderHistory" });
  }
});

document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") {
    recoverViewportLayout();
    if (!state.hasScrolledUp) {
      scrollToBottom();
    }
  }
});

window.addEventListener("pageshow", recoverViewportLayout);
