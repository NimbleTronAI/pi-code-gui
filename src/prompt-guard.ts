// Guard against a fresh prompt preempting an in-flight agent turn.
//
// Observed 2026-07-06: a single user submit to a Rust session executed the turn, then
// ~108s later the SAME prompt was dispatched again as a mode-less `prompt`. Because a
// fresh Rust `prompt` anchors to the conversation ROOT, the second dispatch forked a new
// branch and orphaned the still-running first turn — which had already executed and been
// billed (a silent double-bill; the session panel shows only the surviving branch). The
// trigger is still under instrumentation, but the SYMPTOM is unambiguous and preventable:
// a mode-less conversational prompt arriving while a turn is active is never legitimate.
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
