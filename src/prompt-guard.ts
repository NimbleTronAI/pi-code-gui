// Guard against a fresh prompt preempting an in-flight agent turn.
//
// Observed 2026-07-06 on the since-retired second runtime, where a fresh `prompt` anchored to
// the conversation ROOT: a single user submit executed the turn, then ~108s later the SAME
// prompt was dispatched again as a mode-less `prompt`. The second dispatch forked a new branch
// and orphaned the still-running first turn — which had already executed and been billed (a
// silent double-bill; the session panel shows only the surviving branch). The trigger was never
// pinned down, but the guard stays on the SDK: a mode-less conversational prompt arriving while
// a turn is active is never legitimate, whatever the backend does with it.
//
// A genuine mid-stream follow-up always carries mode "steer" or "queue" (the webview sets
// it from its own streaming state). A mode-less prompt while `agentRunActive` means the
// sender wrongly believed the agent was idle — a stale / duplicate / cross-panel dispatch.
// Slash commands (text starting with "/") are exempt: they're intercepted/handled
// separately and may legitimately run against an active session.
export function shouldDropPreemptingPrompt(
  mode: string | undefined,
  agentRunActive: boolean,
  text: string,
): boolean {
  return !mode && agentRunActive && !text.startsWith("/");
}
