export const PI_TUI_SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"] as const;

export function shouldShowPromptWaitingIndicator(isStreaming: boolean, prompt: string): boolean {
  // Slash commands may be handled entirely by PiService (for example /name)
  // and therefore never emit agent-start/agent-end. Let commands that do
  // start the agent show the indicator through the normal agent-start event.
  return !isStreaming && !prompt.trimStart().startsWith("/");
}

export function shouldShowFollowUpHint(isWorking: boolean, input: string): boolean {
  return isWorking && input.trim().length > 0;
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
