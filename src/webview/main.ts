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
import { nextFollowScrollLock } from "./render/scroll-lock.js";
import { ConversationMinimap } from "./components/conversation-minimap.js";

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

const conversationMinimap = new ConversationMinimap(state.chatContainer, {
  onNavigate: () => {
    state.hasScrolledUp = true;
  },
  onLoadTurn: (entryId) => {
    vscode.postMessage({ type: "loadHistoryToEntry", entryId });
  },
});
conversationMinimap.mount(document.body);

// Set up event delegation (code copy buttons, file path clicks)
setupCodeBlockHandlers();

// Set initial streaming state (show/hide buttons)
updateStreamingState();

// Tell the extension host that the message listener is active before it
// replays any cached Session history into this Webview.
vscode.postMessage({ type: "webviewReady" });

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
// A scroll event alone does not prove user intent: DOM growth can make a
// delayed programmatic scroll event appear to be away from the new bottom.
let hasUserScrollIntent = false;
let userScrollIntentTimer: number | null = null;
let scrollbarPointerActive = false;
let previousTouchY: number | null = null;

function clearUserScrollIntent(): void {
  hasUserScrollIntent = false;
  if (userScrollIntentTimer !== null) {
    window.clearTimeout(userScrollIntentTimer);
    userScrollIntentTimer = null;
  }
}

function markUserScrollIntent(): void {
  hasUserScrollIntent = true;
  if (userScrollIntentTimer !== null) {
    window.clearTimeout(userScrollIntentTimer);
  }
  userScrollIntentTimer = window.setTimeout(clearUserScrollIntent, 300);
}

state.chatContainer.addEventListener("wheel", (event) => {
  if (event.deltaY < 0) { markUserScrollIntent(); }
}, { passive: true });

state.chatContainer.addEventListener("pointerdown", (event) => {
  const bounds = state.chatContainer.getBoundingClientRect();
  const scrollbarWidth = Math.max(
    12,
    state.chatContainer.offsetWidth - state.chatContainer.clientWidth,
  );
  if (event.button === 1 || event.clientX >= bounds.right - scrollbarWidth) {
    scrollbarPointerActive = true;
    markUserScrollIntent();
  }
});

state.chatContainer.addEventListener("pointermove", () => {
  if (scrollbarPointerActive) { markUserScrollIntent(); }
});
document.addEventListener("pointerup", () => {
  scrollbarPointerActive = false;
});
document.addEventListener("pointercancel", () => {
  scrollbarPointerActive = false;
});
window.addEventListener("blur", () => {
  scrollbarPointerActive = false;
  clearUserScrollIntent();
});

state.chatContainer.addEventListener("touchstart", (event) => {
  previousTouchY = event.touches[0]?.clientY ?? null;
}, { passive: true });
state.chatContainer.addEventListener("touchmove", (event) => {
  const currentTouchY = event.touches[0]?.clientY;
  if (currentTouchY !== undefined && previousTouchY !== null && currentTouchY > previousTouchY) {
    markUserScrollIntent();
  }
  previousTouchY = currentTouchY ?? null;
}, { passive: true });
state.chatContainer.addEventListener("touchend", () => {
  previousTouchY = null;
}, { passive: true });
state.chatContainer.addEventListener("touchcancel", () => {
  previousTouchY = null;
}, { passive: true });

// Keyboard events scroll the conversation only when focus is outside an editor.
document.addEventListener("keydown", (event) => {
  const target = event.target;
  if (target instanceof HTMLElement && (
    target.isContentEditable || target.matches("input, textarea, select")
  )) {
    return;
  }
  if (
    event.key === "ArrowUp" || event.key === "PageUp" || event.key === "Home" ||
    (event.key === " " && event.shiftKey)
  ) {
    markUserScrollIntent();
  }
});

state.chatContainer.addEventListener("scroll", () => {
  const threshold = 50;
  const atBottom =
    state.chatContainer.scrollHeight -
      state.chatContainer.scrollTop -
      state.chatContainer.clientHeight <
    threshold;
  state.hasScrolledUp = nextFollowScrollLock({
    wasLocked: state.hasScrolledUp,
    isAtBottom: atBottom,
    hasUserIntent: hasUserScrollIntent || scrollbarPointerActive,
  });
  if (atBottom) { clearUserScrollIntent(); }

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
