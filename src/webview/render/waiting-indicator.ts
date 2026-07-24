export const PI_TUI_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export function shouldShowPromptWaitingIndicator(isStreaming: boolean): boolean {
  return !isStreaming;
}

export function nextWaitingFrame(frame: number): number {
  return (frame + 1) % PI_TUI_SPINNER_FRAMES.length;
}

export function shouldPlaceWaitingIndicatorAfterMessage(role: string): boolean {
  return role === "user";
}

export function shouldKeepWaitingIndicator(eventType: string): boolean {
  return eventType !== "agent-end" && eventType !== "error";
}
