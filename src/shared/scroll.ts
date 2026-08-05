// Pure decision for the chat auto-scroll ("pinned to bottom") behaviour.
//
// The bug this fixes: the chat container's `scroll` listener fires for MANY reasons,
// not just user scrolling — most importantly the reflow/clamp scroll events the browser
// emits when tool blocks change height as they complete (e.g. three read/write tools
// finishing at once). Treating every "not at bottom" scroll event as "the user scrolled
// away" latched auto-follow OFF mid-turn, and the session stopped sticking to the bottom.
//
// So auto-follow is only disengaged when the off-bottom scroll is attributable to a real
// USER gesture: an active pointer drag (scrollbar), or a wheel/touch/keyboard gesture
// within a short window. Reflow scroll events carry neither, so they can't unpin.
// Returning to the bottom always re-arms auto-follow and is handled by the caller.
export function shouldUnpinOnScroll(
  atBottom: boolean,
  pointerDown: boolean,
  msSinceGesture: number,
  gestureWindowMs = 250,
): boolean {
  if (atBottom) { return false; }
  return pointerDown || msSinceGesture < gestureWindowMs;
}
