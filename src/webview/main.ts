// ── Pi Code Gui Webview Entry Point ─────────────────────────
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
import { shouldUnpinOnScroll } from "../shared/scroll.js";
import { initDebugObserver } from "./debug.js";
import {
  setupCodeBlockHandlers,
  updateStreamingState,
  scrollToBottom,
} from "./render/engine.js";

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

// ── Scroll tracking ─────────────────────────────────────────
// `hasScrolledUp` = "the user deliberately scrolled away from the bottom, so stop
// auto-following." It must NOT be flipped by the reflow/clamp scroll events the browser
// emits when tool blocks change height on completion — those carry no user gesture and
// would otherwise latch auto-follow off mid-turn (the pinned-to-bottom bug). So we only
// unpin when an off-bottom scroll coincides with a real gesture (active pointer drag, or
// a recent wheel/touch/key); returning to the bottom always re-arms auto-follow.
const AT_BOTTOM_THRESHOLD = 50;
let pointerDown = false;
let lastGestureAt = -Infinity;
const markGesture = (): void => { lastGestureAt = Date.now(); };
function atChatBottom(): boolean {
  const c = state.chatContainer;
  return c.scrollHeight - c.scrollTop - c.clientHeight < AT_BOTTOM_THRESHOLD;
}
state.chatContainer.addEventListener("wheel", markGesture, { passive: true });
state.chatContainer.addEventListener("touchstart", markGesture, { passive: true });
state.chatContainer.addEventListener("touchmove", markGesture, { passive: true });
state.chatContainer.addEventListener("keydown", markGesture);
state.chatContainer.addEventListener("mousedown", (): void => { pointerDown = true; markGesture(); });
window.addEventListener("mouseup", (): void => { pointerDown = false; });
state.chatContainer.addEventListener("scroll", (): void => {
  const atBottom = atChatBottom();
  if (atBottom) { state.hasScrolledUp = false; }                        // any return to bottom re-arms
  else if (shouldUnpinOnScroll(atBottom, pointerDown, Date.now() - lastGestureAt)) {
    state.hasScrolledUp = true;                                          // genuine user scroll-away
  }                                                                      // else: a reflow event — leave the pin as-is
});

document.addEventListener("visibilitychange", (): void => {
  if (document.visibilityState === "visible") {
    if (!state.hasScrolledUp) {
      scrollToBottom();
    }
  }
});
