export interface ScrollViewport {
  scrollTop: number;
  readonly scrollHeight: number;
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
