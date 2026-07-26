export interface SessionRevealOptions {
  restoringPreviouslyOpenSession: boolean;
  autoOpenNewSession: boolean;
}

/** Previously open tabs are restored; opening an otherwise new tab remains opt-in. */
export function shouldRevealSessionPanel(options: SessionRevealOptions): boolean {
  return options.restoringPreviouslyOpenSession || options.autoOpenNewSession;
}
