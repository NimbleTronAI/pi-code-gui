export interface ScrollViewport {
  scrollTop: number;
  readonly scrollHeight: number;
}

export interface FollowScrollUpdate {
  wasLocked: boolean;
  isAtBottom: boolean;
  hasUserIntent: boolean;
}

/**
 * Only explicit user scroll intent may lock following. Programmatic scroll
 * events can temporarily report a non-bottom position while content grows.
 */
export function nextFollowScrollLock(update: FollowScrollUpdate): boolean {
  if (update.isAtBottom) { return false; }
  return update.wasLocked || update.hasUserIntent;
}

type ScheduleFrame = (callback: () => void) => void;

export function scheduleFollowScroll(
  viewport: ScrollViewport,
  shouldFollow: () => boolean,
  scheduleFrame: ScheduleFrame = (callback) => { requestAnimationFrame(callback); },
): void {
  if (!shouldFollow()) { return; }
  scheduleFrame(() => {
    if (shouldFollow()) {
      viewport.scrollTop = viewport.scrollHeight;
    }
  });
}
